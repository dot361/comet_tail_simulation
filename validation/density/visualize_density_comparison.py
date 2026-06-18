"""
Visualize a comet_tail_simulation vs. COMTAILS density-cube comparison.

Both cubes are assumed to already be on the same intrinsic cometocentric
(n,m,l) grid (see analyze_density.py) — n = cross-tail, m = along-tail
(radial), l = out-of-plane (normal). If they differ, this script resamples
the sim cube onto the COMTAILS grid the same way analyze_density.py
does.

Usage:
    python visualize_density_comparison.py --mode all
    python visualize_density_comparison.py --mode pyvista --field rho_num
    python visualize_density_comparison.py --mode slices --linear

Defaults point at results_67P_iso_peri/ (the 67P isotropic-perihelion
comparison run). Pass --comtails/--sim-meta to use a different result.
"""
import argparse
from pathlib import Path

import numpy as np

from analyze_density import load_comtails_cube, load_sim_cube, bring_to_grid, centers

HERE = Path(__file__).parent
DEFAULT_COMTAILS = HERE / "results_67P_iso_peri" / "comtails_density_cube.npz"
DEFAULT_SIM_META = HERE / "results_67P_iso_peri" / "gpu_density_cube_JD2457248.50_128_meta.json"


def load_pair(comtails_path: Path, sim_meta_path: Path):
    comtails = load_comtails_cube(comtails_path)
    sim = load_sim_cube(sim_meta_path)

    same_grid = (
        comtails["rho_num"].shape == sim["rho_num"].shape
        and np.allclose(comtails["n_edges_km"], sim["n_edges_km"], rtol=1e-6)
        and np.allclose(comtails["m_edges_km"], sim["m_edges_km"], rtol=1e-6)
        and np.allclose(comtails["l_edges_km"], sim["l_edges_km"], rtol=1e-6)
    )
    if not same_grid:
        # Compare on the sim's (coarser, well-sampled) grid: block-average COMTAILS
        # down so its fine-grid shot noise is pooled away rather than shown as
        # speckle. Carry the sim's edges so the plot extents match.
        print("Grids differ — block-averaging COMTAILS onto the sim grid for visualization.")
        ct = bring_to_grid(comtails, sim["n_edges_km"], sim["m_edges_km"], sim["l_edges_km"])
        comtails = {
            **ct,
            "n_edges_km": sim["n_edges_km"],
            "m_edges_km": sim["m_edges_km"],
            "l_edges_km": sim["l_edges_km"],
        }

    return comtails, sim


def prep(field: np.ndarray, log10: bool, eps_factor=1e-12) -> np.ndarray:
    if not log10:
        return field
    vmax = float(np.nanmax(field))
    eps = vmax * eps_factor if vmax > 0 else 1e-30
    return np.log10(np.clip(field, eps, None))


# ─── PyVista: side-by-side 3D volumes ─────────────────────────────────────────

def _pv_grid(field: np.ndarray, n_edges: np.ndarray, m_edges: np.ndarray, l_edges: np.ndarray):
    import pyvista as pv

    nx, ny, nz = field.shape
    dx = float(n_edges[1] - n_edges[0])
    dy = float(m_edges[1] - m_edges[0])
    dz = float(l_edges[1] - l_edges[0])
    GridClass = getattr(pv, "UniformGrid", None) or getattr(pv, "ImageData", None)
    grid = GridClass()
    grid.dimensions = (nx + 1, ny + 1, nz + 1)
    grid.spacing = (dx, dy, dz)
    grid.origin = (float(n_edges[0]), float(m_edges[0]), float(l_edges[0]))
    grid.cell_data["scalar"] = field.ravel(order="F")
    return grid.cell_data_to_point_data()


