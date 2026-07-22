#!/usr/bin/env python3
"""Create observed-versus-synthetic comet-tail contour comparison figures.

This is a relative morphology tool, not absolute photometry. It aligns the
synthetic nucleus to the observed nucleus, subtracts a 2-D background from the
FITS image, masks field sources, and extracts comet-associated isophotes.

The faint-tail extraction is deliberately conservative: faint observed contours
are searched only in a tail corridor connected to the nucleus. This avoids the
failure mode where background structure becomes a huge black contour.

v24 changes faint-tail extraction so the black observed tail lines are true
brightness isophotes from the FITS signal.  The corridor/manual cleanup mask is
used only to decide which isophote pieces belong to the comet.  It is no longer
contoured directly, so straight cleanup/corridor edges should not appear as
observed comet contours.
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
from matplotlib.patches import Patch, Polygon as MplPolygon
from matplotlib.path import Path as MplPath
import numpy as np
from astropy.io import fits
from astropy.stats import SigmaClip, sigma_clipped_stats
from astropy.wcs import WCS
from photutils.background import Background2D, MedianBackground
from photutils.segmentation import detect_sources, detect_threshold
from scipy.ndimage import (
    binary_closing,
    binary_dilation,
    binary_fill_holes,
    gaussian_filter,
    label as ndi_label,
    map_coordinates,
    median_filter,
)
from skimage import measure
from skimage.draw import polygon

DEFAULT_CONFIG = {
    "faintTailUseSignalEnvelope": False,
    "faintTailTrimToSignal": False,
    "faintTailBackwardsAllowancePx": 160,
    "faintTailMaxCorridorWidthPx": 600,
    "faintTailCorridorWidthPx": 320,
    "faintTailHeadKeepRadiusPx": 0,
    "faintTailEnvelopeInnerAlwaysKeepPx": 0,
    "faintTailBackwardsAllowancePx": 130,
    "faintTailCorridorWidthPx": 150,
    "faintTailMaxCorridorWidthPx": 340,
    "faintTailEnvelopeMaxWidthPx": 280,
    "faintTailEnvelopeWidthScale": 1.9,
    "faintTailTrimToSignal": False,
    "outputWidthPx": 700,
    "outputHeightPx": 520,
    "outputPixelScaleArcsec": 1.012,
    "nucleusRefineRadiusPx": 18,

    "usePhotutilsBackground": True,
    "backgroundBoxSizePx": 112,
    "backgroundFilterSizePx": 3,
    "backgroundSigmaClip": 3.0,

    "sourceDetectNsigma": 3.8,
    "sourceDetectNpixels": 8,
    "sourceMaskMinComponentAreaPx": 0,
    "sourceMaskMaxComponentAreaPx": 0,
    "sourceMaskDilationPx": 9,
    "sourceMaskInnerProtectRadiusPx": 32,

    "compactSourceMaskEnabled": True,
    "compactSourceHighpassSigmaPx": 5.0,
    "compactSourceDetectNsigma": 3.0,
    "compactSourceMaskMinComponentAreaPx": 0,
    "compactSourceMaskMaxComponentAreaPx": 0,
    "compactSourceMaskDilationPx": 14,

    "sourceReplacementMedianSizePx": 61,
    "protectCometRegionFromSourceMask": True,
    "sourceMaskProtectRadiusPx": 42,
    "sourceMaskProtectTailWidthPx": 70,
    "sourceMaskProtectTailWidthGrowth": 0.18,
    "sourceMaskProtectTailMaxWidthPx": 130,
    "sourceMaskProtectTailLengthPx": 420,
    "sourceMaskProtectTailBackPx": 30,
    "diagnosticShowTailCorridor": False,
    "faintTailDilationRadiusPx": 0,
    "faintTailFillHoles": False,
    "faintTailTrimToSignal": False,
    "faintTailTrimLevelFraction": 0.25,
    "faintTailNoTrimRadiusPx": 320,
    "faintTailTrimCloseRadiusPx": 2,
    "faintTailUseSignalEnvelope": True,
    "faintTailEnvelopeLevelFraction": 0.42,
    "faintTailEnvelopeMinSigma": 0.85,
    "faintTailEnvelopeBinPx": 7,
    "faintTailEnvelopeWidthQuantile": 0.88,
    "faintTailEnvelopeWidthScale": 1.35,
    "faintTailEnvelopeMinWidthPx": 16,
    "faintTailEnvelopeMaxWidthPx": 82,
    "faintTailMaskSmoothSigmaPx": 1.6,
    "faintTailMaskSmoothThreshold": 0.36,
    "faintTailFinalGrowPx": 0,
    "faintTailIncludeBackHead": False,
    "faintTailBackHeadRadiusPx": 145,
    "faintTailBackHeadMinSigma": 0.45,
    "faintTailBackHeadLevelFraction": 0.22,
    "faintTailBackHeadCloseRadiusPx": 8,
    "faintTailBackHeadGrowPx": 5,

    "observedSmoothSigmaPx": 2.0,
    "observedNoiseSigmaMultipliers": [2.2, 3.2, 4.8, 7.0, 10.5, 16.0],
    "observedContourAssociationRadiusPx": 58,
    "innerComaMaskRadiusPx": 14,

    "includeFaintTailContours": True,
    "faintTailMode": "safe",        # off, safe, aggressive
    "tailDirectionSource": "synthetic",  # synthetic, observed, auto
    "faintTailSmoothSigmaPx": 4.2,
    "faintTailNoiseSigmaMultipliers": [1.60, 2.00, 2.50, 3.20],
    "faintTailCorridorWidthPx": 22,
    "faintTailCorridorWidthGrowth": 0.10,
    "faintTailMaxCorridorWidthPx": 48,
    "faintTailMaxLengthPx": 300,
    "faintTailBackwardsAllowancePx": 10,
    "faintTailSeedRadiusPx": 22,
    "faintTailBridgeRadiusPx": 5,
    "faintTailMinAreaPx": 130,
    "faintTailMaxAreaFraction": 0.075,
    "rejectSourceMaskInFaintTail": True,
    "tailRejectMaskDilationPx": 3,
    "rejectContoursTouchingBorder": True,
    "contourBorderMarginPx": 3,
    "rejectContoursOnSourceMask": False,
    "allowObservedContourFallback": True,
    "fallbackObservedNoiseSigmaMultipliers": [1.6, 2.1, 2.8, 3.8, 5.2, 7.5, 11.0],
    "contourSourceMaskDilationPx": 5,
    "maxContourSourceMaskFraction": 0.015,
    "maxObservedContourAreaFraction": 0.16,
    "maxFaintTailContourAreaFraction": 0.085,
    "maxObservedContourRadiusPx": 360,
    "faintTailMinForwardExtentPx": 60,
    "faintTailMinContourPoints": 60,

    # Important: observed faint-tail contours must be true isophotes from the
    # smoothed FITS signal.  The binary support mask/corridor is only a gate.
    # If this is set to true, straight corridor/manual-cleanup borders can be
    # drawn as black comet contours, which is usually undesirable.
    "faintTailPlotBinarySupportContours": False,
    "faintTailFallbackToBinarySupportContours": False,
    "faintTailContourInsideFraction": 0.55,
    "faintTailContourMaskGrowPx": 2,

    "syntheticSmoothSigmaPx": 2.8,
    "syntheticCoreFluxFraction": 0.0,
    "syntheticCoreSigmaPx": 2.8,
    "syntheticWeightColumn": "brightness_weight",
    "syntheticPeakPercentile": 99.8,
    "syntheticLevelMode": "fixed_fraction",  # fixed_fraction or area_matched
    "syntheticLevelFractions": [0.035, 0.065, 0.12, 0.22, 0.40, 0.65],
    "syntheticFaintTailLevelFractions": [0.006, 0.012, 0.022],
    "syntheticContourAssociationRadiusPx": 70,
    "syntheticAreaMatchSearchSteps": 180,

    "jaccardInnerExclusionRadiusPx": 14,
    "minimumUsefulObservedTailExtentArcsec": 45,
    "minContourPoints": 16,
    "panelColumns": 3,

    "manualCleanupEnabled": False,
    "manualCleanupCoordinateSystem": "arcsec",  # arcsec or pixel
    "manualCleanupEraseCircles": [],
    "manualCleanupEraseRectangles": [],
    "manualCleanupErasePolygons": [],
    "manualCleanupKeepCircles": [],
    "manualCleanupKeepRectangles": [],
    "manualCleanupKeepPolygons": [],
    "manualCleanupApplyToSourceMask": True,
    "manualCleanupDiagnostic": True,

    "makeDiagnosticFigures": True,
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
    manual_cleanup_json: Path | None = None
    draw_cleanup: bool = False


def finite_fill(image: np.ndarray) -> np.ndarray:
    data = np.asarray(image, dtype=float).copy()
    finite = np.isfinite(data)
    fill = float(np.nanmedian(data[finite])) if finite.any() else 0.0
    data[~finite] = fill
    return data


def robust_sigma(values: np.ndarray) -> float:
    vals = np.asarray(values, dtype=float)
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return 0.0
    med = float(np.median(vals))
    mad = float(np.median(np.abs(vals - med)))
    return max(1e-12, 1.4826 * mad)


def disk_structure(radius_px: float) -> np.ndarray:
    r = max(1, int(round(float(radius_px))))
    yy, xx = np.indices((2 * r + 1, 2 * r + 1), dtype=float)
    return (xx - r) ** 2 + (yy - r) ** 2 <= r * r


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


def local_sky_image(data: np.ndarray, wcs: WCS, center_ra_deg: float, center_dec_deg: float, width_px: int, height_px: int, pixel_scale_arcsec: float) -> np.ndarray:
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
    sampled = map_coordinates(finite_fill(data), [src[:, 1], src[:, 0]], order=1, mode="constant", cval=fill)
    return sampled.reshape((height_px, width_px))


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


def project_particles_standard_frame(particles: Dict[str, np.ndarray], sim_nucleus_ra_deg: float, sim_nucleus_dec_deg: float, observed_center_dec_deg: float, width_px: int, height_px: int, pixel_scale_arcsec: float) -> Tuple[np.ndarray, np.ndarray]:
    cx = (width_px - 1) / 2.0
    cy = (height_px - 1) / 2.0
    dra = wrap_ra_delta_deg(particles["ra_deg"] - sim_nucleus_ra_deg)
    ddec = particles["dec_deg"] - sim_nucleus_dec_deg
    cos_dec = max(1e-8, math.cos(math.radians(observed_center_dec_deg)))
    x = cx - dra * cos_dec * 3600.0 / pixel_scale_arcsec
    y = cy + ddec * 3600.0 / pixel_scale_arcsec
    return x, y


def photutils_clean_observed_image(image: np.ndarray, center_xy: Tuple[float, float], config: Dict, tail_direction_xy: Tuple[float, float] | None = None) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    data = finite_fill(image)

    if not bool(config.get("usePhotutilsBackground", True)):
        bg_value = sigma_clipped_stats(data, sigma=3.0, maxiters=5)[0]
        background = np.full_like(data, float(bg_value))
        return data - background, background, np.zeros_like(data, dtype=bool)

    box = max(16, int(config.get("backgroundBoxSizePx", 96)))
    filt = max(1, int(config.get("backgroundFilterSizePx", 3)))
    if filt % 2 == 0:
        filt += 1

    try:
        bkg = Background2D(
            data,
            box_size=box,
            filter_size=filt,
            sigma_clip=SigmaClip(sigma=float(config.get("backgroundSigmaClip", 3.0))),
            bkg_estimator=MedianBackground(),
            exclude_percentile=float(config.get("backgroundExcludePercentile", 35.0)),
        )
        background = np.asarray(bkg.background, dtype=float)
        residual = data - background
    except Exception:
        bg_value = sigma_clipped_stats(data, sigma=3.0, maxiters=5)[0]
        background = np.full_like(data, float(bg_value))
        residual = data - background

    source_mask = np.zeros_like(data, dtype=bool)
    try:
        threshold = detect_threshold(residual, n_sigma=float(config.get("sourceDetectNsigma", 4.8)), background=0.0)
        segm = detect_sources(residual, threshold, n_pixels=int(config.get("sourceDetectNpixels", 8)))
        if segm is not None:
            labels = segm.data
            cx, cy = center_xy
            yy, xx = np.indices(labels.shape, dtype=float)
            protect_r = float(config.get("sourceMaskInnerProtectRadiusPx", 30))
            near_nucleus = np.hypot(xx - cx, yy - cy) <= protect_r
            protected_labels = set(np.unique(labels[near_nucleus & (labels > 0)]).astype(int).tolist())
            source_mask = labels > 0
            for lab in protected_labels:
                source_mask &= labels != lab
            source_mask = filter_components_by_area(
                source_mask,
                min_area_px=int(config.get("sourceMaskMinComponentAreaPx", 0)),
                max_area_px=int(config.get("sourceMaskMaxComponentAreaPx", 0)),
            )
            dil = int(config.get("sourceMaskDilationPx", 5))
            if dil > 0:
                source_mask = binary_dilation(source_mask, structure=disk_structure(dil))
            source_mask &= np.hypot(xx - cx, yy - cy) > protect_r
    except Exception:
        source_mask = np.zeros_like(data, dtype=bool)

    # Second pass: compact high-pass source mask. This catches halos/spikes that
    # can otherwise become false long black contours when faint thresholds are used.
    if bool(config.get("compactSourceMaskEnabled", True)):
        try:
            hp_sigma = max(1.0, float(config.get("compactSourceHighpassSigmaPx", 5.0)))
            highpass = residual - gaussian_filter(residual, sigma=hp_sigma, mode="nearest")
            hp_sig = robust_sigma(highpass)
            if hp_sig > 0:
                compact = np.isfinite(highpass) & (highpass > float(config.get("compactSourceDetectNsigma", 3.4)) * hp_sig)
                yy, xx = np.indices(compact.shape, dtype=float)
                cx, cy = center_xy
                protect_r = float(config.get("sourceMaskInnerProtectRadiusPx", 32))
                compact &= np.hypot(xx - cx, yy - cy) > protect_r
                compact = remove_small_components(compact, min_area_px=max(3, int(config.get("sourceDetectNpixels", 8)) // 2))
                compact = filter_components_by_area(
                    compact,
                    min_area_px=int(config.get("compactSourceMaskMinComponentAreaPx", 0)),
                    max_area_px=int(config.get("compactSourceMaskMaxComponentAreaPx", 0)),
                )
                dil2 = int(config.get("compactSourceMaskDilationPx", 12))
                if dil2 > 0:
                    compact = binary_dilation(compact, structure=disk_structure(dil2))
                compact &= np.hypot(xx - cx, yy - cy) > protect_r
                source_mask |= compact
        except Exception:
            pass

    # Protect the comet/tail region from being treated as a field source.
    # Without this, star/source masks can create circular or box-like holes that
    # cover part of the comet and then appear in the accepted observed contours.
    if bool(config.get("protectCometRegionFromSourceMask", True)) and np.any(source_mask):
        yy, xx = np.indices(data.shape, dtype=float)
        cx, cy = center_xy
        protect_radius = float(config.get("sourceMaskProtectRadiusPx", 42))
        protect = np.hypot(xx - cx, yy - cy) <= protect_radius

        if tail_direction_xy is not None:
            ux, uy = tail_direction_xy
            norm = math.hypot(float(ux), float(uy))
            if norm > 1e-12:
                ux, uy = float(ux) / norm, float(uy) / norm
                dx = xx - cx
                dy = yy - cy
                forward = dx * ux + dy * uy
                perp = np.abs(-dx * uy + dy * ux)
                width = float(config.get("sourceMaskProtectTailWidthPx", 70)) + np.maximum(forward, 0) * float(config.get("sourceMaskProtectTailWidthGrowth", 0.18))
                max_width = float(config.get("sourceMaskProtectTailMaxWidthPx", 130))
                if max_width > 0:
                    width = np.minimum(width, max_width)
                tail_protect = (
                    (forward >= -float(config.get("sourceMaskProtectTailBackPx", 30)))
                    & (forward <= float(config.get("sourceMaskProtectTailLengthPx", 420)))
                    & (perp <= width)
                )
                protect |= tail_protect

        source_mask &= ~protect

    cleaned = residual.copy()
    if np.any(source_mask):
        raw_size = int(config.get("sourceReplacementMedianSizePx", 21))
        if raw_size > 0:
            size = max(3, raw_size)
            if size % 2 == 0:
                size += 1
            local = median_filter(cleaned, size=size, mode="nearest")
            cleaned[source_mask] = local[source_mask]

    return cleaned, background, source_mask


def observed_tail_signal(cleaned_residual: np.ndarray, smooth_sigma_px: float) -> Tuple[np.ndarray, float]:
    smoothed = gaussian_filter(cleaned_residual, sigma=max(0.0, float(smooth_sigma_px)), mode="nearest")
    _, _, std = sigma_clipped_stats(smoothed, sigma=3.0, maxiters=6)
    sigma = max(robust_sigma(smoothed), float(std), 1e-12)
    return np.clip(smoothed, 0.0, None), sigma


def make_map(x: np.ndarray, y: np.ndarray, weights: np.ndarray, shape: Tuple[int, int]) -> np.ndarray:
    height, width = shape
    good = np.isfinite(x) & np.isfinite(y) & np.isfinite(weights)
    good &= (x >= 0) & (x < width) & (y >= 0) & (y < height) & (weights > 0)
    hist, _, _ = np.histogram2d(y[good], x[good], bins=[height, width], range=[[0, height], [0, width]], weights=weights[good])
    return hist


def add_centered_gaussian_core(image: np.ndarray, flux_fraction: float, sigma_px: float) -> np.ndarray:
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
    core_flux = dust_flux * frac / max(1e-12, 1.0 - frac)
    return data + core * (core_flux / max(1e-12, float(core.sum())))


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


def segment_is_closed(seg: np.ndarray, tolerance_px: float = 3.0) -> bool:
    return bool(seg.shape[0] >= 4 and float(np.hypot(*(seg[0] - seg[-1]))) <= float(tolerance_px))


def segment_area_px2(seg: np.ndarray) -> float:
    if seg.shape[0] < 3:
        return 0.0
    x = np.asarray(seg[:, 1], dtype=float)
    y = np.asarray(seg[:, 0], dtype=float)
    return abs(float(0.5 * np.sum(x * np.roll(y, -1) - y * np.roll(x, -1))))


def segment_contains_point(seg: np.ndarray, point_xy: Tuple[float, float]) -> bool:
    if not segment_is_closed(seg):
        return False
    poly = MplPath(np.column_stack([seg[:, 1], seg[:, 0]]))
    return bool(poly.contains_point(point_xy))


def segment_associated_with_nucleus(seg: np.ndarray, nucleus_xy: Tuple[float, float], keep_radius_px: float) -> bool:
    nx, ny = nucleus_xy
    dx = seg[:, 1] - nx
    dy = seg[:, 0] - ny
    if float(np.min(dx * dx + dy * dy)) <= float(keep_radius_px) ** 2:
        return True
    return segment_contains_point(seg, nucleus_xy)


def filter_segments_near_nucleus(segments: Iterable[Tuple[float, np.ndarray]], nucleus_xy: Tuple[float, float], keep_radius_px: float) -> List[Tuple[float, np.ndarray]]:
    return [(level, seg) for level, seg in segments if segment_associated_with_nucleus(seg, nucleus_xy, keep_radius_px)]


def append_unique_segments(base: List[Tuple[float, np.ndarray]], extra: Iterable[Tuple[float, np.ndarray]], area_tolerance_fraction: float = 0.015) -> List[Tuple[float, np.ndarray]]:
    result = list(base)
    existing_areas = [segment_area_px2(seg) for _, seg in result]
    for level, seg in extra:
        area = segment_area_px2(seg)
        if area <= 0:
            continue
        duplicate = any(abs(area - old) / max(area, old, 1.0) < area_tolerance_fraction for old in existing_areas)
        if not duplicate:
            result.append((level, seg))
            existing_areas.append(area)
    return result


def contour_point_source_fraction(seg: np.ndarray, source_mask: np.ndarray) -> float:
    """Fraction of contour sample points that cross masked field sources/artifacts."""
    if source_mask is None or not np.size(source_mask) or seg.shape[0] == 0:
        return 0.0
    yy = np.clip(np.rint(seg[:, 0]).astype(int), 0, source_mask.shape[0] - 1)
    xx = np.clip(np.rint(seg[:, 1]).astype(int), 0, source_mask.shape[1] - 1)
    return float(np.mean(source_mask[yy, xx]))


def contour_touches_border(seg: np.ndarray, shape: Tuple[int, int], margin_px: float) -> bool:
    h, w = shape
    m = float(margin_px)
    if seg.shape[0] == 0:
        return True
    return bool(
        np.any(seg[:, 0] <= m)
        or np.any(seg[:, 0] >= h - 1 - m)
        or np.any(seg[:, 1] <= m)
        or np.any(seg[:, 1] >= w - 1 - m)
    )


def max_radius_px(seg: np.ndarray, center_xy: Tuple[float, float]) -> float:
    cx, cy = center_xy
    if seg.shape[0] == 0:
        return 0.0
    return float(np.max(np.hypot(seg[:, 1] - cx, seg[:, 0] - cy)))


def filter_noisy_observed_segments(
    segments: Iterable[Tuple[float, np.ndarray]],
    source_mask: np.ndarray,
    shape: Tuple[int, int],
    center_xy: Tuple[float, float],
    config: Dict,
    tail: bool = False,
) -> List[Tuple[float, np.ndarray]]:
    """Reject contours that are likely to be stars, frame-edge artifacts, or background.

    This is intentionally conservative.  It is better for a paper to keep fewer
    reliable comet-associated isophotes than to draw large black contours made
    from background gradients or residual field stars.
    """
    source_reject = np.asarray(source_mask, dtype=bool) if source_mask is not None else np.zeros(shape, dtype=bool)
    if bool(config.get("rejectContoursOnSourceMask", True)):
        dil = int(config.get("contourSourceMaskDilationPx", 5))
        if dil > 0 and source_reject.any():
            source_reject = binary_dilation(source_reject, structure=disk_structure(dil))

    max_source_frac = float(config.get("maxContourSourceMaskFraction", 0.015))
    max_area_frac = float(config.get("maxFaintTailContourAreaFraction" if tail else "maxObservedContourAreaFraction", 0.12))
    max_radius = float(config.get("maxObservedContourRadiusPx", 1e9))
    border_margin = float(config.get("contourBorderMarginPx", 3))

    cleaned: List[Tuple[float, np.ndarray]] = []
    require_contains_key = "requireFaintTailContourContainsNucleus" if tail else "requireObservedContourContainsNucleus"
    require_contains = bool(config.get(require_contains_key, False))

    cleaned: List[Tuple[float, np.ndarray]] = []
    for level, seg in segments:
        if bool(config.get("rejectContoursTouchingBorder", True)) and contour_touches_border(seg, shape, border_margin):
            continue
        if require_contains and not segment_contains_point(seg, center_xy):
            continue
        area = segment_area_px2(seg)
        if area > max_area_frac * shape[0] * shape[1]:
            continue
        if max_radius_px(seg, center_xy) > max_radius:
            continue
        if bool(config.get("rejectContoursOnSourceMask", True)) and contour_point_source_fraction(seg, source_reject) > max_source_frac:
            continue
        cleaned.append((level, seg))
    return cleaned


def normalize_vector_xy(vec: Tuple[float, float]) -> Tuple[float, float] | None:
    vx, vy = float(vec[0]), float(vec[1])
    n = math.hypot(vx, vy)
    if not n > 1e-9:
        return None
    return vx / n, vy / n


def synthetic_tail_direction(px: np.ndarray, py: np.ndarray, weights: np.ndarray, center_xy: Tuple[float, float], inner_exclusion_px: float = 16.0) -> Tuple[float, float] | None:
    cx, cy = center_xy
    dx = np.asarray(px, dtype=float) - cx
    dy = np.asarray(py, dtype=float) - cy
    w = np.asarray(weights, dtype=float)
    r = np.hypot(dx, dy)
    good = np.isfinite(dx) & np.isfinite(dy) & np.isfinite(w) & (w > 0) & (r >= inner_exclusion_px)
    if np.count_nonzero(good) < 20:
        return None
    ww = w[good] * np.clip(r[good], 1.0, np.percentile(r[good], 90))
    return normalize_vector_xy((float(np.sum(dx[good] * ww)), float(np.sum(dy[good] * ww))))


def observed_tail_direction(signal: np.ndarray, sigma: float, center_xy: Tuple[float, float], inner_exclusion_px: float = 20.0, threshold_sigma: float = 1.2) -> Tuple[float, float] | None:
    if not sigma > 0:
        return None
    data = np.asarray(signal, dtype=float)
    h, w = data.shape
    cx, cy = center_xy
    yy, xx = np.indices(data.shape, dtype=float)
    dx = xx - cx
    dy = yy - cy
    r = np.hypot(dx, dy)
    threshold = float(sigma) * float(threshold_sigma)
    good = np.isfinite(data) & (data > threshold) & (r >= inner_exclusion_px)
    margin = max(8, int(min(h, w) * 0.04))
    good &= (xx >= margin) & (xx < w - margin) & (yy >= margin) & (yy < h - margin)
    if np.count_nonzero(good) < 20:
        return None
    vals = np.clip(data[good] - threshold, 0, None)
    rr = r[good]
    weights = vals * np.clip(rr, 1.0, np.percentile(rr, 90))
    return normalize_vector_xy((float(np.sum(dx[good] * weights)), float(np.sum(dy[good] * weights))))


def tail_corridor_mask(shape: Tuple[int, int], center_xy: Tuple[float, float], direction_xy: Tuple[float, float], max_length_px: float, base_width_px: float, width_growth: float, backwards_allowance_px: float, max_width_px: float | None = None) -> np.ndarray:
    h, w = shape
    cx, cy = center_xy
    dx, dy = direction_xy
    yy, xx = np.indices(shape, dtype=float)
    vx = xx - cx
    vy = yy - cy
    along = vx * dx + vy * dy
    cross = np.abs(vx * (-dy) + vy * dx)
    width = float(base_width_px) + np.maximum(along, 0.0) * float(width_growth)
    if max_width_px is not None and float(max_width_px) > 0:
        width = np.minimum(width, float(max_width_px))
    return (along >= -float(backwards_allowance_px)) & (along <= float(max_length_px)) & (cross <= width)


def weighted_quantile(values: np.ndarray, weights: np.ndarray, q: float) -> float:
    values = np.asarray(values, dtype=float)
    weights = np.asarray(weights, dtype=float)
    good = np.isfinite(values) & np.isfinite(weights) & (weights > 0)
    if np.count_nonzero(good) == 0:
        return float(np.nanmedian(values)) if values.size else 0.0
    v = values[good]
    w = weights[good]
    order = np.argsort(v)
    v = v[order]
    w = w[order]
    cdf = np.cumsum(w)
    total = cdf[-1]
    if total <= 0:
        return float(np.nanmedian(v))
    return float(np.interp(float(q) * total, cdf, v))


def signal_following_tail_envelope(
    signal: np.ndarray,
    sigma: float,
    level: float,
    corridor: np.ndarray,
    center_xy: Tuple[float, float],
    direction_xy: Tuple[float, float],
    config: Dict,
) -> np.ndarray:
    """
    Build a smooth, signal-following faint-tail envelope.

    The old faint-tail mask could accidentally grow into the predefined tail
    corridor and produce a rectangular/block-like accepted tail.  This envelope
    is still allowed to use a broad corridor as a safety limit, but its actual
    width and centre line are estimated from the smoothed FITS signal in bins
    along the tail.  In other words, the accepted faint tail follows the image
    signal rather than the corridor wall.
    """
    h, w = signal.shape
    cx, cy = center_xy
    ux, uy = direction_xy
    yy, xx = np.indices(signal.shape, dtype=float)

    vx = xx - cx
    vy = yy - cy
    along = vx * ux + vy * uy
    cross_signed = vx * (-uy) + vy * ux
    radius = np.hypot(vx, vy)

    low_fraction = float(config.get("faintTailEnvelopeLevelFraction", 0.42))
    low_sigma = float(config.get("faintTailEnvelopeMinSigma", 0.85))
    low_threshold = max(float(level) * low_fraction, float(sigma) * low_sigma)

    positive = np.isfinite(signal) & (signal >= low_threshold) & corridor

    # Keep only a small near-nucleus region by default.  Earlier versions used
    # a large default (about 78 px), which made small ZTF comets look like a
    # huge round blob before the real tail was measured.  The default now follows
    # the seed radius and is capped unless the config explicitly raises the cap.
    seed_r_for_inner = float(config.get("faintTailSeedRadiusPx", 22))
    default_inner_radius = max(14.0, seed_r_for_inner * 1.25)
    inner_radius = float(config.get("faintTailEnvelopeInnerAlwaysKeepPx", default_inner_radius))
    inner_cap = float(config.get("faintTailEnvelopeInnerMaxPx", 36))
    if inner_cap > 0:
        inner_radius = min(inner_radius, inner_cap)
    inner = radius <= inner_radius

    if np.count_nonzero(positive & ~inner) < int(config.get("faintTailEnvelopeMinSignalPixels", 80)):
        # Do not return the full corridor here.  Returning the corridor makes
        # its straight boundary eligible for later mask-based contours.  If the
        # image does not contain enough tail signal, only keep the small
        # near-nucleus allowance and let the isophote extraction decide.
        return inner & corridor

    max_length = float(config.get("faintTailMaxLengthPx", 380))
    back = float(config.get("faintTailBackwardsAllowancePx", 10))
    bin_px = max(2.0, float(config.get("faintTailEnvelopeBinPx", 7)))
    bins = np.arange(-back, max_length + bin_px, bin_px)
    if bins.size < 3:
        return inner & corridor

    centres = []
    widths = []
    xs = []

    min_pts = int(config.get("faintTailEnvelopeMinPixelsPerBin", 8))
    width_q = float(config.get("faintTailEnvelopeWidthQuantile", 0.88))
    width_scale = float(config.get("faintTailEnvelopeWidthScale", 1.35))
    min_width = float(config.get("faintTailEnvelopeMinWidthPx", 16))
    max_width = float(config.get("faintTailEnvelopeMaxWidthPx", 82))

    for b0, b1 in zip(bins[:-1], bins[1:]):
        band = positive & (along >= b0) & (along < b1)
        if np.count_nonzero(band) < min_pts:
            continue

        values = np.clip(signal[band] - low_threshold, 0, None) + 0.15 * float(sigma)
        cross_vals = cross_signed[band]
        centre = weighted_quantile(cross_vals, values, 0.50)
        spread = weighted_quantile(np.abs(cross_vals - centre), values, width_q)
        width = float(np.clip(spread * width_scale + 3.0, min_width, max_width))

        xs.append(0.5 * (b0 + b1))
        centres.append(centre)
        widths.append(width)

    if len(xs) < 3:
        return inner & corridor

    xs = np.asarray(xs, dtype=float)
    centres = np.asarray(centres, dtype=float)
    widths = np.asarray(widths, dtype=float)

    # Smooth the centreline and width so the envelope has comet-like rounded
    # edges instead of pixel/bin stair-steps.
    smooth_bins = float(config.get("faintTailEnvelopeSmoothBins", 2.0))
    if smooth_bins > 0 and len(xs) >= 5:
        centres = gaussian_filter(centres, sigma=smooth_bins, mode="nearest")
        widths = gaussian_filter(widths, sigma=smooth_bins, mode="nearest")

    # Interpolate to every pixel. Outside the measured part, do not invent a
    # huge rectangle; use the nearest measured values only inside the broad
    # corridor and still require real signal later.
    centre_img = np.interp(along.ravel(), xs, centres, left=centres[0], right=centres[-1]).reshape(signal.shape)
    width_img = np.interp(along.ravel(), xs, widths, left=widths[0], right=widths[-1]).reshape(signal.shape)

    envelope = corridor & (np.abs(cross_signed - centre_img) <= width_img)

    # Avoid a boxy far end by tapering the last measured part gently.
    if bool(config.get("faintTailEnvelopeTaperEnd", True)):
        end_start = float(xs[-1] - float(config.get("faintTailEnvelopeEndTaperPx", 45)))
        end_span = max(1.0, float(xs[-1] - end_start))
        taper = np.clip((xs[-1] - along) / end_span, 0.0, 1.0)
        tapered_width = width_img * (0.65 + 0.35 * taper)
        envelope = envelope & ((along < end_start) | (np.abs(cross_signed - centre_img) <= tapered_width))

    # Keep the inner coma/head naturally broad, then let the tail be governed
    # by the signal-following envelope.
    envelope |= inner & corridor

    return envelope


def remove_small_components(mask: np.ndarray, min_area_px: int) -> np.ndarray:
    labels, nlab = ndi_label(np.asarray(mask, dtype=bool))
    if nlab == 0:
        return np.zeros_like(mask, dtype=bool)
    sizes = np.bincount(labels.ravel())
    keep = sizes >= max(1, int(min_area_px))
    keep[0] = False
    return keep[labels]


def filter_components_by_area(mask: np.ndarray, min_area_px: int = 0, max_area_px: int = 0) -> np.ndarray:
    """Keep only connected components inside a configurable area range.

    Survey images can contain broad residuals, detector-edge structures, or the
    comet/tail itself.  These are not field stars.  This filter keeps the source
    replacement step focused on compact stars by optionally rejecting very large
    components.  Set max_area_px <= 0 to disable the upper-area cut.
    """
    labels, nlab = ndi_label(np.asarray(mask, dtype=bool))
    if nlab == 0:
        return np.zeros_like(mask, dtype=bool)
    sizes = np.bincount(labels.ravel())
    keep = np.ones_like(sizes, dtype=bool)
    keep[0] = False
    if int(min_area_px) > 0:
        keep &= sizes >= int(min_area_px)
    if int(max_area_px) > 0:
        keep &= sizes <= int(max_area_px)
    keep[0] = False
    return keep[labels]



def _shape_points_to_pixels(points: Sequence[Sequence[float]], shape: Tuple[int, int], center_xy: Tuple[float, float], pixel_scale_arcsec: float, coord_system: str) -> np.ndarray:
    pts = np.asarray(points, dtype=float)
    if pts.ndim != 2 or pts.shape[1] != 2 or pts.shape[0] < 3:
        return np.zeros((0, 2), dtype=float)
    coord_system = str(coord_system or "arcsec").lower()
    out = pts.copy()
    if coord_system in {"arcsec", "sky", "plot"}:
        out[:, 0] = pts[:, 0] / pixel_scale_arcsec + center_xy[0]
        out[:, 1] = pts[:, 1] / pixel_scale_arcsec + center_xy[1]
    elif coord_system in {"pixel", "pixels", "image"}:
        out[:, 0] = pts[:, 0]
        out[:, 1] = pts[:, 1]
    else:
        raise ValueError(f"Unsupported manualCleanupCoordinateSystem={coord_system!r}; use 'arcsec' or 'pixel'.")
    return out


def _parse_point_pair(value) -> Tuple[float, float] | None:
    if isinstance(value, dict):
        if "center" in value:
            return _parse_point_pair(value.get("center"))
        if "x" in value and "y" in value:
            return float(value["x"]), float(value["y"])
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return float(value[0]), float(value[1])
    return None


def _circle_mask_from_spec(spec, shape: Tuple[int, int], center_xy: Tuple[float, float], pixel_scale_arcsec: float, coord_system: str) -> np.ndarray:
    h, w = shape
    if isinstance(spec, dict):
        ctr = _parse_point_pair(spec.get("center", spec))
        radius = float(spec.get("radius", spec.get("radiusPx", spec.get("radiusArcsec", 0))))
    elif isinstance(spec, (list, tuple)) and len(spec) >= 3:
        ctr = (float(spec[0]), float(spec[1]))
        radius = float(spec[2])
    else:
        return np.zeros(shape, dtype=bool)
    if ctr is None or radius <= 0:
        return np.zeros(shape, dtype=bool)
    coord_system = str(coord_system or "arcsec").lower()
    if coord_system in {"arcsec", "sky", "plot"}:
        cx = ctr[0] / pixel_scale_arcsec + center_xy[0]
        cy = ctr[1] / pixel_scale_arcsec + center_xy[1]
        r = radius / pixel_scale_arcsec
    elif coord_system in {"pixel", "pixels", "image"}:
        cx, cy, r = ctr[0], ctr[1], radius
    else:
        raise ValueError(f"Unsupported manualCleanupCoordinateSystem={coord_system!r}; use 'arcsec' or 'pixel'.")
    yy, xx = np.indices(shape, dtype=float)
    return np.hypot(xx - cx, yy - cy) <= r


def _rectangle_mask_from_spec(spec, shape: Tuple[int, int], center_xy: Tuple[float, float], pixel_scale_arcsec: float, coord_system: str) -> np.ndarray:
    h, w = shape
    if isinstance(spec, dict):
        if all(k in spec for k in ("xMin", "xMax", "yMin", "yMax")):
            xmin, xmax = float(spec["xMin"]), float(spec["xMax"])
            ymin, ymax = float(spec["yMin"]), float(spec["yMax"])
        elif all(k in spec for k in ("xmin", "xmax", "ymin", "ymax")):
            xmin, xmax = float(spec["xmin"]), float(spec["xmax"])
            ymin, ymax = float(spec["ymin"]), float(spec["ymax"])
        else:
            return np.zeros(shape, dtype=bool)
    elif isinstance(spec, (list, tuple)) and len(spec) >= 4:
        xmin, xmax, ymin, ymax = map(float, spec[:4])
    else:
        return np.zeros(shape, dtype=bool)
    coord_system = str(coord_system or "arcsec").lower()
    if coord_system in {"arcsec", "sky", "plot"}:
        x0 = xmin / pixel_scale_arcsec + center_xy[0]
        x1 = xmax / pixel_scale_arcsec + center_xy[0]
        y0 = ymin / pixel_scale_arcsec + center_xy[1]
        y1 = ymax / pixel_scale_arcsec + center_xy[1]
    elif coord_system in {"pixel", "pixels", "image"}:
        x0, x1, y0, y1 = xmin, xmax, ymin, ymax
    else:
        raise ValueError(f"Unsupported manualCleanupCoordinateSystem={coord_system!r}; use 'arcsec' or 'pixel'.")
    xlo, xhi = sorted((x0, x1))
    ylo, yhi = sorted((y0, y1))
    yy, xx = np.indices(shape, dtype=float)
    return (xx >= xlo) & (xx <= xhi) & (yy >= ylo) & (yy <= yhi)


def _polygon_mask_from_spec(spec, shape: Tuple[int, int], center_xy: Tuple[float, float], pixel_scale_arcsec: float, coord_system: str) -> np.ndarray:
    if isinstance(spec, dict):
        points = spec.get("points", [])
    else:
        points = spec
    pts = _shape_points_to_pixels(points, shape, center_xy, pixel_scale_arcsec, coord_system)
    if pts.shape[0] < 3:
        return np.zeros(shape, dtype=bool)
    rr, cc = polygon(pts[:, 1], pts[:, 0], shape=shape)
    mask = np.zeros(shape, dtype=bool)
    mask[rr, cc] = True
    return mask


def _merge_manual_cleanup_section(config: Dict) -> Dict:
    """Allow either top-level manualCleanup* fields or a nested manualCleanup object."""
    manual = config.get("manualCleanup")
    if isinstance(manual, dict):
        merged = dict(config)
        for key, value in manual.items():
            merged[key] = value
            if not str(key).startswith("manualCleanup"):
                merged["manualCleanup" + str(key)[0:1].upper() + str(key)[1:]] = value
        return merged
    return config


def build_manual_cleanup_masks(shape: Tuple[int, int], center_xy: Tuple[float, float], pixel_scale_arcsec: float, config: Dict) -> Tuple[np.ndarray, np.ndarray | None, Dict[str, int]]:
    """Build user-defined erase and keep masks for observed contours.

    Coordinates normally use the same arcsec axes as contour_lines_only.png:
    x is the horizontal sky offset, y is the vertical/north offset.  Set
    manualCleanupCoordinateSystem="pixel" to use standardized image pixels.
    """
    cfg = _merge_manual_cleanup_section(config)
    enabled = bool(cfg.get("manualCleanupEnabled", False))
    coord_system = str(cfg.get("manualCleanupCoordinateSystem", "arcsec"))
    erase = np.zeros(shape, dtype=bool)
    keep = np.zeros(shape, dtype=bool)
    keep_used = False
    counts = {"eraseCircles": 0, "eraseRectangles": 0, "erasePolygons": 0, "keepCircles": 0, "keepRectangles": 0, "keepPolygons": 0}

    def add_many(key: str, builder, target: np.ndarray, count_key: str) -> np.ndarray:
        items = cfg.get(key, []) or []
        if isinstance(items, dict):
            items = [items]
        out = target
        for item in items:
            m = builder(item, shape, center_xy, pixel_scale_arcsec, coord_system)
            if np.any(m):
                out |= m
                counts[count_key] += 1
        return out

    erase = add_many("manualCleanupEraseCircles", _circle_mask_from_spec, erase, "eraseCircles")
    erase = add_many("manualCleanupEraseRectangles", _rectangle_mask_from_spec, erase, "eraseRectangles")
    erase = add_many("manualCleanupErasePolygons", _polygon_mask_from_spec, erase, "erasePolygons")

    keep = add_many("manualCleanupKeepCircles", _circle_mask_from_spec, keep, "keepCircles")
    keep = add_many("manualCleanupKeepRectangles", _rectangle_mask_from_spec, keep, "keepRectangles")
    keep = add_many("manualCleanupKeepPolygons", _polygon_mask_from_spec, keep, "keepPolygons")
    keep_used = bool(np.any(keep))

    if not enabled and not np.any(erase) and not keep_used:
        return erase, None, counts
    return erase, keep if keep_used else None, counts


def apply_manual_cleanup_to_signal(signal: np.ndarray, erase_mask: np.ndarray, keep_mask: np.ndarray | None) -> np.ndarray:
    out = np.asarray(signal, dtype=float).copy()
    if keep_mask is not None:
        out[~keep_mask] = 0.0
    if erase_mask is not None and np.any(erase_mask):
        out[erase_mask] = 0.0
    return out


def save_manual_cleanup_diagnostic(path: Path, observed_sky: np.ndarray, erase_mask: np.ndarray, keep_mask: np.ndarray | None, pixel_scale: float) -> None:
    if (erase_mask is None or not np.any(erase_mask)) and keep_mask is None:
        return
    fig, ax = plt.subplots(figsize=(8, 6), constrained_layout=True)
    extent = image_extent(observed_sky.shape, pixel_scale)
    ax.imshow(asinh_preview(observed_sky), cmap="gray", origin="lower", extent=extent)
    prepare_axis(ax, observed_sky.shape, pixel_scale)
    if keep_mask is not None and np.any(keep_mask):
        for seg in measure.find_contours(keep_mask.astype(float), 0.5):
            h, w = observed_sky.shape
            x = (seg[:, 1] - (w - 1) / 2.0) * pixel_scale
            y = (seg[:, 0] - (h - 1) / 2.0) * pixel_scale
            ax.plot(x, y, color="lime", lw=1.1, ls="--", label="manual keep" if "manual keep" not in [t.get_text() for t in ax.texts] else None)
    if erase_mask is not None and np.any(erase_mask):
        for seg in measure.find_contours(erase_mask.astype(float), 0.5):
            h, w = observed_sky.shape
            x = (seg[:, 1] - (w - 1) / 2.0) * pixel_scale
            y = (seg[:, 0] - (h - 1) / 2.0) * pixel_scale
            ax.plot(x, y, color="red", lw=1.1, label="manual erase" if "manual erase" not in [t.get_text() for t in ax.texts] else None)
    ax.set_title("Manual cleanup regions: red = erased from observed contours, green = only kept area")
    fig.savefig(path, dpi=220)
    plt.close(fig)




def draw_manual_cleanup_polygons_interactive(
    observed_sky: np.ndarray,
    signal: np.ndarray,
    noise_sigma: float,
    source_mask: np.ndarray,
    center_xy: Tuple[float, float],
    pixel_scale: float,
    config: Dict,
    title: str = "Manual cleanup",
) -> List[List[List[float]]]:
    """Let the user draw erase polygons directly on the cleaned observed image.

    The returned polygon vertices are in the same arcsec coordinate system used
    by contour_lines_only.png.  The function is intentionally self-contained:
    no external cleanup JSON has to be supplied by the user.
    """
    polygons: List[List[List[float]]] = []
    current: List[List[float]] = []
    patch_artists = []
    point_artist = None
    line_artist = None
    done = {"value": False}

    fig, ax = plt.subplots(figsize=(10, 8), constrained_layout=True)
    extent = image_extent(observed_sky.shape, pixel_scale)

    # Show the cleaned positive signal because it is the image that will be
    # contoured.  The user can therefore erase exactly what would become a bad
    # observed contour.
    preview = asinh_preview(signal)
    ax.imshow(preview, cmap="gray", origin="lower", interpolation="nearest", extent=extent)
    prepare_axis(ax, observed_sky.shape, pixel_scale)

    try:
        preview_levels = levels_from_noise(
            signal,
            noise_sigma,
            config.get("observedNoiseSigmaMultipliers", [2.2, 3.2, 4.8, 7.0, 10.5, 16.0]),
        )
        preview_segments = contour_segments(signal, preview_levels, int(config.get("minContourPoints", 16)))
        plot_segments(ax, preview_segments, "black", 0.8, pixel_scale)
    except Exception:
        pass

    if source_mask is not None and np.any(source_mask):
        # Very faint source-mask outline, just enough to show what the automatic
        # cleaning already thinks are field sources.
        try:
            for seg in measure.find_contours(source_mask.astype(float), 0.5):
                h, w = source_mask.shape
                x = (seg[:, 1] - (w - 1) / 2.0) * pixel_scale
                y = (seg[:, 0] - (h - 1) / 2.0) * pixel_scale
                ax.plot(x, y, color="dodgerblue", lw=0.35, alpha=0.25)
        except Exception:
            pass

    ax.plot(0, 0, marker="+", color="lime", ms=9, mew=1.2)
    ax.set_title(
        title + "\n"
        "Draw RED erase polygons: left click = point | Enter/right click = close polygon | "
        "u = undo point | Backspace = remove polygon | c = clear | d = done | q = cancel"
    )

    def redraw_current():
        nonlocal point_artist, line_artist
        if line_artist is not None:
            try:
                line_artist.remove()
            except Exception:
                pass
            line_artist = None
        if point_artist is not None:
            try:
                point_artist.remove()
            except Exception:
                pass
            point_artist = None
        if current:
            xs = [p[0] for p in current]
            ys = [p[1] for p in current]
            line_artist, = ax.plot(xs, ys, color="red", lw=1.5, marker="o", ms=4)
            point_artist = line_artist
        fig.canvas.draw_idle()

    def finish_polygon():
        nonlocal current
        if len(current) >= 3:
            poly = [[float(x), float(y)] for x, y in current]
            polygons.append(poly)
            patch = MplPolygon(poly, closed=True, facecolor="red", edgecolor="red", alpha=0.25, lw=1.4)
            ax.add_patch(patch)
            patch_artists.append(patch)
        current = []
        redraw_current()

    def clear_all():
        nonlocal current
        current = []
        polygons.clear()
        for patch in list(patch_artists):
            try:
                patch.remove()
            except Exception:
                pass
        patch_artists.clear()
        redraw_current()

    def undo_last_polygon():
        if polygons:
            polygons.pop()
        if patch_artists:
            try:
                patch_artists.pop().remove()
            except Exception:
                pass
        fig.canvas.draw_idle()

    def on_click(event):
        if event.inaxes != ax or event.xdata is None or event.ydata is None:
            return
        # Right click finishes the current polygon.
        if getattr(event, "button", None) == 3:
            finish_polygon()
            return
        if getattr(event, "button", None) != 1:
            return
        current.append([float(event.xdata), float(event.ydata)])
        redraw_current()

    def on_key(event):
        key = (event.key or "").lower()
        if key in {"enter", "return"}:
            finish_polygon()
        elif key == "u":
            if current:
                current.pop()
                redraw_current()
        elif key in {"backspace", "delete"}:
            undo_last_polygon()
        elif key == "c":
            clear_all()
        elif key == "d":
            finish_polygon()
            done["value"] = True
            plt.close(fig)
        elif key == "q":
            clear_all()
            done["value"] = True
            plt.close(fig)

    fig.canvas.mpl_connect("button_press_event", on_click)
    fig.canvas.mpl_connect("key_press_event", on_key)
    plt.show(block=True)

    # Closing the window without pressing d keeps the polygons that were already
    # finished.  Unfinished points are ignored.
    return polygons


def nucleus_connected_support_mask(
    signal: np.ndarray,
    level: float,
    center_xy: Tuple[float, float],
    config: Dict,
    source_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Return only the thresholded signal component connected to the comet.

    ZTF fields can contain many background islands and imperfect star-cleaning
    residuals.  Contouring the whole residual image draws those islands as black
    observed isophotes.  This mask gates the observed-contour image to the one
    connected signal region that touches the nucleus seed.
    """
    data = np.asarray(signal, dtype=float)
    h, w = data.shape
    cx, cy = center_xy
    yy, xx = np.indices(data.shape, dtype=float)
    r = np.hypot(xx - cx, yy - cy)

    frac = float(config.get("observedSupportLevelFraction", 0.90))
    threshold = max(0.0, float(level) * frac)
    support = np.isfinite(data) & (data >= threshold)

    max_radius = float(config.get("observedSupportMaxRadiusPx", config.get("maxObservedContourRadiusPx", 1e9)))
    if max_radius > 0:
        support &= r <= max_radius

    if source_mask is not None and bool(config.get("observedSupportRejectSourceMask", True)):
        reject = np.asarray(source_mask, dtype=bool)
        dil = int(config.get("observedSupportSourceMaskDilationPx", config.get("contourSourceMaskDilationPx", 1)))
        if dil > 0 and reject.any():
            reject = binary_dilation(reject, structure=disk_structure(dil))
        support &= ~reject

    support = remove_small_components(support, int(config.get("observedSupportMinAreaPx", 10)))

    close_r = int(config.get("observedSupportCloseRadiusPx", 1))
    if close_r > 0 and np.any(support):
        support = binary_closing(support, structure=disk_structure(close_r))

    labels, nlab = ndi_label(support)
    if nlab == 0:
        return np.zeros_like(support, dtype=bool)

    seed_radius = float(config.get("observedSupportSeedRadiusPx", config.get("faintTailSeedRadiusPx", 15)))
    seed = r <= seed_radius
    seed_labels = np.unique(labels[seed & (labels > 0)])

    if seed_labels.size == 0:
        best_id = None
        best_dist = float("inf")
        search_radius = float(config.get("observedSupportNearestSearchRadiusPx", seed_radius * 3.0))
        for lab_id in range(1, nlab + 1):
            pts = np.argwhere(labels == lab_id)
            if pts.size == 0:
                continue
            d = float(np.min((pts[:, 1] - cx) ** 2 + (pts[:, 0] - cy) ** 2))
            if d < best_dist:
                best_dist = d
                best_id = lab_id
        if best_id is None or best_dist > search_radius * search_radius:
            return np.zeros_like(support, dtype=bool)
        seed_labels = np.asarray([best_id], dtype=int)

    comet_support = np.isin(labels, seed_labels)

    grow_r = int(config.get("observedSupportGrowRadiusPx", 0))
    if grow_r > 0 and np.any(comet_support):
        comet_support = binary_dilation(comet_support, structure=disk_structure(grow_r))
        if max_radius > 0:
            comet_support &= r <= max_radius

    return comet_support


