#!/usr/bin/env python3
"""
view_tail_export.py — visualize a density cube exported from the JS comet sim.

Mirrors visualize_density_cube.py exactly so results are directly comparable.

Usage:
  python view_tail_export.py                          # auto-detect latest export
  python view_tail_export.py --cube density_cube_JD2457329.47_64_meta.json
  python view_tail_export.py --mode mip --log10
  python view_tail_export.py --mode pyvista --iso --log10
  python view_tail_export.py --mode slices --log10 --clim -4 0
"""

import argparse, glob, os, json
import numpy as np


# ── Loader ────────────────────────────────────────────────────────────────────

def load_cube(meta_path):
    """Return (rho_num, n_edges, m_edges, l_edges, meta) all in km."""
    with open(meta_path) as f:
        meta = json.load(f)

    # Derive the .npy path from the meta file path
    base = meta_path.replace('_meta.json', '')
    rho_num = np.load(f'{base}_rho_num.npy')

    n_edges = np.array(meta['n_edges_km'], dtype=np.float64)
    m_edges = np.array(meta['m_edges_km'], dtype=np.float64)
    l_edges = np.array(meta['l_edges_km'], dtype=np.float64)

    return rho_num, n_edges, m_edges, l_edges, meta


def find_latest_meta():
    candidates = glob.glob('density_cube_*_meta.json')
    if not candidates:
        raise FileNotFoundError('No density_cube_*_meta.json found in current directory.')
    return max(candidates, key=os.path.getmtime)


# ── Shared helpers (identical to visualize_density_cube.py) ───────────────────

def trim_to_data(rho, n_edges, m_edges, l_edges):
    """Crop grid to the bounding box of occupied voxels so PyVista fills the window."""
    nz_mask = rho > 0
    if not nz_mask.any():
        return rho, n_edges, m_edges, l_edges
    ni, mi, li = np.where(nz_mask)
    n0, n1 = ni.min(), ni.max() + 1
    m0, m1 = mi.min(), mi.max() + 1
    l0, l1 = li.min(), li.max() + 1
    return (rho[n0:n1, m0:m1, l0:l1],
            n_edges[n0:n1+1], m_edges[m0:m1+1], l_edges[l0:l1+1])


def prepare_field(rho, use_log10, mask_empty=False):
    """Convert rho to display field. If mask_empty, zero voxels become NaN
    (useful for PyVista so empty space is fully transparent and doesn't
    distort the opacity range or camera fitting)."""
    if not use_log10:
        out = rho.astype(np.float64)
    else:
        with np.errstate(divide='ignore', invalid='ignore'):
            out = np.where(rho > 0, np.log10(rho), np.nan)
    if mask_empty:
        out = np.where(rho > 0, out, np.nan)
    return out


# ── Data analysis ─────────────────────────────────────────────────────────────