def plot_pyvista(comtails, sim, field_name, log10=True, clim=None, save_path=None, show=True, show_diff=False):
    import pyvista as pv

    c_field = prep(comtails[field_name], log10)
    s_field = prep(sim[field_name], log10)
    if clim is None:
        vmin = float(min(np.nanmin(c_field), np.nanmin(s_field)))
        vmax = float(max(np.nanmax(c_field), np.nanmax(s_field)))
        clim = (vmin, vmax)

    edges = (comtails["n_edges_km"], comtails["m_edges_km"], comtails["l_edges_km"])
    ncols = 3 if show_diff else 2
    p = pv.Plotter(shape=(1, ncols), off_screen=save_path is not None, window_size=(520 * ncols, 520))

    p.subplot(0, 0)
    p.add_volume(_pv_grid(c_field, *edges), scalars="scalar", opacity="sigmoid", shade=False, clim=clim, cmap="inferno")
    p.add_text(f"COMTAILS — {field_name}", font_size=10)
    p.add_axes()
    p.show_bounds(grid="back", location="outer", xtitle="n (km)", ytitle="m (km)", ztitle="l (km)")

    p.subplot(0, 1)
    p.add_volume(_pv_grid(s_field, *edges), scalars="scalar", opacity="sigmoid", shade=False, clim=clim, cmap="inferno")
    p.add_text(f"comet_tail_simulation — {field_name}", font_size=10)
    p.add_axes()
    p.show_bounds(grid="back", location="outer", xtitle="n (km)", ytitle="m (km)", ztitle="l (km)")

    if show_diff:
        diff = s_field - c_field
        dmax = float(np.nanmax(np.abs(diff))) or 1.0
        p.subplot(0, 2)
        p.add_volume(_pv_grid(diff, *edges), scalars="scalar", opacity="sigmoid", shade=False, clim=(-dmax, dmax), cmap="coolwarm")
        p.add_text("sim - COMTAILS", font_size=10)
        p.add_axes()
        p.show_bounds(grid="back", location="outer", xtitle="n (km)", ytitle="m (km)", ztitle="l (km)")

    p.link_views()
    if save_path:
        p.screenshot(str(save_path))
        print(f"Wrote {save_path}")
        p.close()
    elif show:
        p.show()


# ─── Matplotlib: slice grid (COMTAILS / sim / diff) ───────────────────────────