def split_true_runs(mask_values: np.ndarray, closed: bool) -> List[Tuple[int, int]]:
    """Return inclusive runs of True values along a contour."""
    vals = np.asarray(mask_values, dtype=bool)
    n = vals.size
    if n == 0 or not vals.any():
        return []
    runs: List[Tuple[int, int]] = []
    start = None
    for i, ok in enumerate(vals):
        if ok and start is None:
            start = i
        elif (not ok) and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, n - 1))
    if closed and len(runs) >= 2 and runs[0][0] == 0 and runs[-1][1] == n - 1:
        first = runs.pop(0)
        last = runs.pop(-1)
        # The wrapped run cannot be represented as one continuous slice without
        # reordering points, so keep the longer side as a conservative segment.
        if (first[1] - first[0]) >= (last[1] - last[0]):
            runs.insert(0, first)
        else:
            runs.insert(0, last)
    return runs


def isophote_segments_inside_component(
    signal: np.ndarray,
    level: float,
    component: np.ndarray,
    min_points: int,
    config: Dict,
) -> List[np.ndarray]:
    """Extract true brightness isophotes, gated by the accepted comet mask.

    Earlier versions contoured the binary accepted mask itself.  That is what
    created straight black lines: the plotted contour followed corridor edges or
    manual-cleanup polygon edges.  This routine instead finds contours of the
    actual smoothed FITS signal at the requested brightness level and keeps only
    the contour pieces that lie inside the accepted comet-support mask.
    """
    comp = np.asarray(component, dtype=bool)
    grow = int(config.get("faintTailContourMaskGrowPx", 2))
    if grow > 0 and np.any(comp):
        comp = binary_dilation(comp, structure=disk_structure(grow))

    inside_fraction = float(config.get("faintTailContourInsideFraction", 0.55))
    out: List[np.ndarray] = []
    h, w = signal.shape
    for seg in measure.find_contours(signal, float(level)):
        if seg.shape[0] < max(3, int(min_points // 2)):
            continue
        rr = np.clip(np.rint(seg[:, 0]).astype(int), 0, h - 1)
        cc = np.clip(np.rint(seg[:, 1]).astype(int), 0, w - 1)
        inside = comp[rr, cc]
        if float(np.mean(inside)) >= inside_fraction and seg.shape[0] >= min_points:
            out.append(seg)
            continue

        closed = bool(np.linalg.norm(seg[0] - seg[-1]) < 2.0)
        for a, b in split_true_runs(inside, closed=closed):
            piece = seg[a:b + 1]
            if piece.shape[0] >= min_points:
                out.append(piece)
    return out


def max_forward_extent_px(seg: np.ndarray, center_xy: Tuple[float, float], direction_xy: Tuple[float, float]) -> float:
    cx, cy = center_xy
    dx, dy = direction_xy
    vx = seg[:, 1] - cx
    vy = seg[:, 0] - cy
    return float(np.max(vx * dx + vy * dy)) if seg.size else 0.0


def faint_tail_segments(signal: np.ndarray, sigma: float, multipliers: Sequence[float], center_xy: Tuple[float, float], direction_xy: Tuple[float, float] | None, config: Dict, reject_mask: np.ndarray | None = None) -> Tuple[List[Tuple[float, np.ndarray]], List[float], np.ndarray | None]:
    if direction_xy is None or not sigma > 0:
        return [], [], None

    tail_corridor = tail_corridor_mask(
        signal.shape,
        center_xy,
        direction_xy,
        max_length_px=float(config.get("faintTailMaxLengthPx", 380)),
        base_width_px=float(config.get("faintTailCorridorWidthPx", 32)),
        width_growth=float(config.get("faintTailCorridorWidthGrowth", 0.10)),
        backwards_allowance_px=float(config.get("faintTailBackwardsAllowancePx", 10)),
        max_width_px=float(config.get("faintTailMaxCorridorWidthPx", 0)) or None,
    )

    # Small rounded head allowance only.  The old fallback used 90 px, and some
    # configs used even larger values.  That made the observed comet contour look
    # artificially large and circular.  Now the default is tied to the seed
    # radius and capped.  The rounded head is used only as an allowed area for
    # real thresholded signal; it is not meant to manufacture a large comet mask.
    default_head_keep_px = float(config.get("faintTailSeedRadiusPx", 22)) * 1.25
    head_keep_px = float(config.get("faintTailHeadKeepRadiusPx", default_head_keep_px))
    head_keep_cap_px = float(config.get("faintTailHeadKeepMaxRadiusPx", 36))
    if head_keep_cap_px > 0:
        head_keep_px = min(head_keep_px, head_keep_cap_px)

    if head_keep_px > 0:
        _hy, _hx = np.indices(signal.shape, dtype=float)
        head_keep = np.hypot(_hx - center_xy[0], _hy - center_xy[1]) <= head_keep_px
        corridor = tail_corridor | head_keep
    else:
        corridor = tail_corridor

    mode = str(config.get("faintTailMode", "safe")).lower()
    bridge_radius = float(config.get("faintTailBridgeRadiusPx", 8 if mode == "aggressive" else 6))
    min_area = int(config.get("faintTailMinAreaPx", 100 if mode == "aggressive" else 130))
    max_area_fraction = float(config.get("faintTailMaxAreaFraction", 0.30 if mode == "aggressive" else 0.24))
    seed_radius = float(config.get("faintTailSeedRadiusPx", 22))
    min_points = int(config.get("faintTailMinContourPoints", 60))
    min_forward = float(config.get("faintTailMinForwardExtentPx", 60))

    h, w = signal.shape
    cx, cy = center_xy
    yy, xx = np.indices(signal.shape, dtype=float)
    seed = np.hypot(xx - cx, yy - cy) <= seed_radius

    segments: List[Tuple[float, np.ndarray]] = []
    used_levels: List[float] = []

    reject = None
    if reject_mask is not None and bool(config.get("rejectSourceMaskInFaintTail", True)):
        reject = np.asarray(reject_mask, dtype=bool)
        dil = int(config.get("tailRejectMaskDilationPx", 3))
        if dil > 0:
            reject = binary_dilation(reject, structure=disk_structure(dil))

    for multiplier in multipliers:
        level = float(sigma) * float(multiplier)

        natural_envelope = corridor
        if bool(config.get("faintTailUseSignalEnvelope", True)):
            natural_envelope = signal_following_tail_envelope(
                signal, sigma, level, corridor, center_xy, direction_xy, config
            )

        binary = np.isfinite(signal) & (signal >= level) & corridor & natural_envelope
        if reject is not None:
            binary &= ~reject
        binary = remove_small_components(binary, min_area_px=max(3, min_area // 12))
        if bridge_radius > 0:
            # Close small gaps in the faint tail, but do not automatically
            # dilate the mask into the whole corridor. The old behaviour could
            # create a block/rectangle-shaped accepted tail when the thresholded
            # signal touched the corridor boundary.
            bridge = disk_structure(bridge_radius)
            binary = binary_closing(binary, structure=bridge)
            binary &= corridor & natural_envelope
            if reject is not None:
                binary &= ~reject

        dil_after = int(config.get("faintTailDilationRadiusPx", 0))
        if dil_after > 0:
            binary = binary_dilation(binary, structure=disk_structure(dil_after))
            binary &= corridor & natural_envelope
            if reject is not None:
                binary &= ~reject

        labels, nlab = ndi_label(binary)
        if nlab == 0:
            continue

        seed_labels = np.unique(labels[seed & (labels > 0)])
        if seed_labels.size == 0:
            best_id = None
            best_dist = float("inf")
            for lab_id in range(1, nlab + 1):
                pts = np.argwhere(labels == lab_id)
                if pts.size == 0:
                    continue
                d = np.min((pts[:, 1] - cx) ** 2 + (pts[:, 0] - cy) ** 2)
                if d < best_dist:
                    best_dist = float(d)
                    best_id = lab_id
            if best_id is None or best_dist > seed_radius * seed_radius * 4:
                continue
            seed_labels = np.asarray([best_id], dtype=int)

        component = np.isin(labels, seed_labels)
        component = remove_small_components(component, min_area_px=min_area)

        # Filling holes is useful for the bright coma, but for the very faint
        # tail it can also turn source/background artefacts into round cut-outs
        # or make a broad rectangular corridor look like accepted comet signal.
        if bool(config.get("faintTailFillHoles", False)):
            component = binary_fill_holes(component)

        component &= corridor & natural_envelope

        # Trim corridor-created geometry back to actual smoothed FITS signal.
        # This removes the artificial rectangular/block-like tail end while
        # preserving the inner coma and the real connected tail signal.
        if bool(config.get("faintTailTrimToSignal", False)):
            trim_fraction = float(config.get("faintTailTrimLevelFraction", 0.58))
            trim_threshold = float(level) * trim_fraction
            keep_signal = np.isfinite(signal) & (signal >= trim_threshold)

            no_trim_radius = float(config.get("faintTailNoTrimRadiusPx", 72))
            near_nucleus = np.hypot(xx - cx, yy - cy) <= no_trim_radius

            component = component & (keep_signal | near_nucleus)

            trim_close = float(config.get("faintTailTrimCloseRadiusPx", 2))
            if trim_close > 0:
                component = binary_closing(component, structure=disk_structure(trim_close))
                component &= corridor & natural_envelope
                component &= (keep_signal | near_nucleus)

            component = remove_small_components(component, min_area_px=max(8, min_area // 2))

            labels2, nlab2 = ndi_label(component)
            if nlab2 > 0:
                seed_labels2 = np.unique(labels2[seed & (labels2 > 0)])
                if seed_labels2.size > 0:
                    component = np.isin(labels2, seed_labels2)
                else:
                    best_id = None
                    best_dist = float("inf")
                    for lab_id in range(1, nlab2 + 1):
                        pts = np.argwhere(labels2 == lab_id)
                        if pts.size == 0:
                            continue
                        d = np.min((pts[:, 1] - cx) ** 2 + (pts[:, 0] - cy) ** 2)
                        if d < best_dist:
                            best_dist = float(d)
                            best_id = lab_id
                    if best_id is not None:
                        component = labels2 == best_id

        # Optional round/back-head recovery: if the low-level comet signal
        # around the nucleus is real but one side of the coma/back-tail is cut
        # by the tail extraction rules, add the connected low-level head region
        # back before the final smoothing step.  This makes the border enclose
        # the whole visible comet head/back side without drawing a rectangle.
        if bool(config.get("faintTailIncludeBackHead", False)):
            head_radius = float(config.get("faintTailBackHeadRadiusPx", 145))
            head_min_sigma = float(config.get("faintTailBackHeadMinSigma", 0.45))
            head_level_fraction = float(config.get("faintTailBackHeadLevelFraction", 0.22))
            head_threshold = max(float(sigma) * head_min_sigma, float(level) * head_level_fraction)
            head_region = np.hypot(xx - cx, yy - cy) <= head_radius
            head = np.isfinite(signal) & (signal >= head_threshold) & head_region
            if reject is not None and bool(config.get("faintTailBackHeadRespectRejectMask", False)):
                head &= ~reject
            close_r = int(config.get("faintTailBackHeadCloseRadiusPx", 8))
            if close_r > 0:
                head = binary_closing(head, structure=disk_structure(close_r))
            grow_head = int(config.get("faintTailBackHeadGrowPx", 5))
            if grow_head > 0:
                head = binary_dilation(head, structure=disk_structure(grow_head))
            head &= head_region
            labels_h, nlab_h = ndi_label(head)
            if nlab_h > 0:
                seed_labels_h = np.unique(labels_h[seed & (labels_h > 0)])
                if seed_labels_h.size > 0:
                    head = np.isin(labels_h, seed_labels_h)
                else:
                    best_id = None
                    best_dist = float("inf")
                    for lab_id in range(1, nlab_h + 1):
                        pts = np.argwhere(labels_h == lab_id)
                        if pts.size == 0:
                            continue
                        d = np.min((pts[:, 1] - cx) ** 2 + (pts[:, 0] - cy) ** 2)
                        if d < best_dist:
                            best_dist = float(d)
                            best_id = lab_id
                    if best_id is not None:
                        head = labels_h == best_id
                component = component | head

        # Optional final growth: expand the accepted faint tail a little, but
        # only inside the signal-following envelope.  This makes the border
        # enclose the visible comet tail without returning to a rectangular
        # corridor-shaped mask.
        grow_px = int(config.get("faintTailFinalGrowPx", 0))
        if grow_px > 0 and np.any(component):
            component = binary_dilation(component, structure=disk_structure(grow_px))
            component &= corridor & natural_envelope
            if reject is not None:
                component &= ~reject

        # Smooth the final faint-tail mask boundary. This removes artificial
        # right angles without drawing a predefined smooth shape.
        smooth_mask_sigma = float(config.get("faintTailMaskSmoothSigmaPx", 1.6))
        if smooth_mask_sigma > 0 and np.any(component):
            sm = gaussian_filter(component.astype(float), sigma=smooth_mask_sigma, mode="nearest")
            component = sm >= float(config.get("faintTailMaskSmoothThreshold", 0.36))
            component &= corridor & natural_envelope
            component = remove_small_components(component, min_area_px=max(8, min_area // 2))
            labels3, nlab3 = ndi_label(component)
            if nlab3 > 0:
                seed_labels3 = np.unique(labels3[seed & (labels3 > 0)])
                if seed_labels3.size > 0:
                    component = np.isin(labels3, seed_labels3)

        if int(np.count_nonzero(component)) > int(max_area_fraction * h * w):
            continue

        if bool(config.get("faintTailPlotBinarySupportContours", False)):
            # Old/debug behaviour: contour the support mask itself.  This can
            # show straight corridor or manual-cleanup edges, so it is off by
            # default.
            contours = [seg for seg in measure.find_contours(component.astype(float), 0.5) if seg.shape[0] >= min_points]
        else:
            contours = isophote_segments_inside_component(signal, level, component, min_points, config)
            if not contours and bool(config.get("faintTailFallbackToBinarySupportContours", False)):
                contours = [seg for seg in measure.find_contours(component.astype(float), 0.5) if seg.shape[0] >= min_points]

        if not contours:
            continue
        seg = max(contours, key=lambda s: max_forward_extent_px(s, center_xy, direction_xy))
        if max_forward_extent_px(seg, center_xy, direction_xy) < min_forward:
            continue
        segments.append((level, seg))
        used_levels.append(level)

    return segments, used_levels, corridor


def primary_segments_by_level(segments: Iterable[Tuple[float, np.ndarray]], nucleus_xy: Tuple[float, float]) -> List[Tuple[float, np.ndarray]]:
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


def area_matched_synthetic_segments(synthetic_image: np.ndarray, observed_segments: Iterable[Tuple[float, np.ndarray]], nucleus_xy: Tuple[float, float], min_points: int, keep_radius_px: float, search_steps: int) -> Tuple[np.ndarray, List[Tuple[float, np.ndarray]], List[Dict[str, float]], List[Tuple[float, np.ndarray, float, np.ndarray]]]:
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
        segs = filter_segments_near_nucleus(contour_segments(synthetic_image, [float(level)], min_points), nucleus_xy, keep_radius_px)
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
    for obs_level, obs_seg, target_area in sorted(targets, key=lambda item: item[2], reverse=True):
        ranked = sorted(candidates, key=lambda item: abs(math.log(max(item[2], 1e-12) / target_area)))
        selected = next((item for item in ranked if item[0] not in used_levels), ranked[0])
        syn_level, syn_seg, syn_area = selected
        used_levels.add(syn_level)
        matches.append((obs_level, obs_seg, syn_level, syn_seg))
        details.append({"observedLevel": float(obs_level), "observedAreaPx2": float(target_area), "syntheticLevel": float(syn_level), "syntheticAreaPx2": float(syn_area), "areaRatioSyntheticToObserved": float(syn_area / target_area)})
    matches.sort(key=lambda item: segment_area_px2(item[1]), reverse=True)
    chosen = [(syn_level, syn_seg) for _, _, syn_level, syn_seg in matches]
    details.sort(key=lambda item: item["observedAreaPx2"], reverse=True)
    return np.asarray([level for level, _ in chosen], dtype=float), chosen, details, matches


def segment_to_mask(seg: np.ndarray, shape: Tuple[int, int]) -> np.ndarray:
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
    return {"intersectionPx": intersection, "unionPx": union, "index": float(intersection / union) if union > 0 else None}


def shifted_mask(mask: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """Shift a binary mask by integer pixels. Positive dx moves right, positive dy moves up in image coordinates."""
    m = np.asarray(mask, dtype=bool)
    h, w = m.shape
    out = np.zeros_like(m, dtype=bool)
    ys = max(0, dy)
    ye = min(h, h + dy)
    xs = max(0, dx)
    xe = min(w, w + dx)
    sy0 = max(0, -dy)
    sx0 = max(0, -dx)
    sy1 = sy0 + (ye - ys)
    sx1 = sx0 + (xe - xs)
    if ye > ys and xe > xs:
        out[ys:ye, xs:xe] = m[sy0:sy1, sx0:sx1]
    return out


def best_shifted_synthetic_mask(observed_mask: np.ndarray, synthetic_mask: np.ndarray, valid_outer: np.ndarray, max_shift_px: int) -> Tuple[np.ndarray, int, int, Dict[str, float | int | None], Dict[str, float | int | None]]:
    """Return synthetic mask shifted to maximize tail/outside-inner Jaccard.

    This is intended as a small registration-tolerance sensitivity check, not as
    a replacement for the strict no-shift score.  The chosen dx/dy are written
    into comparison_summary.json and jaccard_metrics.csv.
    """
    max_shift = max(0, int(max_shift_px))
    best_mask = np.asarray(synthetic_mask, dtype=bool)
    best_dx, best_dy = 0, 0
    best_all = jaccard_counts(observed_mask, best_mask)
    best_outer = jaccard_counts(observed_mask, best_mask, valid_outer)
    best_score = -1.0 if best_outer.get("index") is None else float(best_outer["index"])
    best_all_score = -1.0 if best_all.get("index") is None else float(best_all["index"])
    if max_shift <= 0:
        return best_mask, best_dx, best_dy, best_all, best_outer
    for dy in range(-max_shift, max_shift + 1):
        for dx in range(-max_shift, max_shift + 1):
            candidate = shifted_mask(synthetic_mask, dx, dy) if (dx or dy) else synthetic_mask
            all_px = jaccard_counts(observed_mask, candidate)
            outer = jaccard_counts(observed_mask, candidate, valid_outer)
            score = -1.0 if outer.get("index") is None else float(outer["index"])
            all_score = -1.0 if all_px.get("index") is None else float(all_px["index"])
            if score > best_score or (abs(score - best_score) < 1e-12 and all_score > best_all_score):
                best_mask = np.asarray(candidate, dtype=bool)
                best_dx, best_dy = dx, dy
                best_all, best_outer = all_px, outer
                best_score, best_all_score = score, all_score
    return best_mask, best_dx, best_dy, best_all, best_outer




def keep_component_near_center(mask: np.ndarray, center_xy: Tuple[float, float], radius_px: float) -> np.ndarray:
    mask = np.asarray(mask, dtype=bool)
    labels, nlab = ndi_label(mask)
    if nlab == 0:
        return np.zeros_like(mask, dtype=bool)
    cx, cy = center_xy
    yy, xx = np.indices(mask.shape, dtype=float)
    central = np.hypot(xx - cx, yy - cy) <= float(radius_px)
    labs = np.unique(labels[central & (labels > 0)])
    if labs.size:
        return np.isin(labels, labs)
    # Fallback: keep largest component.
    sizes = np.bincount(labels.ravel())
    if sizes.size <= 1:
        return mask
    sizes[0] = 0
    return labels == int(np.argmax(sizes))


def smooth_mask_for_jaccard(mask: np.ndarray, center_xy: Tuple[float, float], config: Dict, prefix: str) -> np.ndarray:
    """
    Smooth binary isophote masks before Jaccard/display.

    This is not manual drawing.  It is a deterministic post-processing step to
    avoid raw rasterized contour masks with unnatural straight cuts near the
    head/tail-base transition.  The operation is similar to comparing a slightly
    smoothed isophote rather than a jagged pixel mask.
    """
    out = np.asarray(mask, dtype=bool)
    if not bool(config.get('jaccardSmoothMasks', False)):
        return out

    grow = int(config.get(prefix + 'GrowPx', config.get('jaccardMaskGrowPx', 0)))
    close_px = float(config.get(prefix + 'ClosePx', config.get('jaccardMaskClosePx', 0)))
    sigma = float(config.get(prefix + 'SmoothSigmaPx', config.get('jaccardMaskSmoothSigmaPx', 0)))
    threshold = float(config.get(prefix + 'SmoothThreshold', config.get('jaccardMaskSmoothThreshold', 0.34)))
    fill = bool(config.get(prefix + 'FillHoles', config.get('jaccardMaskFillHoles', True)))
    keep_radius = float(config.get(prefix + 'KeepRadiusPx', config.get('jaccardMaskKeepRadiusPx', 95)))

    if close_px > 0:
        out = binary_closing(out, structure=disk_structure(close_px))
    if grow > 0:
        out = binary_dilation(out, structure=disk_structure(grow))
    if sigma > 0:
        sm = gaussian_filter(out.astype(float), sigma=sigma, mode='nearest')
        out = sm >= threshold
    if fill:
        out = binary_fill_holes(out)
    out = keep_component_near_center(out, center_xy, keep_radius)
    return np.asarray(out, dtype=bool)

def whole_comet_mask(image: np.ndarray, center_xy: Tuple[float, float], threshold: float) -> np.ndarray:
    """Filled mask of the comet obtained by thresholding an image and keeping
    the nucleus-connected blob. Used as a Jaccard fallback when no closed,
    area-matched isophote pairs are available, so a score and figure can still
    be produced from the overall shapes."""
    image = np.asarray(image, dtype=float)
    mask = np.isfinite(image) & (image > float(threshold))
    if not mask.any():
        return mask
    mask = binary_fill_holes(mask)
    labels, n = ndi_label(mask)
    if n == 0:
        return mask
    cx, cy = int(round(center_xy[0])), int(round(center_xy[1]))
    lab = int(labels[cy, cx]) if (0 <= cy < mask.shape[0] and 0 <= cx < mask.shape[1]) else 0
    if lab == 0:
        counts = np.bincount(labels.ravel())
        counts[0] = 0
        lab = int(counts.argmax())
    return labels == lab


def calculate_jaccard_metrics(matches: Sequence[Tuple[float, np.ndarray, float, np.ndarray]], shape: Tuple[int, int], center_xy: Tuple[float, float], inner_exclusion_radius_px: float, pixel_scale_arcsec: float, max_shift_px: int = 0, config: Dict | None = None, fallback_masks: Tuple[np.ndarray, np.ndarray] | None = None) -> Tuple[Dict[str, object], List[Dict[str, object]]]:
    if config is None:
        config = {}
    valid_outer = outside_radius_mask(shape, center_xy, inner_exclusion_radius_px)
    layers: List[Dict[str, object]] = []
    skipped = 0
    for observed_level, observed_seg, synthetic_level, synthetic_seg in matches:
        observed_mask_raw = segment_to_mask(observed_seg, shape)
        synthetic_mask_raw = segment_to_mask(synthetic_seg, shape)
        observed_mask = smooth_mask_for_jaccard(observed_mask_raw, center_xy, config, 'jaccardObservedMask')
        synthetic_mask_unshifted = smooth_mask_for_jaccard(synthetic_mask_raw, center_xy, config, 'jaccardSyntheticMask')
        if not observed_mask.any() or not synthetic_mask_unshifted.any():
            skipped += 1
            continue
        strict_all_px = jaccard_counts(observed_mask, synthetic_mask_unshifted)
        strict_outside_inner = jaccard_counts(observed_mask, synthetic_mask_unshifted, valid_outer)
        synthetic_mask, best_dx, best_dy, all_px, outside_inner = best_shifted_synthetic_mask(observed_mask, synthetic_mask_unshifted, valid_outer, max_shift_px)
        layers.append({
            "observedLevel": float(observed_level),
            "syntheticLevel": float(synthetic_level),
            "observedAreaPx": int(np.count_nonzero(observed_mask)),
            "syntheticAreaPx": int(np.count_nonzero(synthetic_mask)),
            "syntheticAreaPxStrict": int(np.count_nonzero(synthetic_mask_unshifted)),
            "allPixels": all_px,
            "outsideInnerComa": outside_inner,
            "strictAllPixels": strict_all_px,
            "strictOutsideInnerComa": strict_outside_inner,
            "jaccardShiftDxPx": int(best_dx),
            "jaccardShiftDyPx": int(best_dy),
            "observedMask": observed_mask,
            "syntheticMask": synthetic_mask,
            "syntheticMaskStrict": synthetic_mask_unshifted,
        })

    used_fallback = False
    if not layers and fallback_masks is not None:
        obs_fb = np.asarray(fallback_masks[0], dtype=bool)
        syn_fb = np.asarray(fallback_masks[1], dtype=bool)
        if obs_fb.any() and syn_fb.any():
            strict_all_px = jaccard_counts(obs_fb, syn_fb)
            strict_outside_inner = jaccard_counts(obs_fb, syn_fb, valid_outer)
            synthetic_mask, best_dx, best_dy, all_px, outside_inner = best_shifted_synthetic_mask(obs_fb, syn_fb, valid_outer, max_shift_px)
            layers.append({
                "observedLevel": None,
                "syntheticLevel": None,
                "observedAreaPx": int(np.count_nonzero(obs_fb)),
                "syntheticAreaPx": int(np.count_nonzero(synthetic_mask)),
                "syntheticAreaPxStrict": int(np.count_nonzero(syn_fb)),
                "allPixels": all_px,
                "outsideInnerComa": outside_inner,
                "strictAllPixels": strict_all_px,
                "strictOutsideInnerComa": strict_outside_inner,
                "jaccardShiftDxPx": int(best_dx),
                "jaccardShiftDyPx": int(best_dy),
                "observedMask": obs_fb,
                "syntheticMask": synthetic_mask,
                "syntheticMaskStrict": syn_fb,
            })
            used_fallback = True

    def combined(key: str) -> Dict[str, float | int | None]:
        intersection = int(sum(int(layer[key]["intersectionPx"]) for layer in layers))
        union = int(sum(int(layer[key]["unionPx"]) for layer in layers))
        indices = [float(layer[key]["index"]) for layer in layers if layer[key]["index"] is not None]
        return {"intersectionPxAcrossLayers": intersection, "unionPxAcrossLayers": union, "index": float(intersection / union) if union > 0 else None, "meanPerLayerIndex": float(np.mean(indices)) if indices else None, "minimumPerLayerIndex": float(np.min(indices)) if indices else None, "maximumPerLayerIndex": float(np.max(indices)) if indices else None}

    serializable_layers: List[Dict[str, object]] = []
    for layer_number, layer in enumerate(layers, start=1):
        serializable_layers.append({"layer": layer_number, "observedLevel": layer["observedLevel"], "syntheticLevel": layer["syntheticLevel"], "observedAreaPx": layer["observedAreaPx"], "syntheticAreaPx": layer["syntheticAreaPx"], "strictSyntheticAreaPx": layer["syntheticAreaPxStrict"], "allPixels": layer["allPixels"], "outsideInnerComa": layer["outsideInnerComa"], "strictAllPixels": layer["strictAllPixels"], "strictOutsideInnerComa": layer["strictOutsideInnerComa"], "jaccardShiftDxPx": layer["jaccardShiftDxPx"], "jaccardShiftDyPx": layer["jaccardShiftDyPx"]})

    summary: Dict[str, object] = {
        "definition": "Jaccard index = intersection / union of rasterized interiors of paired, area-matched, nucleus-associated closed isophotes.",
        "comparisonBasis": "relative morphology after nucleus alignment; optional small integer-pixel registration tolerance for sensitivity testing",
        "maskPostProcessing": "binary masks can be optionally smoothed/closed for isophote-style comparison; see jaccardSmoothMasks in config",
        "layersUsed": len(layers),
        "usedWholeShapeFallback": used_fallback,
        "layersSkippedBecauseContourWasNotClosed": skipped,
        "innerComaExclusionRadiusPx": float(inner_exclusion_radius_px),
        "innerComaExclusionRadiusArcsec": float(inner_exclusion_radius_px * pixel_scale_arcsec),
        "jaccardShiftMaxPx": int(max_shift_px),
        "multiLevelAllPixels": combined("allPixels"),
        "multiLevelOutsideInnerComa": combined("outsideInnerComa"),
        "strictNoShiftMultiLevelAllPixels": combined("strictAllPixels"),
        "strictNoShiftMultiLevelOutsideInnerComa": combined("strictOutsideInnerComa"),
        "perContour": serializable_layers,
    }
    return summary, layers


def write_jaccard_csv(path: Path, metrics: Dict[str, object]) -> None:
    all_px = metrics.get("multiLevelAllPixels", {})
    outer = metrics.get("multiLevelOutsideInnerComa", {})
    strict_all = metrics.get("strictNoShiftMultiLevelAllPixels", {})
    strict_outer = metrics.get("strictNoShiftMultiLevelOutsideInnerComa", {})
    rows = [
        {"metric": "main_tail_shape_score", "value": outer.get("index")},
        {"metric": "full_shape_score_including_center", "value": all_px.get("index")},
        {"metric": "strict_no_shift_tail_shape_score", "value": strict_outer.get("index")},
        {"metric": "strict_no_shift_full_shape_score", "value": strict_all.get("index")},
        {"metric": "jaccard_shift_tolerance_pixels", "value": metrics.get("jaccardShiftMaxPx")},
        {"metric": "outline_levels_compared", "value": metrics.get("layersUsed")},
        {"metric": "ignored_center_radius_pixels", "value": metrics.get("innerComaExclusionRadiusPx")},
        {"metric": "ignored_center_radius_arcsec", "value": metrics.get("innerComaExclusionRadiusArcsec")},
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["metric", "value"])
        writer.writeheader()
        writer.writerows(rows)


def save_jaccard_diagnostic_figure(path: Path, layers: Sequence[Dict[str, object]], center_xy: Tuple[float, float], inner_exclusion_radius_px: float, pixel_scale_arcsec: float, primary_score: float | None) -> None:
    if not layers:
        fig, ax = plt.subplots(figsize=(6, 5), constrained_layout=True)
        ax.text(0.5, 0.5, "Jaccard not available\n(no overlapping comet shape found)", ha="center", va="center", fontsize=12, transform=ax.transAxes)
        ax.set_axis_off()
        score_text = "not available" if primary_score is None else f"{float(primary_score):.3f}"
        fig.suptitle(f"Jaccard score: {score_text}")
        fig.savefig(path, dpi=160)
        plt.close(fig)
        return
    observed_count = np.sum([np.asarray(layer["observedMask"], dtype=int) for layer in layers], axis=0)
    synthetic_count = np.sum([np.asarray(layer["syntheticMask"], dtype=int) for layer in layers], axis=0)
    largest_observed = np.asarray(layers[0]["observedMask"], dtype=bool)
    largest_simulated = np.asarray(layers[0]["syntheticMask"], dtype=bool)
    match_map = np.zeros(largest_observed.shape, dtype=int)
    match_map[largest_observed & ~largest_simulated] = 1
    match_map[~largest_observed & largest_simulated] = 2
    match_map[largest_observed & largest_simulated] = 3
    extent = image_extent(largest_observed.shape, pixel_scale_arcsec)
    cx, cy = center_xy
    circle_center = ((cx - (largest_observed.shape[1] - 1) / 2.0) * pixel_scale_arcsec, (cy - (largest_observed.shape[0] - 1) / 2.0) * pixel_scale_arcsec)
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.8), constrained_layout=True)
    axes[0].imshow(observed_count, origin="lower", interpolation="nearest", extent=extent, cmap="viridis")
    axes[0].set_title("Observed comet shape")
    axes[1].imshow(synthetic_count, origin="lower", interpolation="nearest", extent=extent, cmap="viridis")
    axes[1].set_title("Simulated comet shape")
    match_colors = ListedColormap(["white", "#E69F00", "#56B4E9", "#009E73"])
    axes[2].imshow(match_map, origin="lower", interpolation="nearest", extent=extent, cmap=match_colors, vmin=0, vmax=3)
    axes[2].set_title("Where the largest shapes match")
    axes[2].legend(handles=[Patch(facecolor="#009E73", label="Both shapes"), Patch(facecolor="#E69F00", label="Observed only"), Patch(facecolor="#56B4E9", label="Simulation only")], loc="upper right", fontsize=8, framealpha=0.9)
    for ax in axes:
        ax.add_patch(plt.Circle(circle_center, inner_exclusion_radius_px * pixel_scale_arcsec, fill=False, color="black", lw=1.2, ls="--"))
        ax.set_aspect("equal")
        ax.set_xlabel("left / right offset [arcsec]")
        ax.set_ylabel("up / down offset [arcsec]")
    score_text = "not available" if primary_score is None else f"{float(primary_score):.3f}"
    fig.suptitle(f"Jaccard score: {score_text}")
    fig.savefig(path, dpi=220)
    plt.close(fig)


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


def plot_segments(ax, segments: Iterable[Tuple[float, np.ndarray]], color: str, linewidth: float, scale: float) -> None:
    for _, seg in segments:
        h = ax._comet_frame_height_px
        w = ax._comet_frame_width_px
        x = (seg[:, 1] - (w - 1) / 2.0) * scale
        y = (seg[:, 0] - (h - 1) / 2.0) * scale
        ax.plot(x, y, color=color, lw=linewidth)


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


def cleanup_output_folder(out_dir: Path) -> None:
    obsolete = ["contour_component_panels.png", "contour_lines.csv", "contour_lines_fixed_fractions.png", "observed_standardized_crop.png", "observed_tail_diagnostic.png"]
    for name in obsolete:
        path = out_dir / name
        if path.exists():
            path.unlink()


def save_processing_diagnostic(path: Path, observed_sky: np.ndarray, cleaned_residual: np.ndarray, source_mask: np.ndarray, observed_signal: np.ndarray, faint_signal: np.ndarray | None, corridor: np.ndarray | None, observed_segments: List[Tuple[float, np.ndarray]], center_xy: Tuple[float, float], pixel_scale: float, show_corridor: bool = False) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(12, 8), constrained_layout=True)
    extent = image_extent(observed_sky.shape, pixel_scale)
    axes[0, 0].imshow(asinh_preview(observed_sky), cmap="gray", origin="lower", extent=extent)
    axes[0, 0].set_title("Resampled FITS")
    axes[0, 1].imshow(cleaned_residual, cmap="gray", origin="lower", extent=extent, vmin=np.percentile(cleaned_residual, 2), vmax=np.percentile(cleaned_residual, 99.5))
    axes[0, 1].set_title("Background-subtracted / source-cleaned")
    axes[1, 0].imshow(source_mask, cmap="gray", origin="lower", extent=extent)
    axes[1, 0].set_title("Masked field sources")
    show = observed_signal if faint_signal is None else faint_signal
    axes[1, 1].imshow(show, cmap="gray", origin="lower", extent=extent, vmin=np.percentile(show, 2), vmax=np.percentile(show, 99.5))
    axes[1, 1].set_title("Cleaned tail signal + accepted contours")
    for ax in axes.flat:
        prepare_axis(ax, observed_sky.shape, pixel_scale)
        ax.set_xticks([])
        ax.set_yticks([])
    if corridor is not None and show_corridor:
        for seg in measure.find_contours(corridor.astype(float), 0.5):
            h, w = observed_sky.shape
            x = (seg[:, 1] - (w - 1) / 2.0) * pixel_scale
            y = (seg[:, 0] - (h - 1) / 2.0) * pixel_scale
            axes[1, 1].plot(x, y, color="dodgerblue", lw=0.8, ls="--")
    plot_segments(axes[1, 1], observed_segments, "black", 0.9, pixel_scale)
    fig.savefig(path, dpi=220)
    plt.close(fig)


def build_outputs(inputs: Inputs) -> None:
    meta = json.loads(inputs.meta_json.read_text(encoding="utf-8"))
    config = dict(DEFAULT_CONFIG)
    hints = meta.get("comparisonHints")
    if isinstance(hints, dict):
        config.update(hints)
    if inputs.config_json is not None:
        config.update(json.loads(inputs.config_json.read_text(encoding="utf-8")))
    if inputs.manual_cleanup_json is not None:
        manual_overrides = json.loads(inputs.manual_cleanup_json.read_text(encoding="utf-8"))
        config.update(manual_overrides)
        config["manualCleanupEnabled"] = True

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
    px, py = project_particles_standard_frame(particles, sim_nuc_ra, sim_nuc_dec, observed_dec, width_px, height_px, pixel_scale)

    # Use the synthetic tail direction already at the cleaning stage so field-source
    # masks do not cut circular/box-like holes through the comet tail.
    pre_weight_column = str(config.get("syntheticWeightColumn", "brightness_weight"))
    pre_weights = particles[pre_weight_column] if pre_weight_column in particles else np.ones_like(px)
    pre_tail_direction = synthetic_tail_direction(px, py, pre_weights, center_xy, inner_exclusion_px=float(config.get("innerComaMaskRadiusPx", 14)))

    cleaned_residual, background_model, source_mask = photutils_clean_observed_image(observed_sky, center_xy, config, tail_direction_xy=pre_tail_direction)
    observed_positive, noise_sigma = observed_tail_signal(cleaned_residual, float(config.get("observedSmoothSigmaPx", 2.0)))

    drawn_cleanup_polygons: List[List[List[float]]] = []
    if inputs.draw_cleanup:
        drawn_cleanup_polygons = draw_manual_cleanup_polygons_interactive(
            observed_sky,
            observed_positive,
            noise_sigma,
            source_mask,
            center_xy,
            pixel_scale,
            config,
            title=f"Manual cleanup for {inputs.observed_fits.name}",
        )
        if drawn_cleanup_polygons:
            existing_polygons = list(config.get("manualCleanupErasePolygons", []) or [])
            config["manualCleanupErasePolygons"] = existing_polygons + drawn_cleanup_polygons
            config["manualCleanupEnabled"] = True
            config["manualCleanupCoordinateSystem"] = "arcsec"
            config["manualCleanupDiagnostic"] = True

    manual_erase_mask, manual_keep_mask, manual_cleanup_counts = build_manual_cleanup_masks(observed_sky.shape, center_xy, pixel_scale, config)
    manual_cleanup_active = bool(np.any(manual_erase_mask) or manual_keep_mask is not None)
    if manual_cleanup_active:
        observed_positive = apply_manual_cleanup_to_signal(observed_positive, manual_erase_mask, manual_keep_mask)
        if bool(config.get("manualCleanupApplyToSourceMask", True)) and np.any(manual_erase_mask):
            source_mask = source_mask | manual_erase_mask

    obs_levels = levels_from_noise(observed_positive, noise_sigma, config.get("observedNoiseSigmaMultipliers", [2.2, 3.2, 4.8, 7.0, 10.5, 16.0]))
    min_points = int(config.get("minContourPoints", 16))

    observed_for_contours = observed_positive
    observed_support_mask = None
    if bool(config.get("observedUseNucleusConnectedSupport", False)) and obs_levels.size > 0:
        observed_support_mask = nucleus_connected_support_mask(
            observed_positive,
            float(obs_levels[0]),
            center_xy,
            config,
            source_mask=source_mask,
        )
        if np.any(observed_support_mask):
            observed_for_contours = np.where(observed_support_mask, observed_positive, 0.0)

    # First pass: normal observed contours from the cleaned residual image,
    # optionally gated to the nucleus-connected comet signal only.
    observed_segments_raw = contour_segments(observed_for_contours, obs_levels, min_points)
    observed_segments_raw = filter_segments_near_nucleus(
        observed_segments_raw, center_xy, float(config.get("observedContourAssociationRadiusPx", 58))
    )
    observed_segments = filter_noisy_observed_segments(
        observed_segments_raw, source_mask, observed_sky.shape, center_xy, config, tail=False
    )

    # Safety fallback: if the source/noise filters remove all observed contours,
    # do not silently create a red-only plot.  The image has already been
    # background-subtracted and field-source-cleaned, so it is better to keep
    # the nucleus-associated contours than to export nothing.
    observed_fallback_used = False
    if not observed_segments and bool(config.get("allowObservedContourFallback", True)):
        observed_segments = list(observed_segments_raw)
        observed_fallback_used = True

    # Second fallback: use slightly lower but still conservative observed
    # thresholds if the normal levels find nothing.
    if not observed_segments and bool(config.get("allowObservedContourFallback", True)):
        fallback_levels = levels_from_noise(
            observed_for_contours,
            noise_sigma,
            config.get("fallbackObservedNoiseSigmaMultipliers", [1.6, 2.1, 2.8, 3.8, 5.2, 7.5, 11.0]),
        )
        observed_segments = contour_segments(observed_for_contours, fallback_levels, min_points)
        observed_segments = filter_segments_near_nucleus(
            observed_segments, center_xy, float(config.get("observedContourAssociationRadiusPx", 58))
        )
        observed_fallback_used = True

    weight_column = str(config.get("syntheticWeightColumn", "brightness_weight"))
    if weight_column not in particles:
        raise ValueError(f"Unknown syntheticWeightColumn={weight_column!r}")
    weights = particles[weight_column]

    faint_tail_levels: List[float] = []
    tail_direction: Tuple[float, float] | None = None
    tail_corridor: np.ndarray | None = None
    faint_signal: np.ndarray | None = None
    if bool(config.get("includeFaintTailContours", True)) and str(config.get("faintTailMode", "safe")).lower() != "off":
        faint_signal, faint_sigma = observed_tail_signal(cleaned_residual, float(config.get("faintTailSmoothSigmaPx", 4.2)))
        if manual_cleanup_active:
            faint_signal = apply_manual_cleanup_to_signal(faint_signal, manual_erase_mask, manual_keep_mask)
        syn_dir = synthetic_tail_direction(px, py, weights, center_xy, inner_exclusion_px=float(config.get("innerComaMaskRadiusPx", 14)))
        obs_dir = observed_tail_direction(faint_signal, faint_sigma, center_xy, inner_exclusion_px=float(config.get("innerComaMaskRadiusPx", 14)))
        source = str(config.get("tailDirectionSource", "synthetic")).lower()
        if source == "observed":
            tail_direction = obs_dir or syn_dir
        elif source == "auto":
            tail_direction = obs_dir or syn_dir
        else:
            tail_direction = syn_dir or obs_dir
        extra_segments, faint_tail_levels, tail_corridor = faint_tail_segments(faint_signal, faint_sigma, config.get("faintTailNoiseSigmaMultipliers", [1.60, 2.00, 2.50, 3.20]), center_xy, tail_direction, config, reject_mask=source_mask)
        extra_segments = filter_noisy_observed_segments(
            extra_segments, source_mask, observed_sky.shape, center_xy, config, tail=True
        )
        observed_segments = append_unique_segments(observed_segments, extra_segments, area_tolerance_fraction=0.005)
        observed_segments_before_final_filter = list(observed_segments)
        observed_segments = filter_noisy_observed_segments(
            observed_segments, source_mask, observed_sky.shape, center_xy, config, tail=False
        )
        if not observed_segments and bool(config.get("allowObservedContourFallback", True)):
            observed_segments = observed_segments_before_final_filter
            observed_fallback_used = True

    # Optional final cleanup for survey fields with many stars/noise islands:
    # plot only the primary closed contour around the comet for each level.
    # This removes unrelated background contours from the final black isophotes
    # without changing the FITS data or the synthetic model.
    if bool(config.get("observedPrimaryContoursOnly", False)) and observed_segments:
        observed_segments = primary_segments_by_level(observed_segments, center_xy)

    total_map = make_map(px, py, weights, observed_sky.shape)
    total_smoothed = gaussian_filter(total_map, sigma=max(0.0, float(config.get("syntheticSmoothSigmaPx", 2.8))), mode="nearest")
    total_smoothed = add_centered_gaussian_core(total_smoothed, float(config.get("syntheticCoreFluxFraction", 0.0)), float(config.get("syntheticCoreSigmaPx", config.get("syntheticSmoothSigmaPx", 2.8))))

    syn_fractions = list(config.get("syntheticLevelFractions", [0.035, 0.065, 0.12, 0.22, 0.40, 0.65]))
    if bool(config.get("includeFaintTailContours", True)):
        syn_fractions = list(config.get("syntheticFaintTailLevelFractions", [])) + syn_fractions
    fixed_syn_levels = levels_from_fractions(total_smoothed, syn_fractions, float(config.get("syntheticPeakPercentile", 99.8)))
    fixed_synthetic_segments = filter_segments_near_nucleus(contour_segments(total_smoothed, fixed_syn_levels, min_points), center_xy, float(config.get("syntheticContourAssociationRadiusPx", 70)))

    synthetic_level_mode = str(config.get("syntheticLevelMode", "fixed_fraction")).strip().lower()
    area_match_details: List[Dict[str, float]] = []
    jaccard_matches: List[Tuple[float, np.ndarray, float, np.ndarray]] = []
    if synthetic_level_mode == "area_matched":
        syn_levels, synthetic_segments, area_match_details, jaccard_matches = area_matched_synthetic_segments(total_smoothed, observed_segments, center_xy, min_points, float(config.get("syntheticContourAssociationRadiusPx", 70)), int(config.get("syntheticAreaMatchSearchSteps", 180)))
        if not synthetic_segments:
            synthetic_level_mode = "fixed_fraction_fallback"
            syn_levels, synthetic_segments = fixed_syn_levels, fixed_synthetic_segments
    else:
        syn_levels, synthetic_segments = fixed_syn_levels, fixed_synthetic_segments

    if not jaccard_matches:
        _, _, _, jaccard_matches = area_matched_synthetic_segments(total_smoothed, observed_segments, center_xy, min_points, float(config.get("syntheticContourAssociationRadiusPx", 70)), int(config.get("syntheticAreaMatchSearchSteps", 180)))
    jaccard_inner_radius_px = float(config.get("jaccardInnerExclusionRadiusPx", config.get("innerComaMaskRadiusPx", 14)))
    obs_fallback_threshold = float(config.get("jaccardFallbackObservedSigma", 2.0)) * float(noise_sigma)
    observed_fallback_mask = whole_comet_mask(observed_positive, center_xy, obs_fallback_threshold)
    syn_fallback_threshold = float(min(fixed_syn_levels)) if len(fixed_syn_levels) else 0.0
    synthetic_fallback_mask = whole_comet_mask(total_smoothed, center_xy, syn_fallback_threshold)
    jaccard_metrics, jaccard_layers = calculate_jaccard_metrics(jaccard_matches, observed_sky.shape, center_xy, jaccard_inner_radius_px, pixel_scale, int(config.get("jaccardShiftMaxPx", config.get("jaccardMaxShiftPx", 0))), config, fallback_masks=(observed_fallback_mask, synthetic_fallback_mask))

    observed_extent_px = max_extent_px(observed_segments, center_xy)
    observed_extent_arcsec = observed_extent_px * pixel_scale
    min_extent_arcsec = float(config.get("minimumUsefulObservedTailExtentArcsec", 45))
    usable = observed_extent_arcsec >= min_extent_arcsec
    warning = None if usable else f"Observed extended emission reaches only about {observed_extent_arcsec:.1f} arcsec from the nucleus. This FITS is weak for tail-shape calibration."

    inputs.out_dir.mkdir(parents=True, exist_ok=True)
    cleanup_output_folder(inputs.out_dir)
    if inputs.draw_cleanup and drawn_cleanup_polygons:
        drawn_cleanup_spec = {
            "manualCleanupEnabled": True,
            "manualCleanupCoordinateSystem": "arcsec",
            "manualCleanupErasePolygons": drawn_cleanup_polygons,
            "manualCleanupEraseCircles": [],
            "manualCleanupEraseRectangles": [],
            "manualCleanupKeepPolygons": [],
            "note": "This file was saved automatically from --draw-cleanup. It was not required as an input for this run; it is saved only for reproducibility."
        }
        (inputs.out_dir / "manual_cleanup_drawn.json").write_text(json.dumps(drawn_cleanup_spec, indent=2), encoding="utf-8")

    finite = observed_sky[np.isfinite(observed_sky)]
    lo, hi = np.percentile(finite, [2.0, 99.8]) if finite.size else (0.0, 1.0)
    extent = image_extent(observed_sky.shape, pixel_scale)

    write_jaccard_csv(inputs.out_dir / "jaccard_metrics.csv", jaccard_metrics)
    primary_score = jaccard_metrics.get("multiLevelOutsideInnerComa", {}).get("index")
    save_jaccard_diagnostic_figure(inputs.out_dir / "jaccard_masks.png", jaccard_layers, center_xy, jaccard_inner_radius_px, pixel_scale, primary_score)

    if bool(config.get("makeDiagnosticFigures", True)):
        save_processing_diagnostic(inputs.out_dir / "observed_processing_diagnostic.png", observed_sky, cleaned_residual, source_mask, observed_positive, faint_signal, tail_corridor, observed_segments, center_xy, pixel_scale, show_corridor=bool(config.get("diagnosticShowTailCorridor", False)))
    if manual_cleanup_active and bool(config.get("manualCleanupDiagnostic", True)):
        save_manual_cleanup_diagnostic(inputs.out_dir / "manual_cleanup_regions.png", observed_sky, manual_erase_mask, manual_keep_mask, pixel_scale)

    fig, ax = plt.subplots(figsize=(8, 6), constrained_layout=True)
    ax.imshow(observed_sky, cmap="gray", origin="lower", interpolation="nearest", vmin=lo, vmax=hi, extent=extent)
    prepare_axis(ax, observed_sky.shape, pixel_scale)
    plot_segments(ax, observed_segments, "black", 0.95, pixel_scale)
    plot_segments(ax, synthetic_segments, "red", 1.05, pixel_scale)
    ax.plot(0, 0, marker="+", color="black", ms=8, mew=1)
    ax.set_title(str(config.get("title", default_title)))
    fig.savefig(inputs.out_dir / "contour_overlay.png", dpi=240)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(8, 6), constrained_layout=True)
    prepare_axis(ax, observed_sky.shape, pixel_scale)
    plot_segments(ax, observed_segments, "black", 0.95, pixel_scale)
    plot_segments(ax, synthetic_segments, "red", 1.05, pixel_scale)
    ax.set_title(str(config.get("title", default_title)))
    fig.savefig(inputs.out_dir / "contour_lines_only.png", dpi=240)
    plt.close(fig)

    bins = [float(v) for v in config.get("betaBins", meta.get("betaBins", [0, 0.003, 0.01, 0.03, 0.1, 0.3, 1]))]
    panels: List[Tuple[str, np.ndarray]] = [("total", total_smoothed)]
    for b0, b1 in zip(bins[:-1], bins[1:]):
        sel = (particles["beta"] >= b0) & (particles["beta"] < b1)
        m = make_map(px[sel], py[sel], weights[sel], observed_sky.shape)
        m = gaussian_filter(m, sigma=max(0.0, float(config.get("syntheticSmoothSigmaPx", 2.8))), mode="nearest")
        panels.append((f"β ∈ [{b0:g}, {b1:g})", m))
    cols = int(config.get("panelColumns", 3))
    rows = int(math.ceil(len(panels) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(4.2 * cols, 3.6 * rows), constrained_layout=True, squeeze=False)
    for ax, (label, panel) in zip(axes.flat, panels):
        segs = filter_segments_near_nucleus(contour_segments(panel, levels_from_fractions(panel, syn_fractions, float(config.get("syntheticPeakPercentile", 99.8))), min_points), center_xy, float(config.get("syntheticContourAssociationRadiusPx", 70)))
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
        "processing": {
            "photutilsBackground": bool(config.get("usePhotutilsBackground", True)),
            "sourcePixelsMasked": int(np.count_nonzero(source_mask)),
            "observedNoiseSigma": float(noise_sigma),
            "observedLevels": [float(v) for v in obs_levels],
            "faintTailMode": str(config.get("faintTailMode", "safe")),
            "faintTailLevels": [float(v) for v in faint_tail_levels],
            "tailDirectionXY": None if tail_direction is None else [float(tail_direction[0]), float(tail_direction[1])],
            "manualCleanupActive": bool(manual_cleanup_active),
            "manualCleanupCounts": manual_cleanup_counts,
            "manualCleanupDrawnInThisRun": int(len(drawn_cleanup_polygons)),
            "manualCleanupErasedPixels": int(np.count_nonzero(manual_erase_mask)),
            "manualCleanupKeepPixels": None if manual_keep_mask is None else int(np.count_nonzero(manual_keep_mask)),
        },
        "syntheticLevelMode": synthetic_level_mode,
        "syntheticLevels": [float(v) for v in syn_levels],
        "fixedFractionSyntheticLevels": [float(v) for v in fixed_syn_levels],
        "areaMatchDetails": area_match_details,
        "jaccard": jaccard_metrics,
        "observedContours": len(observed_segments),
        "observedContourFallbackUsed": bool(observed_fallback_used),
        "syntheticContours": len(synthetic_segments),
        "observedTailExtentArcsec": observed_extent_arcsec,
        "usableForTailShapeCalibration": usable,
        "warning": warning,
        "particles": int(len(particles["beta"])),
        "note": "Black curves are observed contours after conservative background subtraction, source masking, and optional nucleus-connected faint-tail extraction. Red curves are simulated contours after nucleus alignment. The comparison is relative morphology, not absolute photometry.",
    }
    (inputs.out_dir / "comparison_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if warning:
        (inputs.out_dir / "WARNING_image_quality.txt").write_text(warning + "\n", encoding="utf-8")
    if not observed_segments:
        (inputs.out_dir / "ERROR_no_observed_contours.txt").write_text(
            "No observed FITS contours were extracted. Try config_balanced_clean.json or config_coma_only_clean.json.\n",
            encoding="utf-8",
        )

    print(f"Created comparison outputs in: {inputs.out_dir.resolve()}")
    primary_jaccard = jaccard_metrics.get("multiLevelOutsideInnerComa", {}).get("index")
    secondary_jaccard = jaccard_metrics.get("multiLevelAllPixels", {}).get("index")
    if primary_jaccard is not None:
        print(f"PRIMARY JACCARD TAIL-SHAPE SCORE (outside inner coma): {float(primary_jaccard):.6f}")
    if secondary_jaccard is not None:
        print(f"Secondary all-pixels Jaccard score: {float(secondary_jaccard):.6f}")
    strict_primary = jaccard_metrics.get("strictNoShiftMultiLevelOutsideInnerComa", {}).get("index")
    if strict_primary is not None and int(config.get("jaccardShiftMaxPx", 0)) > 0:
        print(f"Strict no-shift tail-shape score: {float(strict_primary):.6f}")
    if warning:
        print("WARNING:", warning)
    for name in ["contour_overlay.png", "contour_lines_only.png", "contour_beta_panels.png", "observed_processing_diagnostic.png", "manual_cleanup_regions.png", "manual_cleanup_drawn.json", "jaccard_masks.png", "jaccard_metrics.csv", "comparison_summary.json"]:
        if (inputs.out_dir / name).exists():
            print(f"  - {name}")


def choose_inputs_gui() -> Inputs | None:
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox
    except Exception:
        return None
    root = tk.Tk()
    root.withdraw()
    messagebox.showinfo("Contour comparison", "Select the observed telescope FITS file.")
    observed = filedialog.askopenfilename(title="Observed FITS", filetypes=[("FITS", "*.fits *.fit *.fts"), ("All files", "*.*")])
    if not observed:
        return None
    messagebox.showinfo("Contour comparison", "Select the simulation particle CSV exported by the comet simulator.")
    particles = filedialog.askopenfilename(title="Simulation particles CSV", filetypes=[("CSV", "*.csv"), ("All files", "*.*")])
    if not particles:
        return None
    messagebox.showinfo("Contour comparison", "Select the matching simulation metadata JSON.")
    meta = filedialog.askopenfilename(title="Simulation metadata JSON", filetypes=[("JSON", "*.json"), ("All files", "*.*")])
    if not meta:
        return None
    out = filedialog.askdirectory(title="Choose an empty output folder")
    if not out:
        return None
    draw_cleanup = messagebox.askyesno(
        "Manual cleanup",
        "After the nucleus is selected, do you want to manually draw cleanup regions to erase unwanted observed background contours?",
    )
    return Inputs(Path(observed), Path(particles), Path(meta), None, Path(out), draw_cleanup=draw_cleanup)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observed", type=Path)
    parser.add_argument("--particles", type=Path)
    parser.add_argument("--meta", type=Path)
    parser.add_argument("--config", type=Path, help="Optional external JSON overrides")
    parser.add_argument("--manual-cleanup", type=Path, help="Optional JSON with manual observed erase/keep regions")
    parser.add_argument("--draw-cleanup", action="store_true", help="Open an interactive window and draw observed-background erase polygons by hand after files/nucleus are selected")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--nucleus-x", type=float)
    parser.add_argument("--nucleus-y", type=float)
    args = parser.parse_args()
    if all([args.observed, args.particles, args.meta, args.out]):
        inputs = Inputs(args.observed, args.particles, args.meta, args.config, args.out, args.nucleus_x, args.nucleus_y, args.manual_cleanup, args.draw_cleanup)
    else:
        chosen = choose_inputs_gui()
        if chosen is None:
            parser.print_help()
            return 2
        inputs = chosen
    build_outputs(inputs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
