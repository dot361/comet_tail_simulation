// Tail-only telescope FITS export.
// Particles are projected directly into the requested FITS WCS frame and
// accumulated in a floating-point density image. This avoids 8-bit canvas
// quantisation, which can make faint tails disappear.

const exportTailOnlyBetaFitsBtn = document.getElementById("exportTailOnlyBetaFitsBtn");
exportTailOnlyBetaFitsBtn?.addEventListener("click", exportTailOnlyBetaSizedFits);

function fitsCard(keyword, value, comment = "") {
  const key = String(keyword || "").slice(0, 8).padEnd(8, " ");
  let body;
  if (value === undefined || value === null) {
    body = key;
  } else {
    let encoded;
    if (typeof value === "boolean") encoded = value ? "T" : "F";
    else if (typeof value === "number") encoded = Number.isFinite(value) ? String(value) : "0";
    else encoded = `'${String(value).replace(/'/g, "''").slice(0, 66)}'`;
    body = `${key}= ${encoded.padStart(20, " ")}`;
  }
  if (comment) body += ` / ${comment}`;
  return body.slice(0, 80).padEnd(80, " ");
}

function makeFitsHeaderBytes(cards) {
  cards.push("END".padEnd(80, " "));
  let text = cards.join("");
  const pad = (2880 - (text.length % 2880)) % 2880;
  text += " ".repeat(pad);
  return new TextEncoder().encode(text);
}

function floatImageToFitsBytes(values) {
  const rawLen = values.length * 4;
  const paddedLen = rawLen + ((2880 - (rawLen % 2880)) % 2880);
  const out = new Uint8Array(paddedLen);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, Number(values[i]) || 0, false);
  return out;
}

function getFitsLinearWcs(cfg, width, height) {
  const image = cfg?.image || {};
  const w = image.wcs || {};
  const crpix1 = Number(w.crpix1 ?? ((width + 1) / 2));
  const crpix2 = Number(w.crpix2 ?? ((height + 1) / 2));
  const crval1 = Number(w.crval1 ?? observerViewState?.raDeg ?? 0);
  const crval2 = Number(w.crval2 ?? observerViewState?.decDeg ?? 0);

  let cd11 = Number(w.cd11), cd12 = Number(w.cd12), cd21 = Number(w.cd21), cd22 = Number(w.cd22);
  if (![cd11, cd12, cd21, cd22].every(Number.isFinite)) {
    const scaleDeg = Number(image.pixelScaleArcsec || 1) / 3600;
    const theta = Number(image.rollDeg || 0) * Math.PI / 180;
    cd11 = -scaleDeg * Math.cos(theta);
    cd12 =  scaleDeg * Math.sin(theta);
    cd21 = -scaleDeg * Math.sin(theta);
    cd22 = -scaleDeg * Math.cos(theta);
  }

  const det = cd11 * cd22 - cd12 * cd21;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;

  return {
    crpix1, crpix2, crval1, crval2,
    cd11, cd12, cd21, cd22,
    inv11: cd22 / det,
    inv12: -cd12 / det,
    inv21: -cd21 / det,
    inv22: cd11 / det,
    pixelScaleDeg: Math.sqrt(Math.abs(det))
  };
}

function wrapRadiansPi(value) {
  let x = value % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

// Gnomonic/TAN sky projection. Returned x/y are FITS 1-based pixel coordinates.
function raDecToFitsPixel(raDeg, decDeg, wcs) {
  if (!wcs) return null;
  const ra = Number(raDeg) * Math.PI / 180;
  const dec = Number(decDeg) * Math.PI / 180;
  const ra0 = wcs.crval1 * Math.PI / 180;
  const dec0 = wcs.crval2 * Math.PI / 180;
  const dra = wrapRadiansPi(ra - ra0);

  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const sinDec0 = Math.sin(dec0), cosDec0 = Math.cos(dec0);
  const denom = sinDec0 * sinDec + cosDec0 * cosDec * Math.cos(dra);
  if (!(denom > 0)) return null;

  const xiDeg = (cosDec * Math.sin(dra) / denom) * 180 / Math.PI;
  const etaDeg = ((cosDec0 * sinDec - sinDec0 * cosDec * Math.cos(dra)) / denom) * 180 / Math.PI;
  const dx = wcs.inv11 * xiDeg + wcs.inv12 * etaDeg;
  const dy = wcs.inv21 * xiDeg + wcs.inv22 * etaDeg;
  return { xFits: wcs.crpix1 + dx, yFits: wcs.crpix2 + dy };
}

function placeRecordsInFitsFrame(records, cfg, width, height) {
  const wcs = getFitsLinearWcs(cfg, width, height);
  if (!wcs || !observerViewActive || !observerViewState) return records;
  const observerPos = getObserverPosition(observerViewState);
  const pixelScaleRad = Math.max(1e-20, wcs.pixelScaleDeg * Math.PI / 180);

  for (const r of records) {
    const pos = new BABYLON.Vector3(r.positionSceneX, r.positionSceneY, r.positionSceneZ);
    const sky = heliocentricSceneToRaDec(pos, observerPos);
    const pixel = raDecToFitsPixel(sky.raDeg, sky.decDeg, wcs);
    if (!pixel) {
      r.insideFrame = false;
      continue;
    }

    const trueRadiusPx = r.angularRadiusRad / pixelScaleRad;
    const exportMarginPx = Math.max(1, Number(cfg.render?.fitsSeeingFwhmPx ?? 1.5) * 2);

    r.raDeg = sky.raDeg;
    r.decDeg = sky.decDeg;
    r.fitsX = pixel.xFits;
    r.fitsY = pixel.yFits;
    r.trueRadiusPx = trueRadiusPx;
    // Visual particle-disc magnification belongs only to the PNG debug export.
    // FITS export treats grains as unresolved points convolved with a fixed PSF.
    r.renderedRadiusPx = 0;
    r.insideFrame = pixel.xFits >= 1 - exportMarginPx && pixel.xFits <= width + exportMarginPx &&
      pixel.yFits >= 1 - exportMarginPx && pixel.yFits <= height + exportMarginPx;
  }
  return records;
}

function addBilinear(values, width, height, x, y, weight) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const points = [
    [x0,     y0,     (1 - fx) * (1 - fy)],
    [x0 + 1, y0,     fx * (1 - fy)],
    [x0,     y0 + 1, (1 - fx) * fy],
    [x0 + 1, y0 + 1, fx * fy]
  ];
  for (const [px, py, f] of points) {
    if (px >= 0 && px < width && py >= 0 && py < height && f > 0) values[py * width + px] += weight * f;
  }
}