def plot_slices(comtails, sim, field_name, log10=True, save_path=None, show=True, smooth_sigma=0.0):
    import matplotlib.pyplot as plt

    c_field = comtails[field_name].astype(np.float64)
    s_field = sim[field_name].astype(np.float64)
    # Smooth BOTH cubes equally so the figure isn't dominated by COMTAILS' sparse
    # outer-halo shot noise (the comparison is shape-based; treat them identically).
    if smooth_sigma > 0:
        from scipy.ndimage import gaussian_filter
        c_field = gaussian_filter(c_field, sigma=smooth_sigma)
        s_field = gaussian_filter(s_field, sigma=smooth_sigma)

    c = prep(c_field, log10)
    s = prep(s_field, log10)
    # The sim is RELATIVE density and COMTAILS ABSOLUTE (~10 orders apart), so a
    # raw difference just shows that offset. Normalize each to unit sum first,
    # then take log10(sim/COMTAILS): 0 = same shape locally, + = sim has
    # relatively more dust here, - = less. 0/0 and x/0 voxels are masked (grey).
    cN = c_field / np.nansum(c_field)
    sN = s_field / np.nansum(s_field)
    with np.errstate(divide="ignore", invalid="ignore"):
        diff = np.log10(sN / cN)
    diff[~np.isfinite(diff)] = np.nan
    diff = np.clip(diff, -2, 2)

    n_edges, m_edges, l_edges = comtails["n_edges_km"], comtails["m_edges_km"], comtails["l_edges_km"]
    nx, ny, nz = c.shape
    i, j, k = nx // 2, ny // 2, nz // 2

    extents = [
        (float(n_edges[0]), float(n_edges[-1]), float(m_edges[0]), float(m_edges[-1]), "n (km)", "m (km)"),
        (float(m_edges[0]), float(m_edges[-1]), float(l_edges[0]), float(l_edges[-1]), "m (km)", "l (km)"),
        (float(n_edges[0]), float(n_edges[-1]), float(l_edges[0]), float(l_edges[-1]), "n (km)", "l (km)"),
    ]

    def slices_of(arr):
        return [arr[:, :, k].T, arr[i, :, :].T, arr[:, j, :].T]

    import matplotlib.cm as cm
    div = cm.get_cmap("coolwarm").copy()
    div.set_bad("0.8")  # masked (one cube empty here) shows grey, not a false extreme
    rows = [("COMTAILS", slices_of(c), "inferno", None), ("comet_tail_simulation", slices_of(s), "inferno", None)]
    rows.append(("log10(sim/COMTAILS), unit-sum", slices_of(diff), div, (-2, 2)))

    fig, axs = plt.subplots(3, 3, figsize=(13, 11), constrained_layout=True)
    for r, (label, panels, cmap, clim) in enumerate(rows):
        for col, (panel, (xmin, xmax, ymin, ymax, xl, yl)) in enumerate(zip(panels, extents)):
            ax = axs[r, col]
            im = ax.imshow(panel, origin="lower", extent=[xmin, xmax, ymin, ymax], aspect="auto", cmap=cmap)
            if clim:
                im.set_clim(*clim)
            if col == 0:
                ax.set_ylabel(label, fontsize=11, fontweight="bold")
            ax.set_xlabel(xl)
            if col == 0:
                ax.set_ylabel(yl + "\n\n" + label)
            fig.colorbar(im, ax=ax, shrink=0.8)
    fig.suptitle(f"{field_name} mid-plane slices" + (" (log10)" if log10 else ""))

    if save_path:
        fig.savefig(save_path, dpi=150)
        print(f"Wrote {save_path}")
        plt.close(fig)
    elif show:
        plt.show()


# ─── Matplotlib: max-intensity projections ────────────────────────────────────

def plot_mip(comtails, sim, field_name, log10=True, save_path=None, show=True):
    import matplotlib.pyplot as plt

    n_edges, m_edges, l_edges = comtails["n_edges_km"], comtails["m_edges_km"], comtails["l_edges_km"]

    def mips_of(arr):
        return [np.max(arr, axis=2), np.max(arr, axis=0).T, np.max(arr, axis=1).T]

    extents = [
        (float(n_edges[0]), float(n_edges[-1]), float(m_edges[0]), float(m_edges[-1]), "n (km)", "m (km)", "MIP along l"),
        (float(m_edges[0]), float(m_edges[-1]), float(l_edges[0]), float(l_edges[-1]), "m (km)", "l (km)", "MIP along n"),
        (float(n_edges[0]), float(n_edges[-1]), float(l_edges[0]), float(l_edges[-1]), "n (km)", "l (km)", "MIP along m"),
    ]

    c_mips = mips_of(prep(comtails[field_name], log10))
    s_mips = mips_of(prep(sim[field_name], log10))

    fig, axs = plt.subplots(2, 3, figsize=(13, 8), constrained_layout=True)
    for row, (label, mips) in enumerate([("COMTAILS", c_mips), ("comet_tail_simulation", s_mips)]):
        for col, (panel, (xmin, xmax, ymin, ymax, xl, yl, ttl)) in enumerate(zip(mips, extents)):
            ax = axs[row, col]
            im = ax.imshow(panel, origin="lower", extent=[xmin, xmax, ymin, ymax], aspect="auto", cmap="inferno")
            ax.set_title(ttl if row == 0 else "")
            ax.set_xlabel(xl)
            ax.set_ylabel((yl + "\n" + label) if col == 0 else yl)
            fig.colorbar(im, ax=ax, shrink=0.8)
    fig.suptitle(f"{field_name} max-intensity projections" + (" (log10)" if log10 else ""))

    if save_path:
        fig.savefig(save_path, dpi=150)
        print(f"Wrote {save_path}")
        plt.close(fig)
    elif show:
        plt.show()


