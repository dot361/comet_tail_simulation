#!/usr/bin/env python3
"""Create publication-style observed-versus-synthetic comet-tail isophote figures.

The observed telescope image and the synthetic particle cloud are resampled into
one local sky-plane frame with north up and east left. The user clicks an
approximate observed nucleus position; the program refines that click locally,
aligns the synthetic nucleus to it, and extracts comet-associated contours.

This is a relative morphology comparison. It is not absolute photometry.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch
from matplotlib.path import Path as MplPath
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.ndimage import gaussian_filter, map_coordinates
from skimage import measure
from skimage.draw import polygon


# Generic defaults for a relative-morphology comparison.  They deliberately
# live in the utility rather than in a comet-specific JSON file, so the project
# remains reusable and clean.  Expert users can still override them with the
# optional --config command-line argument.
DEFAULT_CONFIG = {
    "outputWidthPx": 700,
    "outputHeightPx": 520,
    "outputPixelScaleArcsec": 1.012,
    "nucleusRefineRadiusPx": 18,
    "observedBackgroundSigmaPx": 55,
    "observedSmoothSigmaPx": 2.6,
    "innerComaMaskRadiusPx": 18,
    "observedNoiseSigmaMultipliers": [2.5, 4, 6, 10, 16, 28],
    "observedContourAssociationRadiusPx": 55,
    "syntheticSmoothSigmaPx": 2.8,
    "syntheticCoreFluxFraction": 0.0,
    "syntheticCoreSigmaPx": 2.8,
    "syntheticWeightColumn": "brightness_weight",
    "syntheticPeakPercentile": 99.8,
    "syntheticLevelMode": "fixed_fraction",
    "syntheticLevelFractions": [0.035, 0.065, 0.12, 0.22, 0.40, 0.65],
    "syntheticAreaMatchSearchSteps": 180,
    "syntheticContourAssociationRadiusPx": 65,
    "minimumUsefulObservedTailExtentArcsec": 45,
    "minContourPoints": 16,
    "panelColumns": 3,
}


@dataclass
class Inputs:
    observed_fits: Path
    particles_csv: Path
    meta_json: Path
    config_json: Path | None
    out_dir: Path
    nucleus_x: float | None = None
    nucleus_y: float | None = None


def read_particles(path: Path) -> Dict[str, np.ndarray]:
    columns: Dict[str, List[float]] = {}
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError("Simulation CSV has no header")
        for name in reader.fieldnames:
            columns[name] = []
        for row in reader:
            for name in reader.fieldnames:
                try:
                    columns[name].append(float(row[name]))
                except (ValueError, TypeError):
                    columns[name].append(float("nan"))
    required = {"ra_deg", "dec_deg", "beta", "brightness_weight"}
    missing = required.difference(columns)
    if missing:
        raise ValueError(f"Simulation CSV missing columns: {', '.join(sorted(missing))}")
    return {k: np.asarray(v, dtype=float) for k, v in columns.items()}


def finite_fill(image: np.ndarray) -> np.ndarray:
    data = np.asarray(image, dtype=float).copy()
    finite = np.isfinite(data)
    fill = float(np.nanmedian(data[finite])) if finite.any() else 0.0
    data[~finite] = fill
    return data


def asinh_preview(image: np.ndarray, lo_pct: float = 2.0, hi_pct: float = 99.8) -> np.ndarray:
    data = finite_fill(image)
    lo, hi = np.percentile(data, [lo_pct, hi_pct])
    if not hi > lo:
        hi = lo + 1.0
    scaled = np.clip((data - lo) / (hi - lo), 0.0, None)
    return np.arcsinh(8.0 * scaled) / np.arcsinh(8.0)


def choose_observed_nucleus(image: np.ndarray, title: str) -> Tuple[float, float]:
    preview = asinh_preview(image)
    fig, ax = plt.subplots(figsize=(10, 10), constrained_layout=True)
    ax.imshow(preview, cmap="gray", origin="lower", interpolation="nearest", vmin=0, vmax=1)
    ax.set_title(title + "\nClick approximately on the observed comet nucleus once.")
    ax.set_xlabel("image x [px]")
    ax.set_ylabel("image y [px]")
    pts = plt.ginput(1, timeout=-1, show_clicks=True)
    plt.close(fig)
    if len(pts) != 1:
        raise RuntimeError("No observed nucleus point was selected")
    return float(pts[0][0]), float(pts[0][1])


def refine_nucleus(image: np.ndarray, click_x: float, click_y: float, radius_px: int) -> Tuple[float, float]:
    """Refine an approximate click with a clipped local intensity centroid."""
    data = finite_fill(image)
    h, w = data.shape
    r = max(4, int(radius_px))
    x0, x1 = max(0, int(round(click_x)) - r), min(w, int(round(click_x)) + r + 1)
    y0, y1 = max(0, int(round(click_y)) - r), min(h, int(round(click_y)) + r + 1)
    patch = data[y0:y1, x0:x1]
    if patch.size == 0:
        return click_x, click_y
    bg = float(np.percentile(patch, 25))
    weights = np.clip(patch - bg, 0.0, None)
    positive = weights[weights > 0]
    if positive.size == 0:
        return click_x, click_y
    cap = float(np.percentile(positive, 97.5))
    if cap > 0:
        weights = np.minimum(weights, cap)
    yy, xx = np.indices(patch.shape, dtype=float)
    total = float(weights.sum())
    if not total > 0:
        return click_x, click_y
    return float(x0 + (xx * weights).sum() / total), float(y0 + (yy * weights).sum() / total)


def wrap_ra_delta_deg(delta: np.ndarray | float) -> np.ndarray | float:
    return (np.asarray(delta) + 180.0) % 360.0 - 180.0


def local_sky_image(
    data: np.ndarray,
    wcs: WCS,
    center_ra_deg: float,
    center_dec_deg: float,
    width_px: int,
    height_px: int,
    pixel_scale_arcsec: float,
) -> np.ndarray:
    """Resample FITS into a local standard frame: north up, east left."""
    cy = (height_px - 1) / 2.0
    cx = (width_px - 1) / 2.0
    yy, xx = np.indices((height_px, width_px), dtype=float)
    dx_arcsec = (xx - cx) * pixel_scale_arcsec
    dy_arcsec = (yy - cy) * pixel_scale_arcsec
    cos_dec = max(1e-8, math.cos(math.radians(center_dec_deg)))
    ra = center_ra_deg - dx_arcsec / (3600.0 * cos_dec)
    dec = center_dec_deg + dy_arcsec / 3600.0
    world = np.column_stack([ra.ravel(), dec.ravel()])
    src = wcs.all_world2pix(world, 0)
    fill = float(np.nanmedian(data[np.isfinite(data)])) if np.isfinite(data).any() else 0.0
    sampled = map_coordinates(
        finite_fill(data), [src[:, 1], src[:, 0]], order=1, mode="constant", cval=fill
    )
    return sampled.reshape((height_px, width_px))


def project_particles_standard_frame(
    particles: Dict[str, np.ndarray],
    sim_nucleus_ra_deg: float,
    sim_nucleus_dec_deg: float,
    observed_center_dec_deg: float,
    width_px: int,
    height_px: int,
    pixel_scale_arcsec: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """Project relative synthetic sky offsets into the same N-up/E-left frame."""
    cx = (width_px - 1) / 2.0
    cy = (height_px - 1) / 2.0
    dra = wrap_ra_delta_deg(particles["ra_deg"] - sim_nucleus_ra_deg)
    ddec = particles["dec_deg"] - sim_nucleus_dec_deg
    cos_dec = max(1e-8, math.cos(math.radians(observed_center_dec_deg)))
    x = cx - dra * cos_dec * 3600.0 / pixel_scale_arcsec
    y = cy + ddec * 3600.0 / pixel_scale_arcsec
    return x, y


def robust_sigma(values: np.ndarray) -> float:
    vals = np.asarray(values, dtype=float)
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return 0.0
    med = float(np.median(vals))
    mad = float(np.median(np.abs(vals - med)))
    return max(1e-12, 1.4826 * mad)


def observed_tail_signal(
    image: np.ndarray,
    background_sigma_px: float,
    smooth_sigma_px: float,
    inner_mask_radius_px: float,
) -> Tuple[np.ndarray, float]:
    data = finite_fill(image)
    bg = gaussian_filter(data, sigma=max(3.0, float(background_sigma_px)), mode="nearest")
    residual = data - bg
    smoothed = gaussian_filter(residual, sigma=max(0.0, float(smooth_sigma_px)), mode="nearest")
    h, w = data.shape
    yy, xx = np.indices(data.shape, dtype=float)
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    rr = np.hypot(xx - cx, yy - cy)
    # Estimate noise outside the protected inner-coma region and away from edges.
    margin = max(8, int(min(h, w) * 0.04))
    valid = rr >= max(3.0, float(inner_mask_radius_px))
    valid &= (xx >= margin) & (xx < w - margin) & (yy >= margin) & (yy < h - margin)
    sigma = robust_sigma(smoothed[valid])
    return np.clip(smoothed, 0.0, None), sigma


def make_map(x: np.ndarray, y: np.ndarray, weights: np.ndarray, shape: Tuple[int, int]) -> np.ndarray:
    height, width = shape
    good = np.isfinite(x) & np.isfinite(y) & np.isfinite(weights)
    good &= (x >= 0) & (x < width) & (y >= 0) & (y < height) & (weights > 0)
    hist, _, _ = np.histogram2d(y[good], x[good], bins=[height, width], range=[[0, height], [0, width]], weights=weights[good])
    return hist


def add_centered_gaussian_core(image: np.ndarray, flux_fraction: float, sigma_px: float) -> np.ndarray:
    """Add an unresolved nucleus / inner-coma component before contouring.

    The dynamical export contains dust particles, but an observed comet image
    also contains an unresolved central contribution.  ``flux_fraction`` is
    the fraction of final synthetic flux assigned to this centered Gaussian.
    A value of zero disables the component.
    """
    data = np.asarray(image, dtype=float).copy()
    frac = float(np.clip(float(flux_fraction), 0.0, 0.95))
    sigma = max(0.2, float(sigma_px))
    dust_flux = float(np.sum(data[np.isfinite(data) & (data > 0)]))
    if not (frac > 0 and dust_flux > 0):
        return data
    h, w = data.shape
    yy, xx = np.indices(data.shape, dtype=float)
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    core = np.exp(-0.5 * ((xx - cx) ** 2 + (yy - cy) ** 2) / (sigma * sigma))
    core_sum = float(core.sum())
    if not core_sum > 0:
        return data
    core_flux = dust_flux * frac / max(1e-12, 1.0 - frac)
    return data + core * (core_flux / core_sum)


def levels_from_noise(image: np.ndarray, sigma: float, multipliers: Sequence[float]) -> np.ndarray:
    peak = float(np.nanmax(image)) if np.size(image) else 0.0
    if not peak > 0 or not sigma > 0:
        return np.asarray([], dtype=float)
    levels = sorted({float(sigma) * float(m) for m in multipliers if float(m) > 0})
    return np.asarray([v for v in levels if 0 < v < peak * 0.995], dtype=float)


def levels_from_fractions(image: np.ndarray, fractions: Sequence[float], peak_percentile: float) -> np.ndarray:
    vals = image[np.isfinite(image) & (image > 0)]
    if vals.size == 0:
        return np.asarray([], dtype=float)
    peak = float(np.percentile(vals, float(peak_percentile)))
    if not peak > 0:
        peak = float(vals.max())
    levels = sorted({peak * float(f) for f in fractions if 0 < float(f) < 1})
    return np.asarray([v for v in levels if 0 < v < float(vals.max()) * 0.999], dtype=float)


def contour_segments(image: np.ndarray, levels: Sequence[float], min_points: int) -> List[Tuple[float, np.ndarray]]:
    segments: List[Tuple[float, np.ndarray]] = []
    for level in levels:
        for arr in measure.find_contours(image, level=float(level)):
            if arr.shape[0] >= int(min_points):
                segments.append((float(level), arr))
    return segments


def segment_associated_with_nucleus(seg: np.ndarray, nucleus_xy: Tuple[float, float], keep_radius_px: float) -> bool:
    nx, ny = nucleus_xy
    dx = seg[:, 1] - nx
    dy = seg[:, 0] - ny
    if float(np.min(dx * dx + dy * dy)) <= float(keep_radius_px) ** 2:
        return True
    # Closed outer contours may surround the nucleus without coming close to it.
    if seg.shape[0] >= 4 and np.hypot(*(seg[0] - seg[-1])) <= 3.0:
        poly = MplPath(np.column_stack([seg[:, 1], seg[:, 0]]))
        return bool(poly.contains_point((nx, ny)))
    return False


def filter_segments_near_nucleus(
    segments: Iterable[Tuple[float, np.ndarray]], nucleus_xy: Tuple[float, float], keep_radius_px: float
) -> List[Tuple[float, np.ndarray]]:
    return [(level, seg) for level, seg in segments if segment_associated_with_nucleus(seg, nucleus_xy, keep_radius_px)]


def segment_area_px2(seg: np.ndarray) -> float:
    if seg.shape[0] < 3:
        return 0.0
    x = np.asarray(seg[:, 1], dtype=float)
    y = np.asarray(seg[:, 0], dtype=float)
    return abs(float(0.5 * np.sum(x * np.roll(y, -1) - y * np.roll(x, -1))))


def segment_is_closed(seg: np.ndarray, tolerance_px: float = 3.0) -> bool:
    return bool(seg.shape[0] >= 4 and float(np.hypot(*(seg[0] - seg[-1]))) <= float(tolerance_px))


def segment_contains_point(seg: np.ndarray, point_xy: Tuple[float, float]) -> bool:
    if not segment_is_closed(seg):
        return False
    poly = MplPath(np.column_stack([seg[:, 1], seg[:, 0]]))
    return bool(poly.contains_point(point_xy))


def primary_segments_by_level(
    segments: Iterable[Tuple[float, np.ndarray]], nucleus_xy: Tuple[float, float]
) -> List[Tuple[float, np.ndarray]]:
    """Choose one nucleus-associated contour for each level.

    Closed contours that surround the nucleus are preferred.  This prevents a
    field star or a noise island from defining the area used by the relative
    morphology comparison.
    """
    grouped: Dict[float, List[np.ndarray]] = {}
    for level, seg in segments:
        grouped.setdefault(float(level), []).append(seg)
    selected: List[Tuple[float, np.ndarray]] = []
    for level in sorted(grouped):
        group = grouped[level]
        surrounding = [seg for seg in group if segment_contains_point(seg, nucleus_xy)]
        candidates = surrounding or group
        if candidates:
            selected.append((level, max(candidates, key=segment_area_px2)))
    return selected


def area_matched_synthetic_segments(
    synthetic_image: np.ndarray,
    observed_segments: Iterable[Tuple[float, np.ndarray]],
    nucleus_xy: Tuple[float, float],
    min_points: int,
    keep_radius_px: float,
    search_steps: int,
) -> Tuple[
    np.ndarray,
    List[Tuple[float, np.ndarray]],
    List[Dict[str, float]],
    List[Tuple[float, np.ndarray, float, np.ndarray]],
]:
    """Pick synthetic contours with enclosed areas matching observed contours.

    This is for *relative morphology* comparison.  It does not claim absolute
    photometric calibration.  It prevents arbitrary synthetic peak fractions
    from making two similarly shaped comae appear mismatched merely because
    their radial brightness profiles have different normalization.

    The final return value keeps the actual observed/synthetic contour pairs.
    That makes it possible to calculate a Jaccard index from the same isophotes
    that appear in the morphology comparison instead of from screenshot pixels.
    """
    obs_primary = primary_segments_by_level(observed_segments, nucleus_xy)
    targets = [(float(level), seg, segment_area_px2(seg)) for level, seg in obs_primary]
    targets = [(level, seg, area) for level, seg, area in targets if area > 0]
    vals = synthetic_image[np.isfinite(synthetic_image) & (synthetic_image > 0)]
    if not targets or vals.size == 0:
        return np.asarray([], dtype=float), [], [], []
    peak = float(vals.max())
    floor = max(float(np.percentile(vals, 0.2)), peak * 1e-7)
    ceiling = peak * 0.995
    if not ceiling > floor:
        return np.asarray([], dtype=float), [], [], []
    levels = np.geomspace(floor, ceiling, max(40, int(search_steps)))
    candidates: List[Tuple[float, np.ndarray, float]] = []
    for level in levels:
        segs = filter_segments_near_nucleus(
            contour_segments(synthetic_image, [float(level)], min_points), nucleus_xy, keep_radius_px
        )
        prim = primary_segments_by_level(segs, nucleus_xy)
        if not prim:
            continue
        _, seg = prim[0]
        area = segment_area_px2(seg)
        if area > 0:
            candidates.append((float(level), seg, area))
    if not candidates:
        return np.asarray([], dtype=float), [], [], []

    matches: List[Tuple[float, np.ndarray, float, np.ndarray]] = []
    details: List[Dict[str, float]] = []
    used_levels: set[float] = set()
    # Match from outer to inner contour so duplicate candidate levels can be
    # avoided when the synthetic area grid is coarse.
    for obs_level, obs_seg, target_area in sorted(targets, key=lambda item: item[2], reverse=True):
        ranked = sorted(candidates, key=lambda item: abs(math.log(max(item[2], 1e-12) / target_area)))
        selected = next((item for item in ranked if item[0] not in used_levels), ranked[0])
        syn_level, syn_seg, syn_area = selected
        used_levels.add(syn_level)
        matches.append((obs_level, obs_seg, syn_level, syn_seg))
        details.append({
            "observedLevel": float(obs_level),
            "observedAreaPx2": float(target_area),
            "syntheticLevel": float(syn_level),
            "syntheticAreaPx2": float(syn_area),
            "areaRatioSyntheticToObserved": float(syn_area / target_area),
        })
    # Draw and report outer-to-inner, like the black observed contours.
    matches.sort(key=lambda item: segment_area_px2(item[1]), reverse=True)
    chosen = [(syn_level, syn_seg) for _, _, syn_level, syn_seg in matches]
    details.sort(key=lambda item: item["observedAreaPx2"], reverse=True)
    return np.asarray([level for level, _ in chosen], dtype=float), chosen, details, matches


def segment_to_mask(seg: np.ndarray, shape: Tuple[int, int]) -> np.ndarray:
    """Rasterize one closed isophote interior into a boolean mask."""
    mask = np.zeros(shape, dtype=bool)
    if not segment_is_closed(seg):
        return mask
    rr, cc = polygon(np.asarray(seg[:, 0], dtype=float), np.asarray(seg[:, 1], dtype=float), shape=shape)
    mask[rr, cc] = True
    return mask


def outside_radius_mask(shape: Tuple[int, int], center_xy: Tuple[float, float], radius_px: float) -> np.ndarray:
    yy, xx = np.indices(shape, dtype=float)
    cx, cy = center_xy
    return np.hypot(xx - cx, yy - cy) >= max(0.0, float(radius_px))


def jaccard_counts(mask_a: np.ndarray, mask_b: np.ndarray, valid: np.ndarray | None = None) -> Dict[str, float | int | None]:
    a = np.asarray(mask_a, dtype=bool)
    b = np.asarray(mask_b, dtype=bool)
    if valid is not None:
        use = np.asarray(valid, dtype=bool)
        a = a & use
        b = b & use
    intersection = int(np.count_nonzero(a & b))
    union = int(np.count_nonzero(a | b))
    return {
        "intersectionPx": intersection,
        "unionPx": union,
        "index": float(intersection / union) if union > 0 else None,
    }


def calculate_jaccard_metrics(
    matches: Sequence[Tuple[float, np.ndarray, float, np.ndarray]],
    shape: Tuple[int, int],
    center_xy: Tuple[float, float],
    inner_exclusion_radius_px: float,
    pixel_scale_arcsec: float,
) -> Tuple[Dict[str, object], List[Dict[str, object]]]:
    """Calculate shape overlap on paired, area-matched, comet-associated isophotes.

    Each isophote interior is one binary layer.  The multi-level score sums
    intersections and unions across the layers, preserving information from the
    inner and outer contours.  A second score excludes the inner coma so nucleus
    alignment cannot make the tail-shape agreement look artificially good.
    """
    valid_outer = outside_radius_mask(shape, center_xy, inner_exclusion_radius_px)
    layers: List[Dict[str, object]] = []
    skipped = 0
    for observed_level, observed_seg, synthetic_level, synthetic_seg in matches:
        observed_mask = segment_to_mask(observed_seg, shape)
        synthetic_mask = segment_to_mask(synthetic_seg, shape)
        if not observed_mask.any() or not synthetic_mask.any():
            skipped += 1
            continue
        all_px = jaccard_counts(observed_mask, synthetic_mask)
        outside_inner = jaccard_counts(observed_mask, synthetic_mask, valid_outer)
        layers.append({
            "observedLevel": float(observed_level),
            "syntheticLevel": float(synthetic_level),
            "observedAreaPx": int(np.count_nonzero(observed_mask)),
            "syntheticAreaPx": int(np.count_nonzero(synthetic_mask)),
            "allPixels": all_px,
            "outsideInnerComa": outside_inner,
            "observedMask": observed_mask,
            "syntheticMask": synthetic_mask,
        })

    def combined(key: str) -> Dict[str, float | int | None]:
        intersection = int(sum(int(layer[key]["intersectionPx"]) for layer in layers))
        union = int(sum(int(layer[key]["unionPx"]) for layer in layers))
        indices = [float(layer[key]["index"]) for layer in layers if layer[key]["index"] is not None]
        return {
            "intersectionPxAcrossLayers": intersection,
            "unionPxAcrossLayers": union,
            "index": float(intersection / union) if union > 0 else None,
            "meanPerLayerIndex": float(np.mean(indices)) if indices else None,
            "minimumPerLayerIndex": float(np.min(indices)) if indices else None,
            "maximumPerLayerIndex": float(np.max(indices)) if indices else None,
        }

    serializable_layers: List[Dict[str, object]] = []
    for layer_number, layer in enumerate(layers, start=1):
        serializable_layers.append({
            "layer": layer_number,
            "observedLevel": layer["observedLevel"],
            "syntheticLevel": layer["syntheticLevel"],
            "observedAreaPx": layer["observedAreaPx"],
            "syntheticAreaPx": layer["syntheticAreaPx"],
            "allPixels": layer["allPixels"],
            "outsideInnerComa": layer["outsideInnerComa"],
        })

    summary: Dict[str, object] = {
        "definition": "Jaccard index = intersection / union of rasterized interiors of paired, area-matched, nucleus-associated closed isophotes.",
        "comparisonBasis": "relative morphology after nucleus alignment; field-star islands are excluded by using the comet-associated contour around the nucleus",
        "layersUsed": len(layers),
        "layersSkippedBecauseContourWasNotClosed": skipped,
        "innerComaExclusionRadiusPx": float(inner_exclusion_radius_px),
        "innerComaExclusionRadiusArcsec": float(inner_exclusion_radius_px * pixel_scale_arcsec),
        "multiLevelAllPixels": combined("allPixels"),
        "multiLevelOutsideInnerComa": combined("outsideInnerComa"),
        "perContour": serializable_layers,
        "interpretation": "Use multiLevelOutsideInnerComa.index as the primary tail-shape score. The all-pixels score is retained because it also measures the aligned inner coma.",
    }
    return summary, layers


def write_jaccard_csv(path: Path, metrics: Dict[str, object]) -> None:
    """Write a minimal CSV summary."""
    all_px = metrics.get("multiLevelAllPixels", {})
    outer = metrics.get("multiLevelOutsideInnerComa", {})
    rows = [
        {"metric": "main_tail_shape_score", "value": outer.get("index")},
        {"metric": "full_shape_score_including_center", "value": all_px.get("index")},
        {"metric": "outline_levels_compared", "value": metrics.get("layersUsed")},
        {"metric": "ignored_center_radius_pixels", "value": metrics.get("innerComaExclusionRadiusPx")},
        {"metric": "ignored_center_radius_arcsec", "value": metrics.get("innerComaExclusionRadiusArcsec")},
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["metric", "value"])
        writer.writeheader()
        writer.writerows(rows)


def save_jaccard_diagnostic_figure(
    path: Path,
    layers: Sequence[Dict[str, object]],
    center_xy: Tuple[float, float],
    inner_exclusion_radius_px: float,
    pixel_scale_arcsec: float,
    primary_score: float | None,
) -> None:
    """Create a simple three-panel explanation of the overlap calculation."""
    if not layers:
        return
    observed_count = np.sum([np.asarray(layer["observedMask"], dtype=int) for layer in layers], axis=0)
    synthetic_count = np.sum([np.asarray(layer["syntheticMask"], dtype=int) for layer in layers], axis=0)
    largest_observed = np.asarray(layers[0]["observedMask"], dtype=bool)
    largest_simulated = np.asarray(layers[0]["syntheticMask"], dtype=bool)

    # Plain-language overlap map for the largest compared outline:
    # 0 = neither, 1 = observed only, 2 = simulation only, 3 = both.
    match_map = np.zeros(largest_observed.shape, dtype=int)
    match_map[largest_observed & ~largest_simulated] = 1
    match_map[~largest_observed & largest_simulated] = 2
    match_map[largest_observed & largest_simulated] = 3

    extent = image_extent(largest_observed.shape, pixel_scale_arcsec)
    cx, cy = center_xy
    circle_center = (
        (cx - (largest_observed.shape[1] - 1) / 2.0) * pixel_scale_arcsec,
        (cy - (largest_observed.shape[0] - 1) / 2.0) * pixel_scale_arcsec,
    )

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.8), constrained_layout=True)
    axes[0].imshow(observed_count, origin="lower", interpolation="nearest", extent=extent, cmap="viridis")
    axes[0].set_title("Observed comet shape")
    axes[1].imshow(synthetic_count, origin="lower", interpolation="nearest", extent=extent, cmap="viridis")
    axes[1].set_title("Simulated comet shape")

    match_colors = ListedColormap(["white", "#E69F00", "#56B4E9", "#009E73"])
    axes[2].imshow(match_map, origin="lower", interpolation="nearest", extent=extent, cmap=match_colors, vmin=0, vmax=3)
    axes[2].set_title("Where the largest shapes match")
    axes[2].legend(
        handles=[
            Patch(facecolor="#009E73", label="Both shapes: match"),
            Patch(facecolor="#E69F00", label="Observed image only"),
            Patch(facecolor="#56B4E9", label="Simulation only"),
        ],
        loc="upper right",
        fontsize=8,
        framealpha=0.9,
    )

    for ax in axes:
        ax.add_patch(
            plt.Circle(
                circle_center,
                inner_exclusion_radius_px * pixel_scale_arcsec,
                fill=False,
                color="black",
                lw=1.2,
                ls="--",
            )
        )
        ax.set_aspect("equal")
        ax.set_xlabel("left / right offset [arcsec]")
        ax.set_ylabel("up / down offset [arcsec]")

    score_text = "not available" if primary_score is None else f"{float(primary_score):.3f}"
    fig.suptitle(f"Jaccard score: {score_text}")
    fig.savefig(path, dpi=220)
    plt.close(fig)


def plot_segments(ax, segments: Iterable[Tuple[float, np.ndarray]], color: str, linewidth: float, scale: float) -> None:
    for _, seg in segments:
        h = ax._comet_frame_height_px  # assigned by prepare_axis
        w = ax._comet_frame_width_px
        x = (seg[:, 1] - (w - 1) / 2.0) * scale
        y = (seg[:, 0] - (h - 1) / 2.0) * scale
        ax.plot(x, y, color=color, lw=linewidth)


def prepare_axis(ax, shape: Tuple[int, int], scale: float) -> None:
    h, w = shape
    ax._comet_frame_height_px = h
    ax._comet_frame_width_px = w
    half_w = w * scale / 2.0
    half_h = h * scale / 2.0
    ax.set_xlim(-half_w, half_w)
    ax.set_ylim(-half_h, half_h)
    ax.set_aspect("equal")
    ax.set_xlabel("sky offset [arcsec]  (east ←)")
    ax.set_ylabel("north offset [arcsec]")


def image_extent(shape: Tuple[int, int], scale: float) -> List[float]:
    h, w = shape
    return [-w * scale / 2.0, w * scale / 2.0, -h * scale / 2.0, h * scale / 2.0]



def max_extent_px(segments: Iterable[Tuple[float, np.ndarray]], center_xy: Tuple[float, float]) -> float:
    cx, cy = center_xy
    max_r = 0.0
    for _, seg in segments:
        r = np.hypot(seg[:, 1] - cx, seg[:, 0] - cy)
        if r.size:
            max_r = max(max_r, float(np.max(r)))
    return max_r


def build_outputs(inputs: Inputs) -> None:
    meta = json.loads(inputs.meta_json.read_text(encoding="utf-8"))
    config = dict(DEFAULT_CONFIG)
    hints = meta.get("comparisonHints")
    if isinstance(hints, dict):
        config.update(hints)
    if inputs.config_json is not None:
        config.update(json.loads(inputs.config_json.read_text(encoding="utf-8")))
    particles = read_particles(inputs.particles_csv)

    with fits.open(inputs.observed_fits, memmap=False) as hdul:
        data = np.asarray(hdul[0].data, dtype=float)
        header = hdul[0].header.copy()
    if data.ndim != 2:
        raise ValueError(f"Expected a 2-D primary FITS image; got shape={data.shape}")
    wcs = WCS(header)
    object_name = str(header.get("OBJECT") or inputs.observed_fits.stem)
    observation_date = str(meta.get("observationDateUTC") or "").strip()
    suffix = f" — {observation_date}" if observation_date else ""
    default_title = f"{object_name}: observed (black) and synthetic (red) isophotes{suffix}"
    default_beta_title = f"{object_name}: observed isophotes (black) with synthetic beta-bin diagnostics (red){suffix}"

    if inputs.nucleus_x is None or inputs.nucleus_y is None:
        clicked_x, clicked_y = choose_observed_nucleus(data, f"Observed FITS: {inputs.observed_fits.name}")
    else:
        clicked_x, clicked_y = inputs.nucleus_x, inputs.nucleus_y
    refined_x, refined_y = refine_nucleus(data, clicked_x, clicked_y, int(config.get("nucleusRefineRadiusPx", 18)))
    observed_ra, observed_dec = wcs.all_pix2world(np.array([[refined_x, refined_y]], dtype=float), 0)[0]

    pixel_scale = float(config.get("outputPixelScaleArcsec", header.get("PIXSCALE", 1.012)))
    width_px = int(config.get("outputWidthPx", 700))
    height_px = int(config.get("outputHeightPx", 520))
    observed_sky = local_sky_image(data, wcs, observed_ra, observed_dec, width_px, height_px, pixel_scale)
    center_xy = ((width_px - 1) / 2.0, (height_px - 1) / 2.0)

    nucleus = meta.get("nucleus", {})
    sim_nuc_ra = float(nucleus["raDeg"])
    sim_nuc_dec = float(nucleus["decDeg"])
    px, py = project_particles_standard_frame(
        particles, sim_nuc_ra, sim_nuc_dec, observed_dec, width_px, height_px, pixel_scale
    )

    observed_positive, noise_sigma = observed_tail_signal(
        observed_sky,
        float(config.get("observedBackgroundSigmaPx", 55)),
        float(config.get("observedSmoothSigmaPx", 2.6)),
        float(config.get("innerComaMaskRadiusPx", 18)),
    )
    obs_levels = levels_from_noise(
        observed_positive,
        noise_sigma,
        config.get("observedNoiseSigmaMultipliers", [2.5, 4, 6, 10, 16, 28]),
    )
    min_points = int(config.get("minContourPoints", 16))
    observed_segments = contour_segments(observed_positive, obs_levels, min_points)
    observed_segments = filter_segments_near_nucleus(
        observed_segments, center_xy, float(config.get("observedContourAssociationRadiusPx", 55))
    )

    weight_column = str(config.get("syntheticWeightColumn", "brightness_weight"))
    if weight_column not in particles:
        raise ValueError(f"Unknown syntheticWeightColumn={weight_column!r}")
    weights = particles[weight_column]
    total_map = make_map(px, py, weights, observed_sky.shape)
    total_smoothed = gaussian_filter(total_map, sigma=max(0.0, float(config.get("syntheticSmoothSigmaPx", 2.2))), mode="nearest")
    total_smoothed = add_centered_gaussian_core(
        total_smoothed,
        float(config.get("syntheticCoreFluxFraction", 0.0)),
        float(config.get("syntheticCoreSigmaPx", config.get("syntheticSmoothSigmaPx", 2.2))),
    )
    fixed_syn_levels = levels_from_fractions(
        total_smoothed,
        config.get("syntheticLevelFractions", [0.008, 0.018, 0.04, 0.09, 0.22, 0.52]),
        float(config.get("syntheticPeakPercentile", 99.8)),
    )
    fixed_synthetic_segments = filter_segments_near_nucleus(
        contour_segments(total_smoothed, fixed_syn_levels, min_points),
        center_xy,
        float(config.get("syntheticContourAssociationRadiusPx", 70)),
    )
    synthetic_level_mode = str(config.get("syntheticLevelMode", "fixed_fraction")).strip().lower()
    area_match_details: List[Dict[str, float]] = []
    jaccard_matches: List[Tuple[float, np.ndarray, float, np.ndarray]] = []
    if synthetic_level_mode == "area_matched":
        syn_levels, synthetic_segments, area_match_details, jaccard_matches = area_matched_synthetic_segments(
            total_smoothed,
            observed_segments,
            center_xy,
            min_points,
            float(config.get("syntheticContourAssociationRadiusPx", 70)),
            int(config.get("syntheticAreaMatchSearchSteps", 180)),
        )
        if not synthetic_segments:
            synthetic_level_mode = "fixed_fraction_fallback"
            syn_levels, synthetic_segments = fixed_syn_levels, fixed_synthetic_segments
    else:
        syn_levels, synthetic_segments = fixed_syn_levels, fixed_synthetic_segments

    # The Jaccard score always uses area-matched shape layers.  If the visible
    # diagnostic uses fixed synthetic fractions, build a separate area-matched
    # set solely for the morphology metric so brightness normalization does not
    # masquerade as a shape difference.
    if not jaccard_matches:
        _, _, _, jaccard_matches = area_matched_synthetic_segments(
            total_smoothed,
            observed_segments,
            center_xy,
            min_points,
            float(config.get("syntheticContourAssociationRadiusPx", 70)),
            int(config.get("syntheticAreaMatchSearchSteps", 180)),
        )
    jaccard_inner_radius_px = float(config.get("jaccardInnerExclusionRadiusPx", config.get("innerComaMaskRadiusPx", 18)))
    jaccard_metrics, jaccard_layers = calculate_jaccard_metrics(
        jaccard_matches, observed_sky.shape, center_xy, jaccard_inner_radius_px, pixel_scale
    )

    observed_extent_px = max_extent_px(observed_segments, center_xy)
    observed_extent_arcsec = observed_extent_px * pixel_scale
    min_extent_arcsec = float(config.get("minimumUsefulObservedTailExtentArcsec", 45))
    usable = observed_extent_arcsec >= min_extent_arcsec
    warning = None if usable else (
        f"Observed extended emission reaches only about {observed_extent_arcsec:.1f} arcsec from the nucleus. "
        f"This FITS is useful for a pipeline test, but it is weak for tail-shape calibration. "
        f"Prefer an epoch with a visibly extended dust tail."
    )

    inputs.out_dir.mkdir(parents=True, exist_ok=True)

    # Remove obsolete files from older utility versions when an existing output
    # folder is reused. This keeps the folder honest: only fresh outputs remain.
    for obsolete_name in [
        "contour_component_panels.png",
        "contour_lines.csv",
        "contour_lines_fixed_fractions.png",
        "observed_standardized_crop.png",
        "observed_tail_diagnostic.png",
    ]:
        obsolete_path = inputs.out_dir / obsolete_name
        if obsolete_path.exists():
            obsolete_path.unlink()

    write_jaccard_csv(inputs.out_dir / "jaccard_metrics.csv", jaccard_metrics)
    primary_score = jaccard_metrics.get("multiLevelOutsideInnerComa", {}).get("index")
    save_jaccard_diagnostic_figure(
        inputs.out_dir / "jaccard_masks.png",
        jaccard_layers,
        center_xy,
        jaccard_inner_radius_px,
        pixel_scale,
        primary_score,
    )

    finite = observed_sky[np.isfinite(observed_sky)]
    lo, hi = np.percentile(finite, [2.0, 99.8]) if finite.size else (0.0, 1.0)
    extent = image_extent(observed_sky.shape, pixel_scale)

    # Main overlay.
    fig, ax = plt.subplots(figsize=(8, 6), constrained_layout=True)
    ax.imshow(observed_sky, cmap="gray", origin="lower", interpolation="nearest", vmin=lo, vmax=hi, extent=extent)
    prepare_axis(ax, observed_sky.shape, pixel_scale)
    plot_segments(ax, observed_segments, "black", 0.95, pixel_scale)
    plot_segments(ax, synthetic_segments, "red", 1.05, pixel_scale)
    ax.plot(0, 0, marker="+", color="black", ms=8, mew=1)
    ax.set_title(str(config.get("title", default_title)))
    fig.savefig(inputs.out_dir / "contour_overlay.png", dpi=240)
    plt.close(fig)

    # Publication-style line-only figure.
    fig, ax = plt.subplots(figsize=(8, 6), constrained_layout=True)
    prepare_axis(ax, observed_sky.shape, pixel_scale)
    plot_segments(ax, observed_segments, "black", 0.95, pixel_scale)
    plot_segments(ax, synthetic_segments, "red", 1.05, pixel_scale)
    ax.set_title(str(config.get("title", default_title)))
    fig.savefig(inputs.out_dir / "contour_lines_only.png", dpi=240)
    plt.close(fig)

    # Beta-bin diagnostic figure.
    bins = [float(v) for v in config.get("betaBins", meta.get("betaBins", [0, 0.003, 0.01, 0.03, 0.1, 0.3, 1]))]
    panels: List[Tuple[str, np.ndarray, float | None, float | None]] = [("total", total_smoothed, None, None)]
    for b0, b1 in zip(bins[:-1], bins[1:]):
        sel = (particles["beta"] >= b0) & (particles["beta"] < b1)
        m = make_map(px[sel], py[sel], weights[sel], observed_sky.shape)
        m = gaussian_filter(m, sigma=max(0.0, float(config.get("syntheticSmoothSigmaPx", 2.2))), mode="nearest")
        panels.append((f"β ∈ [{b0:g}, {b1:g})", m, b0, b1))

    cols = int(config.get("panelColumns", 3))
    rows = int(math.ceil(len(panels) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(4.2 * cols, 3.6 * rows), constrained_layout=True, squeeze=False)
    for ax, (label, panel, b0, b1) in zip(axes.flat, panels):
        segs = filter_segments_near_nucleus(
            contour_segments(panel, levels_from_fractions(panel, config.get("syntheticLevelFractions", [0.008, 0.018, 0.04, 0.09, 0.22, 0.52]), float(config.get("syntheticPeakPercentile", 99.8))), min_points),
            center_xy, float(config.get("syntheticContourAssociationRadiusPx", 70))
        )
        prepare_axis(ax, observed_sky.shape, pixel_scale)
        plot_segments(ax, observed_segments, "black", 0.7, pixel_scale)
        plot_segments(ax, segs, "red", 0.9, pixel_scale)
        ax.set_title(label)
        ax.set_xlabel("")
        ax.set_ylabel("")
        ax.set_xticks([])
        ax.set_yticks([])
    for ax in axes.flat[len(panels):]:
        ax.axis("off")
    fig.suptitle(str(config.get("betaPanelTitle", default_beta_title)))
    fig.savefig(inputs.out_dir / "contour_beta_panels.png", dpi=240)
    plt.close(fig)

    dra_arcsec = float(wrap_ra_delta_deg(sim_nuc_ra - observed_ra) * math.cos(math.radians(observed_dec)) * 3600.0)
    ddec_arcsec = float((sim_nuc_dec - observed_dec) * 3600.0)
    offset_arcsec = float(math.hypot(dra_arcsec, ddec_arcsec))
    summary = {
        "observedFits": str(inputs.observed_fits),
        "particlesCsv": str(inputs.particles_csv),
        "metaJson": str(inputs.meta_json),
        "clickedObservedNucleusPixel": {"x": clicked_x, "y": clicked_y},
        "refinedObservedNucleusPixel": {"x": refined_x, "y": refined_y},
        "refinedObservedNucleusRaDecDeg": {"ra": float(observed_ra), "dec": float(observed_dec)},
        "simulatedNucleusRaDecDeg": {"ra": sim_nuc_ra, "dec": sim_nuc_dec},
        "simulatedToObservedNucleusOffsetArcsec": {"dRaCosDec": dra_arcsec, "dDec": ddec_arcsec, "total": offset_arcsec},
        "standardFrame": {"northUp": True, "eastLeft": True, "widthPx": width_px, "heightPx": height_px, "pixelScaleArcsec": pixel_scale},
        "observedNoiseSigma": noise_sigma,
        "observedLevels": [float(v) for v in obs_levels],
        "syntheticLevelMode": synthetic_level_mode,
        "syntheticLevels": [float(v) for v in syn_levels],
        "fixedFractionSyntheticLevels": [float(v) for v in fixed_syn_levels],
        "areaMatchDetails": area_match_details,
        "jaccard": jaccard_metrics,
        "syntheticCoreFluxFraction": float(config.get("syntheticCoreFluxFraction", 0.0)),
        "syntheticCoreSigmaPx": float(config.get("syntheticCoreSigmaPx", config.get("syntheticSmoothSigmaPx", 2.2))),
        "observedContours": len(observed_segments),
        "syntheticContours": len(synthetic_segments),
        "observedTailExtentArcsec": observed_extent_arcsec,
        "usableForTailShapeCalibration": usable,
        "warning": warning,
        "particles": int(len(particles["beta"])),
        "note": "Black curves are observed comet outlines. Red curves are simulated comet outlines after center alignment. The main tail-shape score is jaccard.multiLevelOutsideInnerComa.index. Full technical Jaccard details are retained here; jaccard_metrics.csv is intentionally shorter for everyday use."
    }
    (inputs.out_dir / "comparison_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if warning:
        (inputs.out_dir / "WARNING_image_quality.txt").write_text(warning + "\n", encoding="utf-8")

    print(f"Created comparison outputs in: {inputs.out_dir.resolve()}")
    primary_jaccard = jaccard_metrics.get("multiLevelOutsideInnerComa", {}).get("index")
    secondary_jaccard = jaccard_metrics.get("multiLevelAllPixels", {}).get("index")
    if primary_jaccard is not None:
        print(f"PRIMARY JACCARD TAIL-SHAPE SCORE (outside inner coma): {float(primary_jaccard):.6f}")
    if secondary_jaccard is not None:
        print(f"Secondary all-pixels Jaccard score: {float(secondary_jaccard):.6f}")
    if warning:
        print("WARNING:", warning)
    output_names = [
        "contour_overlay.png",
        "contour_lines_only.png",
        "contour_beta_panels.png",
        "jaccard_metrics.csv",
        "comparison_summary.json",
    ]
    if jaccard_layers:
        output_names.insert(3, "jaccard_masks.png")
    for name in output_names:
        print(f"  - {name}")


def choose_inputs_gui() -> Inputs | None:
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox
    except Exception:
        return None
    root = tk.Tk(); root.withdraw()
    messagebox.showinfo("Contour comparison", "Select the observed telescope FITS file.")
    observed = filedialog.askopenfilename(title="Observed FITS", filetypes=[("FITS", "*.fits *.fit *.fts"), ("All files", "*.*")])
    if not observed: return None
    messagebox.showinfo("Contour comparison", "Select the simulation particle CSV exported by the comet simulator.")
    particles = filedialog.askopenfilename(title="Simulation particles CSV", filetypes=[("CSV", "*.csv"), ("All files", "*.*")])
    if not particles: return None
    messagebox.showinfo("Contour comparison", "Select the matching simulation metadata JSON.")
    meta = filedialog.askopenfilename(title="Simulation metadata JSON", filetypes=[("JSON", "*.json"), ("All files", "*.*")])
    if not meta: return None
    out = filedialog.askdirectory(title="Choose an empty output folder")
    if not out: return None
    return Inputs(Path(observed), Path(particles), Path(meta), None, Path(out))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observed", type=Path)
    parser.add_argument("--particles", type=Path)
    parser.add_argument("--meta", type=Path)
    parser.add_argument("--config", type=Path, help="Optional external JSON overrides for the generic comparison defaults")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--nucleus-x", type=float)
    parser.add_argument("--nucleus-y", type=float)
    args = parser.parse_args()
    if all([args.observed, args.particles, args.meta, args.out]):
        inputs = Inputs(args.observed, args.particles, args.meta, args.config, args.out, args.nucleus_x, args.nucleus_y)
    else:
        chosen = choose_inputs_gui()
        if chosen is None:
            parser.print_help(); return 2
        inputs = chosen
    build_outputs(inputs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
