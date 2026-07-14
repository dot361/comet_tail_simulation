"""
Headless-ish driver that produces a GPU density cube from the web simulator —
the validation-grade export that reads back the ACTUAL WebGPU particle buffer
(see src/simulation/ExportDensityGpuAccum.js), so the cube reflects what the
browser model really computes (leapfrog integration of the live emission model),
not a reimplementation of COMTAILS.

How it works (high statistics at a FIXED epoch, no temporal blurring):
  for each rebuild:
      window.headlessPropagate(obsJD)   # builds an INDEPENDENT steady-state
                                        # tail at obsJD (emission RNG unseeded)
      window.gpuDensitySnapshot(...)    # reads back + bins that realization
  accumulate the snapshots in numpy, average, write rho_num.npy + meta.json.

IMPORTANT: this needs REAL WebGPU. The swiftshader software path has no WebGPU,
so this launches a real (headed) browser by default. Pass --headless to attempt
headless WebGPU (works
only on setups where Chromium can find a Vulkan/Dawn adapter).

Run once:  pip install playwright numpy ; python -m playwright install chromium

Output goes to ./_gpu_downloads as
  gpu_density_cube_JD<obs>_<gridN>_rho_num.npy  +  _meta.json
which analyze_density.py / visualize_density_comparison.py read directly.
"""
import argparse
import asyncio
import json
from pathlib import Path

import numpy as np
from playwright.async_api import async_playwright

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--obs-jd", type=float, default=2457248.5, help="observation epoch (default: 67P 2015 perihelion run_V)")
ap.add_argument("--rebuilds", type=int, default=12, help="independent tail rebuilds to accumulate (more = less shot noise)")
ap.add_argument("--gridn", type=int, default=64, help="cube resolution N^3")
ap.add_argument("--prefill-dt", type=float, default=0.05, help="days/step for the tail prefill (smaller avoids HARD_CAP clipping)")
ap.add_argument("--comet", default="67P")
ap.add_argument("--headless", action="store_true", help="attempt headless WebGPU (default is headed = reliable)")
ap.add_argument("--stage-timeout", type=float, default=600.0,
                help="maximum seconds for one tail rebuild or GPU snapshot (default: 600)")
# live-sim emission parameters (drive createTailParticle via the UI inputs)
ap.add_argument("--particle-count", default="80000", help="particles/sim-day at 1 AU (fills toward the 4e6 GPU cap over the lifetime)")
ap.add_argument("--lifetime", default="50", help="grain lifetime [days] = prefill window")
ap.add_argument("--v0-mps", default="800", help="ejection speed V0 [m/s] (0.8 km/s)")
ap.add_argument("--gamma", default="0.1", help="V0 * beta^gamma")
ap.add_argument("--kappa", default="-0.5", help="V0 * rh^kappa")
ap.add_argument("--expcos", default="0.0",
                help="sunward-hemisphere angular exponent. Validation default 0 gives a uniform hemisphere "
                     "with angle-independent speed, exactly matching COMTAILS mode 2 with expocos=0")
ap.add_argument("--activity-profile", choices=("comtails", "native"), default="comtails",
                help="release-time weighting: matched COMTAILS log10(dM/dt) table (default), "
                     "or the simulator's native heliocentric activity law")
ap.add_argument("--size-power", type=float, default=None,
                help="CONTROLLED run: match the emitted grain-size law dn/da ~ a^power "
                     "(e.g. -3.9) by shaping the beta curve to beta^(-power-2). Off = blind (UI curve).")
ap.add_argument("--rmin", type=float, default=1e-7, help="COMTAILS r_min [m]; sets beta_max = 1.191e-3*Qpr/(2*rho*rmin) (controlled runs)")
ap.add_argument("--rho-grain", type=float, default=3000.0, help="grain density [kg/m^3] for the beta_max conversion")
ap.add_argument("--qpr", type=float, default=1.0, help="radiation-pressure efficiency Q_pr for the beta_max conversion")
# grid bounds [km] — default matches the COMTAILS run_V_67p_iso_peri cube edges
ap.add_argument("--nbound", type=float, default=948316.4694308622, help="n & m half-extent [km]")
ap.add_argument("--lbound", type=float, default=1422474.7041462935, help="l half-extent [km]")
ap.add_argument("--no-split-half", dest="split_half", action="store_false",
                help="skip the two half cubes (even/odd rebuilds) used for the self-agreement noise floor")
