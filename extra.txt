---

## Enhancements (from original)

### Realistic 3D dust ejection velocity (Whipple / Finson-Probstein model)
Particles are no longer emitted isotropically. The ejection speed follows:

```
v_ej = V0 × β^γ × r_h^κ
```

Direction is sampled from the sunlit hemisphere using cosine^expcos weighting (Malley's method), so fast small grains (high β) are launched preferentially toward the Sun.

Four new parameters in the **Velocity** UI group:
- **V₀** — base ejection speed (m/s)
- **γ (gamma)** — β exponent: larger γ → size-dependent velocity spread
- **κ (kappa)** — heliocentric distance exponent (typically −0.5)
- **expcos** — sunlit-cone sharpness (1 = cosine, higher = more collimated)

### Collapsible contextual UI
The flat left-overlay was reorganised into 7 collapsible `<details>` groups (Orbit, Activity, Particles, Velocity, Camera, Analysis, View). Each group expands on click with a CSS chevron indicator. The overlay is scrollable on small screens.

### 3D particle density grid export (`ExportDensity.js`)
New analysis export — pause the simulation and click **Export density grid (.npy)** in the Analysis group. Downloads two files:

- `density_cube_JD<jd>_<N>_rho_num.npy` — float32 `[N, N, N]` array (particles/km³)
- `density_cube_JD<jd>_<N>_meta.json` — grid bounds, voxel sizes, orbital elements, export parameters

The grid is in the **cometocentric (n, m, l)** frame (m = anti-solar, l = orbital north, n = cross-tail). Export options:

| Control | Purpose |
|---|---|
| Grid resolution N³ | 32 / 64 / 128 / 256 voxels per side |
| Max particle age (days) | Exclude old particles to avoid arc artefacts from orbital motion (0 = all) |
| Max distance from nucleus (km) | Cap radius to focus the grid on the inner coma (0 = all) |
| Bound clip low/high % | Percentile trim to exclude positional outliers from the bounding box |

Requires GPU readback: `ParticlesGPU.js` now exposes an async `readback()` method (staging buffer with `COPY_SRC` flag).

### `view_tail_export.py` — density cube visualiser
Python script that reads the exported `.npy` + `_meta.json` and visualises the density cube. Mirrors `visualize_density_cube.py` so results are directly comparable.

```bash
python view_tail_export.py --log10                          # auto-detect latest export
python view_tail_export.py --mode slices --log10
python view_tail_export.py --mode mip --log10
python view_tail_export.py --mode pyvista --iso --log10
python view_tail_export.py --analyze                        # statistics + histogram + MIP
```

Key behaviours:
- **`--analyze`** — prints fill fraction, voxel size, domain extents, density percentiles; shows a matplotlib histogram and n-m MIP projection without launching PyVista.
- `trim_to_data` crops the grid to the bounding box of occupied voxels before rendering, so the PyVista camera fits the data rather than the full allocated domain.
- Empty voxels are masked to a sentinel value below the auto-clim range so PyVista's sigmoid opacity treats them as fully transparent.

---