function addPsfSplat(values, width, height, x, y, sigmaPx, weight) {
  // Real dust grains are unresolved. The FITS image therefore uses a fixed
  // telescope/seeing PSF instead of visually enlarged particle discs.
  if (!(sigmaPx > 0.2)) {
    addBilinear(values, width, height, x, y, weight);
    return;
  }

  const extent = Math.max(1, Math.ceil(Math.min(10, sigmaPx * 3)));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  let norm = 0;
  const samples = [];
  for (let dy = -extent; dy <= extent; dy++) {
    for (let dx = -extent; dx <= extent; dx++) {
      const px = x0 + dx, py = y0 + dy;
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const ddx = (px + 0.5) - x, ddy = (py + 0.5) - y;
      const g = Math.exp(-(ddx * ddx + ddy * ddy) / (2 * sigmaPx * sigmaPx));
      if (g < 1e-5) continue;
      samples.push([px, py, g]);
      norm += g;
    }
  }
  if (!(norm > 0)) {
    addBilinear(values, width, height, x, y, weight);
    return;
  }
  const scale = weight / norm;
  for (const [px, py, g] of samples) values[py * width + px] += g * scale;
}

function createTailDensityImage(records, width, height, cfg = {}) {
  const values = new Float32Array(width * height);
  const particleWeight = Math.max(1e-12, Number(cfg.render?.fitsParticleWeight ?? cfg.render?.fitsParticleAlpha ?? 1));
  const sizeWeightExponent = Math.max(0, Number(cfg.render?.fitsSizeWeightExponent ?? 0));
  const seeingFwhmPx = Math.max(0, Number(cfg.render?.fitsSeeingFwhmPx ?? 1.5));
  const psfSigmaPx = seeingFwhmPx / 2.354820045;
  let visibleCount = 0;

  for (const r of records) {
    if (!r.insideFrame) continue;
    visibleCount++;
    const x = r.fitsX - 1;
    const y = r.fitsY - 1; // FITS-native lower-left orientation.
    const sizeFactor = sizeWeightExponent > 0 ? Math.pow(Math.max(1e-12, r.radiusUm || 1), sizeWeightExponent) : 1;
    addPsfSplat(values, width, height, x, y, psfSigmaPx, particleWeight * sizeFactor);
  }

  return { values, visibleCount, seeingFwhmPx };
}

