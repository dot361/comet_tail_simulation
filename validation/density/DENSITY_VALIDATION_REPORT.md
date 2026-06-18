# Validation 3 — 3D Dust Density vs COMTAILS

A guide to the dust-density validation: what it checks, how to run it, and how to
read the result. No prior context needed.

---

## 1. What this is

This simulator is a tool for modelling cometary dust tails. The paper backs it with
three validations:

1. **Orbit** — the integrator's trajectories vs JPL Horizons (β = 0 dynamics).
2. **Telescope imagery** — the sky-projected, photometric forward model vs real images.
3. **3D dust density** — *this document* — the intrinsic 3D dust distribution vs an
   independent, more detailed model, **COMTAILS**.

**The question this validation answers:** *does the 3D dust density our simulator
produces have the same spatial structure as a trusted independent code, given the same
comet and the same emission physics?*

**COMTAILS** is a published Python cometary-tail model
(`C:\Users\USER\Desktop\vm_comtails\py_COMTAILS-main`). We treat it as the reference.

Two design choices make the comparison meaningful rather than circular:

- **We measure what the simulator actually computes.** The sim cube is produced by
  reading back the real GPU particle buffer after the live integration — not by
  re-running COMTAILS' equations in JavaScript. The only thing the two share is the
  comparison grid.
- **We compare shape, not absolute density.** The sim outputs a *relative* number
  density; COMTAILS outputs an *absolute* one. All metrics are normalized, so we are
  asking "is the dust distributed the same way?", not "are the absolute kg/m³ equal?".
  We deliberately do **not** import COMTAILS' grain-size/mass machinery (that would make
  agreement tautological).

---

## 2. Quick start

**Prerequisites**
- COMTAILS installed at `py_COMTAILS-main`, with the intrinsic-frame patch applied
  (the regenerate script checks this and refuses to run otherwise).
- Python with `numpy`, `scipy`, `matplotlib`, `playwright` (`pip install …; python -m
  playwright install chromium`).
- A machine with **real WebGPU** — the sim export drives an actual browser; software-GL
  headless has no WebGPU.

**Run everything (from `validation/density/`):**

```powershell
# 1. Build the 3 COMTAILS reference cubes (writes results_*/comtails_density_cube.npz).
.\regenerate_comtails_cases.ps1

# 2. Export the sim cubes + run all metrics + figures + print a summary table.
.\run_validation_analysis.ps1                 # "blind" run (default)
.\run_validation_analysis.ps1 -SizePower -3.9 # "controlled" run (see §6)

# Re-run only the analysis on existing sim cubes (no browser):
.\run_validation_analysis.ps1 -SkipExport
```

The summary table at the end is the whole result at a glance (see §7 for how to read it).

---

## 3. The shared physics

Both codes solve the same grain dynamics, so any structural agreement is a real test of
the implementation rather than of different physics.

**Radiation-pressure-reduced gravity.** A dust grain feels the Sun's gravity reduced by
radiation pressure, parameterized by `β` (the radiation-pressure-to-gravity ratio):

```
mu_eff = G * M_sun * (1 - beta)
```

**β and grain size.** Smaller grains feel relatively more radiation pressure:

```
beta = 1.191e-3 * Q_pr / (2 * rho_grain * a)      # a = grain radius [m]
```

So **high β = small grain = pushed hard = flies far down the anti-sunward tail**, and
**low β = large grain = stays near the nucleus**. The *distribution of β* therefore
controls how dust is spread along the tail — this is the crux of §6.

**Ejection speed.** Grains leave the nucleus at:

```
V_ej = V0 * beta^gamma * r_h^kappa             # r_h = heliocentric distance [AU]
```

The runs use `V0 = 0.80 km/s`, `kappa = -0.5`, isotropic directions, with `gamma` varied
between cases.

---

## 4. The cometocentric frame

Both codes bin dust into a frame centred on the nucleus, with axes:

- **m** = radial (Sun → comet direction)
- **l** = orbital normal (`r × v`)
- **n** = transverse (in-plane, perpendicular to m)

The sim builds this directly from the comet's instantaneous state:

```
m_hat = normalize(r)            # radial
l_hat = normalize(r x v)        # normal
n_hat = l_hat x m_hat           # transverse (= +theta_hat, prograde)
```

COMTAILS builds the same frame internally (`orbital/heliorbit.py`), rotating the orbital-
plane coordinates by the comet's true anomaly `theta_c`:

```
chita = xout*cos(theta_c) + yout*sin(theta_c) - r_c   # radial   -> m
eta   = xout*sin(theta_c) - yout*cos(theta_c)         # transverse -> n
gita  = zout                                          # normal   -> l
```