def analyze_cube(rho, n_edges, m_edges, l_edges, meta):
    import matplotlib.pyplot as plt

    total_voxels = rho.size
    occ = rho > 0
    n_occ = int(occ.sum())
    fill_pct = 100.0 * n_occ / total_voxels

    vox_n = float(n_edges[1] - n_edges[0])
    vox_m = float(m_edges[1] - m_edges[0])
    vox_l = float(l_edges[1] - l_edges[0])

    print(f"\n{'='*60}")
    print(f"  Cube: {meta.get('stem','?')}")
    print(f"  JD {meta.get('jd','?'):.2f}   particles exported: {meta.get('particlesExported','?')}")
    print(f"  Grid: {rho.shape[0]}³   total voxels: {total_voxels:,}")
    print(f"  Occupied voxels: {n_occ:,}  ({fill_pct:.2f}%)")
    print(f"  Voxel size: n={vox_n:.1f} km  m={vox_m:.1f} km  l={vox_l:.1f} km")
    print(f"  Domain (km):")
    print(f"    n: [{n_edges[0]:.0f}, {n_edges[-1]:.0f}]  span={n_edges[-1]-n_edges[0]:.0f}")
    print(f"    m: [{m_edges[0]:.0f}, {m_edges[-1]:.0f}]  span={m_edges[-1]-m_edges[0]:.0f}")
    print(f"    l: [{l_edges[0]:.0f}, {l_edges[-1]:.0f}]  span={l_edges[-1]-l_edges[0]:.0f}")

    rho_occ = rho[occ]
    print(f"  Density (particles/km³) in occupied voxels:")
    print(f"    min={rho_occ.min():.3e}  max={rho_occ.max():.3e}  mean={rho_occ.mean():.3e}")
    log_vals = np.log10(rho_occ)
    print(f"  log10 density range: [{log_vals.min():.2f}, {log_vals.max():.2f}]")
    for p in [10, 25, 50, 75, 90, 99]:
        print(f"    p{p:02d}: {np.percentile(log_vals, p):.2f}")

    # Trim and report non-zero extent
    rho_t, ne_t, me_t, le_t = trim_to_data(rho, n_edges, m_edges, l_edges)
    print(f"\n  Trimmed (non-zero) extent (km):")
    print(f"    n: [{ne_t[0]:.0f}, {ne_t[-1]:.0f}]  span={ne_t[-1]-ne_t[0]:.0f}  voxels={rho_t.shape[0]}")
    print(f"    m: [{me_t[0]:.0f}, {me_t[-1]:.0f}]  span={me_t[-1]-me_t[0]:.0f}  voxels={rho_t.shape[1]}")
    print(f"    l: [{le_t[0]:.0f}, {le_t[-1]:.0f}]  span={le_t[-1]-le_t[0]:.0f}  voxels={rho_t.shape[2]}")
    print(f"{'='*60}\n")

    fig, axes = plt.subplots(1, 2, figsize=(12, 4), constrained_layout=True)

    axes[0].hist(log_vals, bins=60, color='steelblue', edgecolor='none')
    axes[0].set_xlabel('log10(density)  [particles/km³]')
    axes[0].set_ylabel('voxel count')
    axes[0].set_title('Density distribution (occupied voxels)')

    mip = np.max(rho, axis=2)   # n-m plane
    mip_log = np.log10(np.clip(mip, mip[mip > 0].min() * 1e-6 if (mip > 0).any() else 1e-30, None))
    im = axes[1].imshow(mip_log.T, origin='lower',
                        extent=[n_edges[0], n_edges[-1], m_edges[0], m_edges[-1]],
                        aspect='auto', cmap='viridis')
    axes[1].set_xlabel('n — cross-tail (km)')
    axes[1].set_ylabel('m — along-tail (km)')
    axes[1].set_title('MIP n-m plane (log10)')
    plt.colorbar(im, ax=axes[1], label='log10(particles/km³)')

    plt.suptitle(meta.get('stem', ''))
    plt.show()


# ── Visualization modes (same logic as visualize_density_cube.py) ─────────────

def show_slices(rho, n_edges, m_edges, l_edges, title='', clim=None, use_log10=False):
    import matplotlib.pyplot as plt

    rho, n_edges, m_edges, l_edges = trim_to_data(rho, n_edges, m_edges, l_edges)
    data = prepare_field(rho, use_log10)
    nx, ny, nz = data.shape
    i, j, k = nx // 2, ny // 2, nz // 2

    nmin, nmax = float(n_edges[0]), float(n_edges[-1])
    mmin, mmax = float(m_edges[0]), float(m_edges[-1])
    lmin, lmax = float(l_edges[0]), float(l_edges[-1])

    fig, axs = plt.subplots(1, 3, figsize=(14, 4), constrained_layout=True)

    im0 = axs[0].imshow(data[:, :, k].T, origin='lower',
                        extent=[nmin, nmax, mmin, mmax], aspect='equal')
    axs[0].set_title(f'Slice l @ k={k}')
    axs[0].set_xlabel('n — cross-tail (km)')
    axs[0].set_ylabel('m — along-tail (km)')

    im1 = axs[1].imshow(data[i, :, :].T, origin='lower',
                        extent=[mmin, mmax, lmin, lmax], aspect='auto')
    axs[1].set_title(f'Slice n @ i={i}')
    axs[1].set_xlabel('m — along-tail (km)')
    axs[1].set_ylabel('l — out-of-plane (km)')

    im2 = axs[2].imshow(data[:, j, :].T, origin='lower',
                        extent=[nmin, nmax, lmin, lmax], aspect='auto')
    axs[2].set_title(f'Slice m @ j={j}')
    axs[2].set_xlabel('n — cross-tail (km)')
    axs[2].set_ylabel('l — out-of-plane (km)')

    if clim is not None:
        for im in [im0, im1, im2]:
            im.set_clim(*clim)

    cbar = fig.colorbar(im0, ax=axs.ravel().tolist(), shrink=0.85)
    cbar.set_label('log10(particles/km³)' if use_log10 else 'particles/km³')
    if title:
        fig.suptitle(title)
    plt.show()