ap.add_argument("--no-save-rebuilds", dest="save_rebuilds", action="store_false",
                help="skip saving the per-rebuild count stack used by 'analyze_density.py converge' (saves ~N*gridN^3*4 bytes)")
ap.set_defaults(split_half=True, save_rebuilds=True)
args = ap.parse_args()


# index.html lives at the repo root; this script is at validation/density/.
INDEX = (Path(__file__).resolve().parents[2] / "index.html").as_uri()
OUT_DIR = Path(__file__).parent / "_gpu_downloads"
OUT_DIR.mkdir(exist_ok=True)

WEBGPU_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan"]

BOUNDS = dict(
    nmin=-args.nbound, nmax=args.nbound,
    mmin=-args.nbound, mmax=args.nbound,
    lmin=-args.lbound, lmax=args.lbound,
)

EMISSION_FIELDS = {
    "#particleCountInput": args.particle_count,
    "#particleLifetimeInput": args.lifetime,
    "#ejectionSpeedInput": args.v0_mps,
    "#ejectionGammaInput": args.gamma,
    "#ejectionKappaInput": args.kappa,
    "#ejectionExpcosInput": args.expcos,
}

# Shared by all three COMTAILS reference cases (only r_min differs). Values are
# log10(dM/dt) and are linearly interpolated in log space by both codes.
COMTAILS_ACTIVITY_DAYS = [-300, -250, -200, -150, -100, -50, 0, 50, 100, 150, 200, 250, 300]
COMTAILS_ACTIVITY_LOG10 = [1.0, 1.5, 2.0, 2.5, 3.0, 3.0, 3.6, 3.0, 3.0, 2.5, 2.0, 1.5, 1.0]