### ⚠ One convention gotcha (already handled)

COMTAILS' `eta` basis is `r_hat` rotated −90° = **−theta_hat**, but the sim's `n_hat` is
**+theta_hat**. So **`n_sim = −eta_COMTAILS`** — the two cubes are mirror images across
`n = 0`. Left uncorrected, the tail appears to "swerve" the opposite way between the two.
`analyze_density.py` (`load_comtails_cube`) corrects it by flipping COMTAILS' n-axis
(`np.flip(axis=0)`, valid because the n-bounds are symmetric about the nucleus). `m` and
`l` signs already agree.

---

## 5. The three test cases

All cases are comet 67P, isotropic emission, with two axes varied off a common anchor so
the comparison isn't a single cherry-picked geometry:

| # | what it varies | obs epoch | r_h | γ | COMTAILS run |
|---|----------------|-----------|-----|---|--------------|
| 1 | anchor | perihelion (JD 2457248.5) | 1.24 AU | 0.1 | `run_V_67p_iso_peri` |
| 2 | ejection law (γ) | perihelion | 1.24 AU | **0.7** | `g07_canon` |
| 3 | heliocentric distance | **+100 d** (JD 2457348.5) | **1.71 AU** | 0.1 | `run_J_tail500` |

- Case 1↔2 isolates the ejection-velocity law.
- Case 1↔3 isolates heliocentric distance (`r_h^kappa`, radiation-pressure magnitude).
  The +100 d post-perihelion window is the COMTAILS-validated one (a perihelion-start
  window floods the cube with fresh sunward dust and suppresses the tail).