def show_mip(rho, n_edges, m_edges, l_edges, title='', clim=None, use_log10=False):
    import matplotlib.pyplot as plt

    rho, n_edges, m_edges, l_edges = trim_to_data(rho, n_edges, m_edges, l_edges)
    mip_nm = np.max(rho, axis=2)   # project along l → n-m plane
    mip_ml = np.max(rho, axis=0)   # project along n → m-l plane
    mip_nl = np.max(rho, axis=1)   # project along m → n-l plane

    nmin, nmax = float(n_edges[0]), float(n_edges[-1])
    mmin, mmax = float(m_edges[0]), float(m_edges[-1])
    lmin, lmax = float(l_edges[0]), float(l_edges[-1])

    panels = [
        (mip_nm,   (nmin, nmax, mmin, mmax), 'MIP along l  (n–m plane)',
         'n — cross-tail (km)', 'm — along-tail (km)'),
        (mip_ml.T, (mmin, mmax, lmin, lmax), 'MIP along n  (m–l plane)',
         'm — along-tail (km)', 'l — out-of-plane (km)'),
        (mip_nl.T, (nmin, nmax, lmin, lmax), 'MIP along m  (n–l plane)',
         'n — cross-tail (km)', 'l — out-of-plane (km)'),
    ]

    fig, axs = plt.subplots(1, 3, figsize=(14, 4), constrained_layout=True)
    for ax, (img, extent, ttl, xl, yl) in zip(axs, panels):
        disp = prepare_field(img, use_log10)
        im = ax.imshow(disp, origin='lower', extent=extent,
                       aspect='equal' if 'n–m' in ttl else 'auto')
        ax.set_title(ttl)
        ax.set_xlabel(xl)
        ax.set_ylabel(yl)
        if clim is not None:
            im.set_clim(*clim)

    cbar = fig.colorbar(axs[0].images[0], ax=axs.ravel().tolist(), shrink=0.85)
    cbar.set_label('log10(particles/km³)' if use_log10 else 'particles/km³')
    if title:
        fig.suptitle(title)
    plt.show()