# ─── Matplotlib: per-voxel correlation scatter ────────────────────────────────

def plot_scatter(comtails, sim, field_name, save_path=None, show=True, max_points=40000):
    import matplotlib.pyplot as plt

    x = comtails[field_name].ravel()
    y = sim[field_name].ravel()
    mask = np.isfinite(x) & np.isfinite(y) & (x > 0) & (y > 0)
    x, y = x[mask], y[mask]

    if len(x) > max_points:
        idx = np.random.default_rng(0).choice(len(x), size=max_points, replace=False)
        x, y = x[idx], y[idx]

    r_lin = float(np.corrcoef(x, y)[0, 1]) if len(x) > 1 else float("nan")
    r_log = float(np.corrcoef(np.log10(x), np.log10(y))[0, 1]) if len(x) > 1 else float("nan")

    fig, ax = plt.subplots(figsize=(6, 6))
    ax.scatter(x, y, s=4, alpha=0.25, color="#1d3557")
    lo = min(x.min(), y.min())
    hi = max(x.max(), y.max())
    ax.plot([lo, hi], [lo, hi], "r--", linewidth=1, label="1:1")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel(f"COMTAILS {field_name}")
    ax.set_ylabel(f"comet_tail_simulation {field_name}")
    ax.set_title(f"{field_name}: Pearson r = {r_lin:.3f} (linear), {r_log:.3f} (log10)")
    ax.legend()
    fig.tight_layout()

    if save_path:
        fig.savefig(save_path, dpi=150)
        print(f"Wrote {save_path}")
        plt.close(fig)
    elif show:
        plt.show()


# ─── Matplotlib: radial + along-tail profiles ─────────────────────────────────