All three use grain-size index `power = −3.9`, density `rho = 3000 kg/m³`. They differ in
minimum grain size `rmin` (from each run's `dmdt.dat`): cases 1–2 use 0.1 µm, case 3 uses
0.5 µm — which matters in §6.

---

## 6. Two comparison modes: blind and controlled

The simulator and COMTAILS assign grain sizes (β values) by **different mechanisms**.
This is the one input we don't share by default, and it's the main thing that makes the
two density fields differ. There are two ways to run the comparison:

**Blind (`run_validation_analysis.ps1`, default).** Each code uses its *own* native β /
size treatment. This shows the simulator is physically reasonable *without tuning it to
COMTAILS*. Expect the radial structure to match but the along-tail profile to differ
(COMTAILS' calibrated `−3.9` size law puts more small/high-β grains far down the tail).

**Controlled (`-SizePower -3.9`).** We shape the simulator's β distribution to represent
the *same* grain-size law COMTAILS uses — a shared physical input, like V0/γ/κ, **not**
imported COMTAILS code. With β ∝ 1/a, a size law `dn/da ∝ a^power` becomes a β number
distribution:

```
dn/dbeta  ∝  beta^(-power-2)        # for power = -3.9  ->  beta^1.9
```

`BetaCurve.js`'s `setBetaCurveSizePower(power, betaMax)` sets the emitted-β PDF to exactly
this. With the grain population matched, the only remaining differences are the genuinely
independent parts (integration, frame, sampling), so agreement should tighten.

**The β ≤ 1 cap (why case 3 is special).** The simulator clamps β ≤ 1 (it only models
bound grains). COMTAILS' smallest grains can exceed that:

```
beta_max = 1.191e-3 * Q_pr / (2 * rho * rmin)
  rmin = 0.1 um (cases 1,2)  ->  beta_max ~ 1.99   (β>1 grains exist; sim can't represent them)
  rmin = 0.5 um (case 3)     ->  beta_max ~ 0.40   (fully within β<=1 — clean match)
```

So in a controlled run, **case 3 should converge cleanly**, while cases 1–2 keep a
residual from the β>1 grains the simulator structurally omits — itself an honest,
quantified scope statement for the paper. The β cutoff is applied per case automatically
(the script passes each case's `rmin`).

---

## 7. How to read the output

`analyze_density.py` has three subcommands; the batch runs all three per case.

- **`compare`** → `shape_cosine` of sim vs COMTAILS. **The headline number.**
- **`self`** → the **noise floor**. The sim uses unseeded RNG, so two independent halves
  of one run (`_A`, `_B`) differ only by shot noise. Scoring them against each other gives
  the *ceiling* the metric can reach at this particle count.
- **`converge`** → the metric vs number of accumulated rebuilds, to show it has plateaued.

**Read `compare` against `self`:**

| observation | meaning |
|-------------|---------|
| `compare` ≈ `self` (both near 1) | at the noise floor — agreement is as good as the sim agrees with itself |
| `compare` ≪ `self` | a **real, physical** model difference (not noise) |

`self ≈ 1.0` (which is what we see) means the result is **not** limited by particle count —
adding particles won't change it.

**The figures** (`slices`, `mip`, `profiles`, `scatter` PNGs in each `results_*/`): the
**profiles** plot is the most informative — it overlays the peak-normalized radial and
along-tail density profiles, showing directly where (and how) the two distributions agree
or diverge.

---

## 8. Methods — how `analyze_density.py` works

The whole comparison lives in `analyze_density.py`. The pipeline for `compare` is:

1. **Load both cubes.** `load_comtails_cube` reads the `.npz` and applies the transverse-
   axis fix (`np.flip(axis=0)`, §4) so COMTAILS' `−eta` matches the sim's `+n`.
   `load_sim_cube` reads the `.npy` + its `_meta.json` (grid edges, params).
2. **Put both on one grid — the coarser, well-sampled (sim) one.** `bring_to_grid` brings
   COMTAILS down to the sim grid. *How* it downsamples matters:
   - if the COMTAILS grid is an **integer-factor finer** with matching bounds (the normal
     case, 256 → 128, `f = 2`), it **block-averages** — the mean over each `f³` voxel
     block. This pools COMTAILS' Monte-Carlo particles and **suppresses shot noise**;
   - otherwise it falls back to **trilinear interpolation** (`resample_to`).

   Block-averaging *down* is the key choice: interpolating the sim *up* onto COMTAILS'
   256³ grid instead would inject COMTAILS' sparse-tail speckle straight into the metric.

   ```
   rho_coarse[i,j,k] = mean( rho_fine[ i*f:(i+1)*f, j*f:(j+1)*f, k*f:(k+1)*f ] )
   ```
3. **Score with normalization-invariant shape metrics** (`x` = COMTAILS, `y` = sim, each
   normalized to unit sum so the relative-vs-absolute scale cancels):

   ```
   x_hat = x / sum(x);  y_hat = y / sum(y)
   shape_cosine  = (x_hat . y_hat) / (|x_hat| |y_hat|)   # headline number
   shape_overlap = sum( min(x_hat, y_hat) )              # 1.0 = identical distributions
   pearson_r     = corrcoef(x, y)
   ```
   (`compare` also reports raw `rmse`/`normalized_rmse` and per-cube totals/max, but those
   are scale-dependent and secondary here.)

**`self` (noise floor).** Same `compare` machinery, but on two independent halves of one
run: the export splits rebuilds by parity (even → `_A`, odd → `_B`). `compare(A, B)` is the
ceiling the metric can reach at this particle count.

**`converge`.** Uses the `_rebuilds.npy` stack (per-rebuild counts). A cumulative sum lets
it rebuild `cube(k)` = the cube from the first `k` rebuilds cheaply, and it tracks the
metric vs `k` along two curves: **internal** (`cube(k)` vs the full cube — shows the
morphology settling) and **vs-COMTAILS** (`cube(k)` vs the reference — shows the reported
number has plateaued, not still drifting).

---

## 9. Example results (128³, blind)

| Case | `shape_cosine` (vs COMTAILS) | noise floor (`self`) | `shape_overlap` |
|------|------------------------------|----------------------|-----------------|
| 1 peri γ=0.1 | 0.65 | ≈1.00 | 0.42 |
| 2 peri γ=0.7 | 0.71 | ≈1.00 | 0.61 |
| 3 +100 d γ=0.1 | 0.69 | ≈1.00 | 0.55 |

**Interpretation.** The noise floor ≈ 1.0 everywhere, so the 0.65–0.71 is a real,
reproducible difference, not shot noise. The **radial profile agrees across ~5 decades**;
the **along-tail profile diverges** (COMTAILS carries a fatter tail). That difference is
the grain-size-distribution signature — exactly what the controlled run (§6) is designed
to test by matching it.

---

## 10. Scope & limitations (state these in the paper)

1. **Shape, not absolute density** — sim is relative, COMTAILS absolute; the size
   distribution is matched only in the controlled run.
2. **Matched inputs** — same dynamics, ejection law, isotropic emission. So this is a
   *cross-code consistency check of shared physics*, not an independent dynamics
   validation (that's validation 1, β = 0 vs JPL).
3. **Intrinsic-frame** — observer-independent, complementary to validation 2 (which tests
   the sky-projected, photometric view).
4. **β ≤ 1 cap** — the sim models only bound grains; COMTAILS' sub-0.2 µm (β>1) grains are
   not represented (relevant only where `rmin < ~0.2 µm`, i.e. cases 1–2).

---

## 11. Files

**Pipeline (`validation/density/`):**

| File | Role |
|------|------|
| `regenerate_comtails_cases.ps1` | build the 3 COMTAILS reference cubes (patched), with a patch-presence guard and `-Resolution` |
| `run_gpu_density_export.py` | headless WebGPU export of a sim cube (+ `_A`/`_B` halves and a `_rebuilds` stack); `--size-power` for controlled runs |
| `analyze_density.py` | `compare` / `self` / `converge`; block-averaging; the n-axis convention fix |
| `visualize_density_comparison.py` | `slices` / `mip` / `profiles` / `scatter` / `pyvista` figures |
| `run_validation_analysis.ps1` | the full pipeline for all 3 cases + summary table; `-SizePower` for controlled |
| `results_67P_iso_peri/`, `…_gamma07/`, `…_postperi/` | per-case COMTAILS + sim cubes, JSON metrics, figures |

**What's committed vs regenerable.** The repo `.gitignore` keeps the large, regenerable
binaries out of git — the `*.npy`/`*.npz`/`*.fits` cubes and the `_rebuilds` stacks
(several hundred MB each), plus the `_gpu_downloads`/`_browser_downloads` scratch dirs.
The small, durable artifacts stay tracked: every `*_meta.json` (full run provenance), the
metric JSONs, the figures, and `TAIL_INPUTS.used.dat`. Regenerate the cubes from those
metas with `regenerate_comtails_cases.ps1` + `run_validation_analysis.ps1`.

**Simulator components this relies on (`src/simulation/`):**

| File | Role |
|------|------|
| `ExportDensityGpuAccum.js` | reads back the GPU particle buffer into a cometocentric cube (the validation export) |
| `BetaCurve.js` | the emitted-β PDF; `setBetaCurveSizePower()` matches a grain-size law (controlled runs) |
| `Physics.js` | universal-variable Kepler propagator with substepping (high-β / far-tail accuracy) |
| `Constants.js` | particle-system limits (`MAX_PARTICLES_GPU`, `HARD_CAP`) |
| `ExportUtils.js` | shared `.npy` / download helpers |

> **Note:** the simulator-side changes below (and the `validation/density/` tree) are not
> yet committed to git. Commit them before relying on these results for the paper.

---

## 12. Changes to existing simulator files

What this work modified in files that already existed, and why.

**`src/simulation/Physics.js` — Kepler propagator substepping.**
`keplerUniversalPropagate` (universal-variable two-body solver) was made to **substep**.
For a high-β grain, `mu_eff = G·M_sun·(1−β)` is tiny; combined with a long `dt` the
universal variable `x` grows large, so `z = alpha·x²` becomes extreme and the Stumpff
`cosh/sinh(sqrt(−z))` terms overflow — the Newton iteration then returns positions wrong
by 5+ orders of magnitude (confirmed for some β > 0.998). The fix bounds `|z|` by
splitting the step into `N = ceil(sqrt(|z|/50))` substeps (capped at 64). The original
per-step math is preserved bit-identically as `_keplerUniversalStep`, and with `N = 1`
every previously-working call is unchanged. **Why it matters here:** the far, fast,
anti-sunward tail *is* the high-β regime, so this directly affects the density structure
being validated.

**`src/simulation/Constants.js` — particle budget.**
`MAX_PARTICLES_GPU` raised `1_000_000 → 4_000_000` and `HARD_CAP` (births per
headless-propagate step) `4096 → 8192`. **Why:** the density cube is shot-noise-limited in
the sparse tail; more live particles lower that noise. The budget is sized so the export
fills toward the cap over a grain lifetime (≈80k particles/day × 50 days ≈ 4e6, at ≤8192
births/step).

**`src/simulation/BetaCurve.js` — size-law preset (added function).**
Added `setBetaCurveSizePower(sizePower, betaMax)` (exposed on `window`), which sets the
emitted-β PDF to `β^(−sizePower−2)` over `[0, betaMax]`. **Why:** enables the *controlled*
comparison (§6) — shaping the simulator's own β distribution to a grain-size law without
importing any COMTAILS code. The rest of the file (the interactive β-curve editor) is
unchanged.

**`index.html` — Analysis-panel cleanup.**
Removed the UI controls and `<script>` tags for the superseded exporters, added the tag
for `ExportDensityGpuAccum.js`, and pointed the shared helpers at `ExportUtils.js`.
**Why:** the single-snapshot and analytic-bake exporters were replaced by the GPU-readback
export; the panel was trimmed to what the validation actually uses.

**New files added:** `ExportDensityGpuAccum.js` (GPU-readback export), `ExportUtils.js`
(shared `.npy`/download helpers, extracted from the removed file).
**File removed:** `ExportDensity.js` (single live-buffer snapshot — superseded).