def show_pyvista(rho, n_edges, m_edges, l_edges, title='',
                 use_log10=False, clim=None, iso=False,
                 show_bounds=False, units='km'):
    try:
        import pyvista as pv
    except ImportError:
        print('PyVista not available — pip install pyvista vtk')
        raise

    rho, n_edges, m_edges, l_edges = trim_to_data(rho, n_edges, m_edges, l_edges)

    AU_KM = 149_597_870.7
    sf = 1.0 / AU_KM if units.lower() == 'au' else 1.0
    unit_lbl = 'AU' if units.lower() == 'au' else 'km'

    n_ax = n_edges * sf
    m_ax = m_edges * sf
    l_ax = l_edges * sf

    # mask_empty=True → zero voxels become NaN → fully transparent in PyVista,
    # and the auto clim spans only the real data range (not the -23 log10 floor)
    field = prepare_field(rho, use_log10, mask_empty=True)
    nx, ny, nz = field.shape
    dx = float(n_ax[1] - n_ax[0])
    dy = float(m_ax[1] - m_ax[0])
    dz = float(l_ax[1] - l_ax[0])
    origin = (float(n_ax[0]), float(m_ax[0]), float(l_ax[0]))

    GridClass = getattr(pv, 'UniformGrid', None) or getattr(pv, 'ImageData', None)
    grid = GridClass()
    grid.dimensions = (nx + 1, ny + 1, nz + 1)
    grid.spacing = (dx, dy, dz)
    grid.origin = origin
    # Replace NaN with a sentinel below real data so PyVista can ingest the array;
    # clim will be set explicitly to the real data range, keeping sentinels transparent
    valid = field[np.isfinite(field)]
    auto_min = float(np.nanmin(valid)) if valid.size else -20.0
    auto_max = float(np.nanmax(valid)) if valid.size else -10.0
    sentinel = auto_min - abs(auto_max - auto_min) * 2   # well below data
    field_safe = np.where(np.isfinite(field), field, sentinel)
    if clim is None:
        clim = (auto_min, auto_max)
    print(f'Data log10 range: [{auto_min:.2f}, {auto_max:.2f}]  →  clim={clim}')
    grid.cell_data['scalar'] = field_safe.ravel(order='F')

    xmin, xmax, ymin, ymax, zmin, zmax = grid.bounds
    print(f'Extents ({unit_lbl}):  n:[{xmin:.3f}, {xmax:.3f}]  '
          f'm:[{ymin:.3f}, {ymax:.3f}]  l:[{zmin:.3f}, {zmax:.3f}]')

    grid_pt = grid.cell_data_to_point_data()
    p = pv.Plotter()
    p.add_axes()

    if show_bounds:
        kw = dict(bounds=grid.bounds, grid='back', location='outer')
        try:
            p.show_bounds(xtitle=f'n ({unit_lbl})',
                          ytitle=f'm ({unit_lbl})',
                          ztitle=f'l ({unit_lbl})', **kw)
        except TypeError:
            p.show_bounds(xlabel=f'n ({unit_lbl})',
                          ylabel=f'm ({unit_lbl})',
                          zlabel=f'l ({unit_lbl})', **kw)
    else:
        p.add_bounding_box()

    try:
        vol = p.add_volume(grid_pt, scalars='scalar', opacity='sigmoid',
                           shade=False, clim=clim)
    except TypeError:
        vol = p.add_volume(grid_pt, scalars='scalar', clim=clim)

    if iso:
        try:
            v90 = float(np.nanpercentile(field, 90.0))
            p.add_mesh(grid_pt.contour([v90]), opacity=0.35)
        except Exception:
            pass

    p.add_text(title or ('log10' if use_log10 else 'linear'), font_size=12)
    p.reset_camera()
    p.show()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cube', default=None,
                    help='Path to *_meta.json (default: latest in cwd)')
    ap.add_argument('--mode', choices=['auto', 'pyvista', 'slices', 'mip'],
                    default='auto')
    ap.add_argument('--log10', action='store_true')
    ap.add_argument('--clim', nargs=2, type=float, metavar=('VMIN', 'VMAX'))
    ap.add_argument('--iso', action='store_true',
                    help='(pyvista) add 90th-percentile isosurface')
    ap.add_argument('--show-bounds', action='store_true')
    ap.add_argument('--units', choices=['km', 'au'], default='km')
    ap.add_argument('--analyze', action='store_true',
                    help='Print statistics + show density histogram and MIP; skip 3-D render')
    args = ap.parse_args()

    meta_path = args.cube or find_latest_meta()
    rho, n_edges, m_edges, l_edges, meta = load_cube(meta_path)

    if args.analyze:
        analyze_cube(rho, n_edges, m_edges, l_edges, meta)
        return

    title = (f"JD {meta.get('jd', '?'):.2f}  |  "
             f"{meta.get('particlesExported', '?')} particles  |  "
             f"{meta.get('gridN', '?')}³ grid  |  "
             f"{'log10' if args.log10 else 'linear'}")

    mode = args.mode
    if mode == 'auto':
        try:
            import pyvista  # noqa: F401
            mode = 'pyvista'
        except ImportError:
            mode = 'slices'

    clim = tuple(args.clim) if args.clim else None

    if mode == 'pyvista':
        show_pyvista(rho, n_edges, m_edges, l_edges, title=title,
                     use_log10=args.log10, clim=clim, iso=args.iso,
                     show_bounds=args.show_bounds, units=args.units)
    elif mode == 'slices':
        show_slices(rho, n_edges, m_edges, l_edges, title=title,
                    clim=clim, use_log10=args.log10)
    elif mode == 'mip':
        show_mip(rho, n_edges, m_edges, l_edges, title=title,
                 clim=clim, use_log10=args.log10)


if __name__ == '__main__':
    main()