def plot_profiles(comtails, sim, field_name, save_path=None, show=True, nbins=30):
    import matplotlib.pyplot as plt

    n_c, m_c, l_c = centers(comtails["n_edges_km"]), centers(comtails["m_edges_km"]), centers(comtails["l_edges_km"])
    N, M, L = np.meshgrid(n_c, m_c, l_c, indexing="ij")
    r = np.sqrt(N ** 2 + M ** 2 + L ** 2)

    c_field = comtails[field_name]
    s_field = sim[field_name]

    def radial_profile(field):
        rmax = r.max()
        edges = np.geomspace(max(r[r > 0].min(), 1.0), rmax, nbins + 1)
        mids = np.sqrt(edges[:-1] * edges[1:])
        means = np.full(nbins, np.nan)
        for b in range(nbins):
            sel = (r >= edges[b]) & (r < edges[b + 1])
            if sel.any():
                means[b] = field[sel].mean()
        return mids, means

    def along_tail_profile(field):
        # mean over n,l at each m (along-tail coordinate)
        return m_c, field.mean(axis=(0, 2))

    rc_mid, rc_mean = radial_profile(c_field)
    rs_mid, rs_mean = radial_profile(s_field)
    mc_mid, mc_mean = along_tail_profile(c_field)
    ms_mid, ms_mean = along_tail_profile(s_field)

    # Peak-normalize each curve: the sim is relative and COMTAILS absolute, so
    # only the SHAPE of the falloff is comparable. Overlaying the normalized
    # profiles shows directly where the two density gradients diverge.
    def unit_peak(a):
        mx = np.nanmax(a)
        return a / mx if mx and np.isfinite(mx) and mx > 0 else a
    rc_mean, rs_mean = unit_peak(rc_mean), unit_peak(rs_mean)
    mc_mean, ms_mean = unit_peak(mc_mean), unit_peak(ms_mean)

    fig, axs = plt.subplots(1, 2, figsize=(12, 5))
    axs[0].plot(rc_mid, rc_mean, "o-", label="COMTAILS", color="#1d3557")
    axs[0].plot(rs_mid, rs_mean, "s-", label="comet_tail_simulation", color="#e76f51")
    axs[0].set_xscale("log"); axs[0].set_yscale("log")
    axs[0].set_xlabel("distance from nucleus, |r| (km)")
    axs[0].set_ylabel(f"{field_name} (peak-normalized)")
    axs[0].set_title("Radial falloff (mean over shell)")
    axs[0].legend()

    axs[1].plot(mc_mid, mc_mean, "o-", label="COMTAILS", color="#1d3557")
    axs[1].plot(ms_mid, ms_mean, "s-", label="comet_tail_simulation", color="#e76f51")
    axs[1].set_yscale("log")
    axs[1].set_xlabel("m — along-tail / radial (km)")
    axs[1].set_ylabel(f"{field_name} (peak-normalized)")
    axs[1].set_title("Along-tail profile (mean over n,l)")
    axs[1].legend()

    fig.suptitle(f"{field_name} profiles")
    fig.tight_layout()

    if save_path:
        fig.savefig(save_path, dpi=150)
        print(f"Wrote {save_path}")
        plt.close(fig)
    elif show:
        plt.show()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--comtails", type=Path, default=DEFAULT_COMTAILS)
    ap.add_argument("--sim-meta", type=Path, default=DEFAULT_SIM_META)
    ap.add_argument("--field", choices=["rho_mass", "rho_num"], default="rho_num")
    ap.add_argument("--mode", choices=["pyvista", "slices", "mip", "scatter", "profiles", "all"], default="all")
    ap.add_argument("--linear", action="store_true", help="plot in linear scale instead of log10 (slices/mip/pyvista)")
    ap.add_argument("--show-diff", action="store_true", help="(pyvista) add a third sim-minus-COMTAILS panel")
    ap.add_argument("--save-dir", type=Path, default=None, help="save PNGs/screenshot here instead of/alongside showing")
    ap.add_argument("--show", action="store_true", help="also open interactive windows")
    ap.add_argument("--smooth-sigma", type=float, default=0.0, help="Gaussian blur sigma (voxels) applied to the sim cube before slicing — reduces shot-noise black spots (0 = off)")
    args = ap.parse_args()

    comtails, sim = load_pair(args.comtails, args.sim_meta)

    # The GPU-readback sim cube is number density only (no mass bake). Fall back
    # to rho_num if the requested field isn't present in both cubes.
    if args.field not in sim or args.field not in comtails:
        if "rho_num" in sim and "rho_num" in comtails:
            print(f"Field '{args.field}' not in both cubes — falling back to 'rho_num'.")
            args.field = "rho_num"
        else:
            raise SystemExit(f"Neither '{args.field}' nor a common 'rho_num' present in both cubes.")

    log10 = not args.linear

    save_dir = args.save_dir
    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)
    show = args.show or save_dir is None

    modes = ["pyvista", "slices", "mip", "scatter", "profiles"] if args.mode == "all" else [args.mode]

    for mode in modes:
        save_path = (save_dir / f"{mode}_{args.field}.png") if save_dir else None
        if mode == "pyvista":
            save_path = (save_dir / f"pyvista_{args.field}.png") if save_dir else None
            plot_pyvista(comtails, sim, args.field, log10=log10, save_path=save_path, show=show, show_diff=args.show_diff)
        elif mode == "slices":
            plot_slices(comtails, sim, args.field, log10=log10, save_path=save_path, show=show, smooth_sigma=args.smooth_sigma)
        elif mode == "mip":
            plot_mip(comtails, sim, args.field, log10=log10, save_path=save_path, show=show)
        elif mode == "scatter":
            plot_scatter(comtails, sim, args.field, save_path=save_path, show=show)
        elif mode == "profiles":
            plot_profiles(comtails, sim, args.field, save_path=save_path, show=show)


if __name__ == "__main__":
    main()