function createTailOnlyFitsBlob(values, width, height, cfg = {}) {
  const image = cfg.image || {};
  const wcs = getFitsLinearWcs(cfg, width, height) || {};
  const observer = cfg.observer || {};
  const dateObs = cfg.dateObs || new Date((simulationTimeJD - 2440587.5) * 86400000).toISOString();
  const cards = [
    fitsCard("SIMPLE", true, "conforms to FITS standard"),
    fitsCard("BITPIX", -32, "32-bit floating point density"),
    fitsCard("NAXIS", 2),
    fitsCard("NAXIS1", width),
    fitsCard("NAXIS2", height),
    fitsCard("BUNIT", "SIM_DENSITY"),
    fitsCard("ORIGIN", "Comet tail simulation"),
    fitsCard("IMGTYPE", "tail-only simulation"),
    fitsCard("OBJECT", cfg.object || window.currentCometName || "simulated comet"),
    fitsCard("DATE-OBS", dateObs),
    fitsCard("OBSJD", Number(cfg.jd ?? simulationTimeJD)),
    fitsCard("OBSMJD", Number(cfg.mjd ?? ((cfg.jd ?? simulationTimeJD) - 2400000.5))),
    fitsCard("FILTER", cfg.filter || "SIM"),
    fitsCard("EXPTIME", Number(cfg.exptimeS ?? 0)),
    fitsCard("OBSERVAT", observer.label || getObserverModeLabel?.() || "simulation observer"),
    fitsCard("OBSLON", Number(observer.lonDeg ?? 0)),
    fitsCard("OBSLAT", Number(observer.latDeg ?? 0)),
    fitsCard("OBSALT", Number(observer.altM ?? 0)),
    fitsCard("PIXSCALE", Number(image.pixelScaleArcsec ?? (wcs.pixelScaleDeg ? wcs.pixelScaleDeg * 3600 : 0))),
    fitsCard("RADESYS", image.wcs?.radesys || "ICRS"),
    fitsCard("EQUINOX", Number(image.wcs?.equinox ?? 2000.0)),
    fitsCard("CTYPE1", "RA---TAN"),
    fitsCard("CTYPE2", "DEC--TAN"),
    fitsCard("CUNIT1", "deg"),
    fitsCard("CUNIT2", "deg"),
    fitsCard("CRPIX1", Number(wcs.crpix1 ?? ((width + 1) / 2))),
    fitsCard("CRPIX2", Number(wcs.crpix2 ?? ((height + 1) / 2))),
    fitsCard("CRVAL1", Number(wcs.crval1 ?? observerViewState?.raDeg ?? 0)),
    fitsCard("CRVAL2", Number(wcs.crval2 ?? observerViewState?.decDeg ?? 0)),
    fitsCard("CD1_1", Number(wcs.cd11 ?? 0)),
    fitsCard("CD1_2", Number(wcs.cd12 ?? 0)),
    fitsCard("CD2_1", Number(wcs.cd21 ?? 0)),
    fitsCard("CD2_2", Number(wcs.cd22 ?? 0)),
    fitsCard("FOVXDEG", Number(image.fovXDeg ?? 0)),
    fitsCard("FOVYDEG", Number(image.fovYDeg ?? observerViewState?.fovDeg ?? 0)),
    fitsCard("PARTWGHT", Number(cfg.render?.fitsParticleWeight ?? cfg.render?.fitsParticleAlpha ?? 1)),
    fitsCard("SZWGHTEX", Number(cfg.render?.fitsSizeWeightExponent ?? 0)),
    fitsCard("PSFFWHM", Number(cfg.render?.fitsSeeingFwhmPx ?? 1.5), "unresolved-particle PSF FWHM in pixels"),
    fitsCard("WCSMODE", "DIRECT_TAN"),
    fitsCard("SIMMODE", "FLOAT_DENSITY_PSF")
  ];

  return new Blob([makeFitsHeaderBytes(cards), floatImageToFitsBytes(values)], { type: "application/fits" });
}

async function exportTailOnlyBetaSizedFits() {
  if (!scene || !engine || !canvas) return;
  if (!observerViewActive) {
    if (observerInfo) observerInfo.textContent = `${lastObserverMetadata || ""}\n\nActivate telescope view first, then export the FITS image.`.trim();
    return;
  }

  const btn = exportTailOnlyBetaFitsBtn;
  if (btn) btn.textContent = "Exporting FITS…";
  try {
    updateObserverCamera();
    const cfg = window.currentFitsObservationPreset || {};
    const image = cfg.image || {};
    const width = Math.max(1, Math.round(image.width || engine.getRenderWidth(true)));
    const height = Math.max(1, Math.round(image.height || engine.getRenderHeight(true)));

    const settings = readBetaSizeExportSettings();
    const records = await collectLiveParticleRecordsForExport(settings, { width, height });
    placeRecordsInFitsFrame(records, cfg, width, height);
    const { values, visibleCount } = createTailDensityImage(records, width, height, cfg);

    const date = jdToDateString(simulationTimeJD);
    const baseName = `tail_only_${date}_JD${simulationTimeJD.toFixed(5)}`.replace(/[^a-zA-Z0-9_.-]+/g, "_");
    downloadBlob(`${baseName}.fits`, createTailOnlyFitsBlob(values, width, height, cfg));

    if (observerInfo) observerInfo.textContent = `${lastObserverMetadata || ""}\n\nExported tail-only FITS (${width} × ${height}); ${visibleCount} particles fall inside the WCS frame.`;
  } catch (err) {
    console.error("Tail-only FITS export failed", err);
    if (observerInfo) observerInfo.textContent = `${lastObserverMetadata || ""}\n\nFITS export failed: ${err.message || err}`;
  } finally {
    if (btn) btn.textContent = "Export telescope tail FITS";
  }
}

window.exportTailOnlyBetaSizedFits = exportTailOnlyBetaSizedFits;
window.exportTelescopeTailFits = exportTailOnlyBetaSizedFits;
window.raDecToFitsPixel = raDecToFitsPixel;