async def main():
    async with async_playwright() as p:
        print(f"Launching Chromium (headless={args.headless})...", flush=True)
        browser = await p.chromium.launch(headless=args.headless, args=WEBGPU_ARGS)
        page = await browser.new_page()
        page.set_default_timeout(60000)
        page.on("console", lambda m: print(f"[console.{m.type}] {m.text}") if ("GpuAccum" in m.text or "rror" in m.text) else None)
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        print(f"Loading {INDEX} (including Babylon.js CDN assets)...", flush=True)
        await page.goto(INDEX, wait_until="load", timeout=120000)
        print("Page loaded; starting simulation...", flush=True)
        await page.click("#startBtn")

        # Wait for the WebGPU particle path to come up.
        try:
            await page.wait_for_function(
                "() => (typeof rawParticles !== 'undefined') && !!rawParticles",
                timeout=30000,
            )
        except Exception:
            await browser.close()
            raise RuntimeError(
                "WebGPU particle path never initialised (rawParticles is null). "
                "Run without --headless or on a Chromium setup with a WebGPU adapter."
            )
        print("WebGPU particle path initialized.", flush=True)

        # Open every collapsible UI group first — inputs inside a closed
        # <details> are not visible, so page.fill() would hang waiting for them.
        await page.evaluate("() => document.querySelectorAll('details').forEach(d => { d.open = true; })")

        # Configure comet + live emission model, push values into the sim globals.
        await page.evaluate("(id) => window.loadComet && window.loadComet(id)", args.comet)
        await page.wait_for_timeout(500)
        for sel, val in EMISSION_FIELDS.items():
            try:
                await page.fill(sel, val)
            except Exception:
                print(f"  (input {sel} not found — skipping)")
        await page.evaluate("() => (typeof updateOrbitParameters === 'function') && updateOrbitParameters()")

        if args.activity_profile == "comtails":
            await page.evaluate(
                "([days, logs]) => window.setValidationEmissionLogProfile(days, logs)",
                [COMTAILS_ACTIVITY_DAYS, COMTAILS_ACTIVITY_LOG10],
            )
            print("  activity history matched to the COMTAILS log10(dM/dt) table", flush=True)
        else:
            await page.evaluate("() => window.clearValidationEmissionProfile()")
            print("  activity history uses the simulator-native law", flush=True)

        # CONTROLLED run: shape the beta curve to a grain-size power law so the
        # emitted beta distribution matches COMTAILS' (dn/da ∝ a^power). Off by
        # default (blind run uses the UI curve).
        if args.size_power is not None:
            beta_max = 1.191e-3 * args.qpr / (2.0 * args.rho_grain * args.rmin)
            info = await page.evaluate(
                "([p, bmax]) => window.setBetaCurveSizePower(p, bmax)", [args.size_power, beta_max])
            capped = " (CAPPED at 1; COMTAILS beta>1 grains not represented)" if beta_max > 1 else " (fully within beta<=1)"
            print(f"  beta curve matched to size-power {args.size_power} -> beta^{info['betaExponent']:.2f}, "
                  f"beta_max(rmin={args.rmin:g} m) = {beta_max:.3f}{capped}")

        # Freeze the timeline so rebuilds/snapshots all sit at exactly obsJD.
        await page.evaluate("() => { isPaused = true; }")

        gridN = args.gridn
        accum = np.zeros(gridN ** 3, dtype=np.float64)
        total_hits = 0
        # Two independent sub-accumulators (even/odd rebuilds) for the
        # self-agreement noise floor — sim-vs-sim sets the ceiling the metric
        # can reach at this particle count, so the sim-vs-COMTAILS score can be
        # read against it (see 'analyze_density.py self').
        accum_A = np.zeros(gridN ** 3, dtype=np.float64)
        accum_B = np.zeros(gridN ** 3, dtype=np.float64)
        hits_A = hits_B = 0
        rebuilds_A = rebuilds_B = 0
        # Per-rebuild count stack — lets 'analyze_density.py converge' rebuild the cube from
        # any number of rebuilds after the fact, to show the metric plateauing.
        rebuild_stack = np.zeros((args.rebuilds, gridN ** 3), dtype=np.float32) if args.save_rebuilds else None

        for k in range(args.rebuilds):
            # Build an independent realization of the tail at the observation epoch.
            print(f"  rebuild {k+1}/{args.rebuilds}: propagating tail...", flush=True)
            await asyncio.wait_for(
                page.evaluate(
                    "([jd, dt]) => window.headlessPropagate(jd, { dtDays: dt })",
                    [args.obs_jd, args.prefill_dt],
                ),
                timeout=args.stage_timeout,
            )
            print(f"  rebuild {k+1}/{args.rebuilds}: reading and binning GPU buffer...", flush=True)
            snap = await asyncio.wait_for(
                page.evaluate(
                    "(opts) => window.gpuDensitySnapshot(opts)",
                    {"gridN": gridN, **BOUNDS},
                ),
                timeout=args.stage_timeout,
            )
            counts = np.asarray(snap["counts"], dtype=np.float64)
            accum += counts
            total_hits += snap["hits"]
            # Split by rebuild parity — both halves are statistically identical
            # realizations of the same fixed-epoch tail.
            if k % 2 == 0:
                accum_A += counts; hits_A += snap["hits"]; rebuilds_A += 1
            else:
                accum_B += counts; hits_B += snap["hits"]; rebuilds_B += 1
            if rebuild_stack is not None:
                rebuild_stack[k] = counts
            print(f"  rebuild {k+1}/{args.rebuilds}: {snap['hits']:,} particles binned "
                  f"(JD {snap['jd']:.3f})", flush=True)

        await browser.close()

    # Average per rebuild, convert to per-volume relative number density.
    voxel_km3 = ((BOUNDS["nmax"] - BOUNDS["nmin"]) / gridN) \
              * ((BOUNDS["mmax"] - BOUNDS["mmin"]) / gridN) \
              * ((BOUNDS["lmax"] - BOUNDS["lmin"]) / gridN)

    def edges(lo, hi):
        return np.linspace(lo, hi, gridN + 1)

    # Tag controlled (size-power-matched) runs so they don't overwrite blind ones.
    sp_tag = "" if args.size_power is None else f"_sp{int(round(abs(args.size_power) * 10))}"

    def write_cube(suffix, accum_arr, n_rebuilds, hits, extra_note=""):
        rho_num = (accum_arr / max(1, n_rebuilds) / voxel_km3).astype(np.float32).reshape(gridN, gridN, gridN)
        stem = f"gpu_density_cube_JD{args.obs_jd:.2f}_{gridN}{sp_tag}{suffix}"
        np.save(OUT_DIR / f"{stem}_rho_num.npy", rho_num)
        meta = {
            "format": "comet-tail-gpu-accumulated-density-cube-v1",
            "source": "gpu-particle-buffer-readback (rebuild-accumulated, fixed epoch)",
            "note": "Accumulated readback of the actual WebGPU particle positions over "
                    f"{n_rebuilds} independent tail rebuilds at a fixed epoch. RELATIVE "
                    "number density (mean per-rebuild occupancy / voxel volume). Intrinsic "
                    "cometocentric n/m/l frame. " + extra_note,
            "normalized": True,
            "observationJD": args.obs_jd,
            "rebuilds": n_rebuilds,
            "totalParticleHits": hits,
            "shape": [gridN, gridN, gridN],
            "axes": ["n_cross_tail_km (transverse)", "m_along_tail_km (radial)", "l_out_of_plane_km (normal)"],
            "bounds_km": BOUNDS,
            "n_edges_km": edges(BOUNDS["nmin"], BOUNDS["nmax"]).tolist(),
            "m_edges_km": edges(BOUNDS["mmin"], BOUNDS["mmax"]).tolist(),
            "l_edges_km": edges(BOUNDS["lmin"], BOUNDS["lmax"]).tolist(),
            "emission": {"particleCountPerDayAt1AU": float(args.particle_count), "lifetimeDays": float(args.lifetime),
                         "V0_mps": float(args.v0_mps), "gamma": float(args.gamma), "kappa": float(args.kappa),
                         "expcos": float(args.expcos),
                         "directionGeometry": ("uniform-sunward-hemisphere-constant-speed"
                                               if float(args.expcos) == 0.0
                                               else "sunward-hemisphere-direction-weighted"),
                         "activityProfile": args.activity_profile,
                         "activityDaysFromPerihelion": (COMTAILS_ACTIVITY_DAYS
                                                        if args.activity_profile == "comtails" else None),
                         "activityLog10Rate": (COMTAILS_ACTIVITY_LOG10
                                               if args.activity_profile == "comtails" else None),
                         "sizePowerMatched": args.size_power,
                         "rmin_m": (args.rmin if args.size_power is not None else None),
                         "betaMax": ((1.191e-3 * args.qpr / (2.0 * args.rho_grain * args.rmin))
                                     if args.size_power is not None else None)},
        }
        (OUT_DIR / f"{stem}_meta.json").write_text(json.dumps(meta, indent=2))
        print(f"Wrote {OUT_DIR / (stem + '_rho_num.npy')}  ({n_rebuilds} rebuilds, {hits:,} hits)")
        return stem

    full_stem = write_cube("", accum, args.rebuilds, total_hits)

    if args.save_rebuilds and rebuild_stack is not None:
        np.save(OUT_DIR / f"{full_stem}_rebuilds.npy", rebuild_stack)
        print(f"Wrote {OUT_DIR / (full_stem + '_rebuilds.npy')}  "
              f"(per-rebuild count stack, shape {rebuild_stack.shape})")
        print("\nConvergence curve — metric vs. number of rebuilds:")
        print(f"  python analyze_density.py converge \"{OUT_DIR / (full_stem + '_meta.json')}\" "
              f"--comtails <comtails_density_cube.npz>")

    if args.split_half:
        stem_a = write_cube("_A", accum_A, rebuilds_A, hits_A,
                            "Half A (even rebuilds) — pair with _B for the self-agreement noise floor.")
        stem_b = write_cube("_B", accum_B, rebuilds_B, hits_B,
                            "Half B (odd rebuilds) — pair with _A for the self-agreement noise floor.")
        print("\nSelf-agreement (noise floor) — compares two independent halves of this run:")
        print(f"  python analyze_density.py self \"{OUT_DIR / (stem_a + '_meta.json')}\" "
              f"\"{OUT_DIR / (stem_b + '_meta.json')}\"")

    print(f"\nTotal particle hits across {args.rebuilds} rebuilds: {total_hits:,}")


asyncio.run(main())
