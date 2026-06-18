"""
Analysis CLI for the GPU density-cube validation (validation 3).

One tool, three subcommands — all operate on cubes in the shared intrinsic
cometocentric (n,m,l) frame:

  compare   sim-vs-COMTAILS shape metrics (the headline agreement number).
                python analyze_density.py compare <comtails.npz> <sim_meta.json>

  self      self-agreement NOISE FLOOR: compare the two independent halves
            (_A / _B) of one run. This is the CEILING the metric can reach at
            this particle count, so the `compare` number is read against it.
                python analyze_density.py self <..._A_meta.json> <..._B_meta.json>

  converge  CONVERGENCE curve: rebuild the cube from the first k rebuilds and
            track a metric vs k, to show it has plateaued (needs the
            {stem}_rebuilds.npy stack written by run_gpu_density_export.py).
                python analyze_density.py converge <sim_meta.json> [--comtails <npz>]

Together: `converge` shows the number is settled, `self` shows the best it could
be, `compare` is the number — read against the `self` ceiling.

Cubes live in the same frame as the COMTAILS patch (py_COMTAILS-main/orbital/
heliorbit.py + models/dust_tail.py): n = cross-tail, m = along-tail (radial),
l = out-of-plane (normal).
"""
import argparse
import json
from pathlib import Path

import numpy as np


# ─── Cube loading ────────────────────────────────────────────────────────────

def load_comtails_cube(npz_path: Path) -> dict:
    d = np.load(npz_path)
    # Transverse-axis convention fix. COMTAILS builds eta = xout*sin - yout*cos
    # (heliorbit.py:473), i.e. r_hat rotated -90deg = -theta_hat, while the sim's
    # n_hat = l_hat x m_hat = +theta_hat. So n_sim = -eta_COMTAILS: the cubes are
    # mirror images across n=0 (this is the "tail swerves the other way" artifact).
    # The n-bounds are symmetric about the nucleus, so negating n == flipping the
    # array along axis 0. Done here so every consumer sees the aligned frame.
    flip_n = lambda a: np.flip(np.asarray(a, dtype=np.float64), axis=0)
    return {
        "rho_mass": flip_n(d["rho_mass"]),
        "rho_num": flip_n(d["rho_num"]),
        "n_edges_km": np.asarray(d["n_edges_km"], dtype=np.float64),
        "m_edges_km": np.asarray(d["m_edges_km"], dtype=np.float64),
        "l_edges_km": np.asarray(d["l_edges_km"], dtype=np.float64),
    }


def load_sim_cube(meta_json_path: Path) -> dict:
    meta = json.loads(meta_json_path.read_text())
    if not meta_json_path.name.endswith("_meta.json"):
        raise ValueError(f"Expected a *_meta.json export, got {meta_json_path.name}")
    stem = meta_json_path.name[: -len("_meta.json")]
    base = meta_json_path.parent
    cube = {
        "rho_num": np.load(base / f"{stem}_rho_num.npy").astype(np.float64),
        "n_edges_km": np.asarray(meta["n_edges_km"], dtype=np.float64),
        "m_edges_km": np.asarray(meta["m_edges_km"], dtype=np.float64),
        "l_edges_km": np.asarray(meta["l_edges_km"], dtype=np.float64),
        "meta": meta,
    }
    # rho_mass is optional: the analytic bake writes it, the GPU-readback cube
    # (relative number density) does not.
    mass_path = base / f"{stem}_rho_mass.npy"
    if mass_path.exists():
        cube["rho_mass"] = np.load(mass_path).astype(np.float64)
    return cube


def centers(edges: np.ndarray) -> np.ndarray:
    return 0.5 * (edges[:-1] + edges[1:])


def resample_to(cube_src: dict, edges_n: np.ndarray, edges_m: np.ndarray, edges_l: np.ndarray) -> dict:
    """Resample cube_src's rho_num/rho_mass onto the voxel centers implied by the
    given target edges, via trilinear interpolation. Used when two cubes don't
    share the exact same grid (resolution and/or bounds)."""
    from scipy.interpolate import RegularGridInterpolator

    src = (centers(cube_src["n_edges_km"]), centers(cube_src["m_edges_km"]), centers(cube_src["l_edges_km"]))
    grid = np.stack(np.meshgrid(centers(edges_n), centers(edges_m), centers(edges_l), indexing="ij"), axis=-1)
    out = {}
    for key in ("rho_num", "rho_mass"):
        if key not in cube_src:
            continue
        interp = RegularGridInterpolator(src, cube_src[key], bounds_error=False, fill_value=0.0)
        out[key] = interp(grid)
    return out


def _block_mean(arr: np.ndarray, ratios) -> np.ndarray:
    rn, rm, rl = ratios
    n0, n1, n2 = arr.shape
    return arr.reshape(n0 // rn, rn, n1 // rm, rm, n2 // rl, rl).mean(axis=(1, 3, 5))


def bring_to_grid(cube_src: dict, edges_n: np.ndarray, edges_m: np.ndarray, edges_l: np.ndarray) -> dict:
    """Put cube_src onto the target grid. If the source is an integer-factor FINER
    grid sharing the same bounds, BLOCK-AVERAGE it down (pools the source's
    Monte-Carlo particles into the coarser voxels → conserves the density and
    suppresses shot noise). Otherwise fall back to trilinear interpolation.

    This matters because COMTAILS at 256^3 is shot-noise-limited in the sparse
    tail; comparing on the sim's well-sampled 64^3 grid via averaging removes
    that noise instead of injecting it into the metric."""
    src_shape = cube_src["rho_num"].shape
    tgt_shape = (len(edges_n) - 1, len(edges_m) - 1, len(edges_l) - 1)
    bounds_ok = all(
        np.allclose(cube_src[k][[0, -1]], [e[0], e[-1]], rtol=1e-4)
        for k, e in (("n_edges_km", edges_n), ("m_edges_km", edges_m), ("l_edges_km", edges_l))
    )
    ratios = tuple(s // t for s, t in zip(src_shape, tgt_shape))
    integer_finer = (
        bounds_ok
        and all(s == t * r for s, t, r in zip(src_shape, tgt_shape, ratios))
        and any(r > 1 for r in ratios)
    )
    if integer_finer:
        return {k: _block_mean(cube_src[k], ratios) for k in ("rho_num", "rho_mass") if k in cube_src}
    return resample_to(cube_src, edges_n, edges_m, edges_l)


def grids_match(a: dict, b_shape, b_edges) -> bool:
    bn, bm, bl = b_edges
    return (
        a["rho_num"].shape == tuple(b_shape)
        and np.allclose(a["n_edges_km"], bn, rtol=1e-6)
        and np.allclose(a["m_edges_km"], bm, rtol=1e-6)
        and np.allclose(a["l_edges_km"], bl, rtol=1e-6)
    )


# ─── Metrics ─────────────────────────────────────────────────────────────────

def shape_metrics(x: np.ndarray, y: np.ndarray) -> dict:
    """Normalization-invariant shape metrics on two raveled cubes. These are the
    meaningful ones when one cube is relative/normalized (the GPU cube) and the
    other absolute (COMTAILS): each is normalized to unit sum first."""
    mask = np.isfinite(x) & np.isfinite(y)
    x, y = x[mask], y[mask]
    xs = x / x.sum() if x.sum() > 0 else x
    ys = y / y.sum() if y.sum() > 0 else y
    denom = float(np.linalg.norm(xs) * np.linalg.norm(ys))
    return {
        "shape_cosine": float(np.dot(xs, ys) / denom) if denom > 0 else float("nan"),
        "shape_overlap": float(np.minimum(xs, ys).sum()),  # 1.0 = identical distributions
        "pearson_r": float(np.corrcoef(x, y)[0, 1]) if x.std() > 0 and y.std() > 0 else float("nan"),
        "shape_rmse_unitsum": float(np.sqrt(np.mean((ys - xs) ** 2))),
    }


def compare(a: dict, b: dict, label_a: str, label_b: str) -> dict:
    """Full per-field comparison (shape metrics + raw RMSE + totals). Used for
    both sim-vs-COMTAILS (`compare`) and half-vs-half (`self`)."""
    report = {}
    for key in (k for k in ("rho_num", "rho_mass") if k in a and k in b):
        x = a[key].ravel()
        y = b[key].ravel()
        mask = np.isfinite(x) & np.isfinite(y)
        x, y = x[mask], y[mask]

        diff = y - x
        rmse = float(np.sqrt(np.mean(diff ** 2)))
        ref_rms = float(np.sqrt(np.mean(x ** 2))) or 1.0

        report[key] = {
            "rmse": rmse,
            "normalized_rmse": rmse / ref_rms,
            **shape_metrics(x, y),
            f"{label_a}_total": float(x.sum()),
            f"{label_b}_total": float(y.sum()),
            f"{label_a}_max": float(x.max()),
            f"{label_b}_max": float(y.max()),
        }
    return report


# ─── Subcommand: compare (sim vs COMTAILS) ───────────────────────────────────

def cmd_compare(args):
    comtails = load_comtails_cube(args.comtails_npz)
    sim = load_sim_cube(args.sim_meta_json)

    if grids_match(comtails, sim["rho_num"].shape,
                   (sim["n_edges_km"], sim["m_edges_km"], sim["l_edges_km"])):
        print("Grids match exactly (shape + edges) — comparing without resampling.")
        comtails_on_grid = comtails
    else:
        # Compare on the sim's (coarser, well-sampled) grid: bring COMTAILS DOWN by
        # block-averaging so its 256^3 shot noise is pooled away, not interpolated
        # onto a finer grid where it dominates the metric.
        print("Grids differ — block-averaging COMTAILS onto the sim grid.")
        comtails_on_grid = bring_to_grid(comtails, sim["n_edges_km"], sim["m_edges_km"], sim["l_edges_km"])

    report = compare(comtails_on_grid, sim, label_a="comtails", label_b="sim")
    report["shape"] = list(sim["rho_num"].shape)
    _emit(report, args.out)


# ─── Subcommand: self (noise-floor ceiling) ──────────────────────────────────

def cmd_self(args):
    a = load_sim_cube(args.half_a_meta)
    b = load_sim_cube(args.half_b_meta)

    if grids_match(a, b["rho_num"].shape, (b["n_edges_km"], b["m_edges_km"], b["l_edges_km"])):
        print("Halves share the same grid — comparing without resampling.")
        b_on_a = b
    else:
        print("Halves differ in grid — resampling B onto A.")
        b_on_a = resample_to(b, a["n_edges_km"], a["m_edges_km"], a["l_edges_km"])

    report = compare(a, b_on_a, label_a="half_A", label_b="half_B")
    report["shape"] = list(a["rho_num"].shape)
    report["rebuilds_A"] = a["meta"].get("rebuilds")
    report["rebuilds_B"] = b["meta"].get("rebuilds")
    report["note"] = ("Self-agreement of two independent halves of one run — the CEILING "
                      "values; read the `compare` (sim-vs-COMTAILS) metrics against them.")

    ceil = report.get("rho_num", {})
    if "shape_cosine" in ceil:
        print(f"\nNoise-floor ceiling (rho_num): shape_cosine={ceil['shape_cosine']:.4f}, "
              f"shape_overlap={ceil['shape_overlap']:.4f}, pearson_r={ceil['pearson_r']:.4f}")
    _emit(report, args.out)


# ─── Subcommand: converge (metric vs rebuild count) ──────────────────────────

def cmd_converge(args):
    meta = json.loads(args.sim_meta_json.read_text())
    if not args.sim_meta_json.name.endswith("_meta.json"):
        raise ValueError(f"Expected a *_meta.json export, got {args.sim_meta_json.name}")
    stem = args.sim_meta_json.name[: -len("_meta.json")]
    base = args.sim_meta_json.parent

    stack_path = base / f"{stem}_rebuilds.npy"
    if not stack_path.exists():
        raise FileNotFoundError(
            f"{stack_path} not found — re-run run_gpu_density_export.py without --no-save-rebuilds."
        )
    stack = np.load(stack_path).astype(np.float64)  # (R, gridN^3)
    R = stack.shape[0]
    gridN = int(round(stack.shape[1] ** (1 / 3)))

    n_edges = np.asarray(meta["n_edges_km"], dtype=np.float64)
    m_edges = np.asarray(meta["m_edges_km"], dtype=np.float64)
    l_edges = np.asarray(meta["l_edges_km"], dtype=np.float64)
    voxel_km3 = (n_edges[1] - n_edges[0]) * (m_edges[1] - m_edges[0]) * (l_edges[1] - l_edges[0])

    cumsum = np.cumsum(stack, axis=0)  # cube(k) = mean of first k rebuilds in O(1)

    def cube_at(k: int) -> np.ndarray:
        return (cumsum[k - 1] / k) / voxel_km3

    full_cube = cube_at(R)

    comtails_ref = None
    if args.comtails is not None:
        ct = load_comtails_cube(args.comtails)
        if grids_match(ct, (gridN, gridN, gridN), (n_edges, m_edges, l_edges)):
            comtails_ref = ct["rho_num"].ravel()
        else:
            print("COMTAILS grid differs — block-averaging it onto the sim grid.")
            comtails_ref = bring_to_grid(ct, n_edges, m_edges, l_edges)["rho_num"].ravel()

    if args.checkpoints and args.checkpoints < R:
        ks = np.unique(np.linspace(1, R, args.checkpoints).round().astype(int))
    else:
        ks = np.arange(1, R + 1)

    rows = []
    for k in ks:
        c = cube_at(int(k))
        internal = shape_metrics(c, full_cube)[args.metric]
        row = {"k": int(k), "internal": internal}
        if comtails_ref is not None:
            row["vs_comtails"] = shape_metrics(c, comtails_ref)[args.metric]
        rows.append(row)
        msg = f"  k={int(k):>3}/{R}: internal {args.metric}={internal:.4f}"
        if comtails_ref is not None:
            msg += f", vs-COMTAILS={row['vs_comtails']:.4f}"
        print(msg)

    result = {"metric": args.metric, "rebuilds_total": R, "stem": stem, "curve": rows}
    args.out_json.write_text(json.dumps(result, indent=2))
    print(f"\nWrote {args.out_json}")

    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("(matplotlib not installed — skipping the plot; the JSON curve was written.)")
        return

    kk = [r["k"] for r in rows]
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.plot(kk, [r["internal"] for r in rows], "-o", ms=3, label="internal (vs full cube)")
    if comtails_ref is not None:
        ax.plot(kk, [r["vs_comtails"] for r in rows], "-s", ms=3, label="vs COMTAILS")
    ax.set_xlabel("rebuilds accumulated (k)")
    ax.set_ylabel(args.metric)
    ax.set_title(f"Density-cube convergence — {args.metric}")
    ax.grid(True, alpha=0.3)
    ax.legend()
    fig.tight_layout()
    fig.savefig(args.out_plot, dpi=130)
    print(f"Wrote {args.out_plot}")


# ─── shared output ───────────────────────────────────────────────────────────

def _emit(report: dict, out_path: Path):
    print(json.dumps(report, indent=2))
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\nWrote {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("compare", help="sim-vs-COMTAILS shape metrics")
    p.add_argument("comtails_npz", type=Path, help="COMTAILS output/density_cube.npz")
    p.add_argument("sim_meta_json", type=Path, help="sim *_meta.json export")
    p.add_argument("--out", type=Path, default=Path("density_comparison.json"))
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("self", help="self-agreement noise floor (two halves of one run)")
    p.add_argument("half_a_meta", type=Path, help="the _A *_meta.json (even rebuilds)")
    p.add_argument("half_b_meta", type=Path, help="the _B *_meta.json (odd rebuilds)")
    p.add_argument("--out", type=Path, default=Path("self_agreement.json"))
    p.set_defaults(func=cmd_self)

    p = sub.add_parser("converge", help="metric vs. rebuild count (needs the _rebuilds.npy stack)")
    p.add_argument("sim_meta_json", type=Path, help="the full *_meta.json export")
    p.add_argument("--comtails", type=Path, default=None, help="COMTAILS density_cube.npz (adds the vs-COMTAILS curve)")
    p.add_argument("--metric", default="shape_cosine", choices=["shape_cosine", "shape_overlap", "pearson_r"])
    p.add_argument("--checkpoints", type=int, default=0, help="number of k values to evaluate (0 = every rebuild)")
    p.add_argument("--out-plot", type=Path, default=Path("convergence.png"))
    p.add_argument("--out-json", type=Path, default=Path("convergence.json"))
    p.set_defaults(func=cmd_converge)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
