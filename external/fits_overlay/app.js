"use strict";

const $ = (id) => document.getElementById(id);
const ui = {
  realFile: $("realFile"), simFile: $("simFile"), realInfo: $("realInfo"), simInfo: $("simInfo"),
  displayMode: $("displayMode"), wcsState: $("wcsState"), alignNuclei: $("alignNuclei"),
  pickObservedNucleusBtn: $("pickObservedNucleusBtn"), pickSimulatedNucleusBtn: $("pickSimulatedNucleusBtn"),
  clearNucleusBtn: $("clearNucleusBtn"), nucleusInfo: $("nucleusInfo"), exportBtn: $("exportBtn"),
  canvas: $("overlayCanvas"), emptyState: $("emptyState"), status: $("status"), canvasInfo: $("canvasInfo")
};
const ctx = ui.canvas.getContext("2d", { alpha: false });

let realFits = null;
let simFits = null;
let observedNucleus = null;
let simulatedNucleus = null;
let nucleusOffsetRealPx = null;
let pickingMode = null;
let renderQueued = false;

const DISPLAY = {
  observedLowPercentile: 1.0,
  observedHighPercentile: 99.5,
  observedGamma: 0.60,
  simulationHighPercentile: 99.5,
  simulationGamma: 0.90,
  simulationAsinhStrength: 18,
  overlayOpacity: 0.62
};
const plotMargins = { left: 84, right: 20, top: 20, bottom: 64 };

function parseCardValue(raw) {
  const valuePart = raw.split("/")[0].trim();
  if (!valuePart) return "";
  if (valuePart.startsWith("'") && valuePart.endsWith("'")) return valuePart.slice(1, -1).replace(/''/g, "'").trim();
  if (valuePart === "T") return true;
  if (valuePart === "F") return false;
  const numeric = Number(valuePart.replace(/D/g, "E"));
  return Number.isFinite(numeric) ? numeric : valuePart;
}

function parseFits(buffer, fileName = "image.fits") {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder("ascii");
  const header = {};
  let offset = 0;
  let endFound = false;
  while (!endFound) {
    if (offset + 2880 > bytes.length) throw new Error("Header END card not found.");
    const block = decoder.decode(bytes.subarray(offset, offset + 2880));
    for (let i = 0; i < 2880; i += 80) {
      const card = block.slice(i, i + 80);
      const key = card.slice(0, 8).trim();
      if (key === "END") { endFound = true; break; }
      if (!key || card[8] !== "=") continue;
      header[key] = parseCardValue(card.slice(10));
    }
    offset += 2880;
  }
  const bitpix = Number(header.BITPIX);
  const width = Number(header.NAXIS1);
  const height = Number(header.NAXIS2);
  if (Number(header.NAXIS) !== 2 || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Only primary 2D FITS images are supported.");
  const reader = new DataView(buffer);
  const count = width * height;
  const data = new Float32Array(count);
  const bscale = Number.isFinite(Number(header.BSCALE)) ? Number(header.BSCALE) : 1;
  const bzero = Number.isFinite(Number(header.BZERO)) ? Number(header.BZERO) : 0;
  let bytesPerPixel, readValue;
  switch (bitpix) {
    case 8: bytesPerPixel = 1; readValue = (p) => reader.getUint8(p); break;
    case 16: bytesPerPixel = 2; readValue = (p) => reader.getInt16(p, false); break;
    case 32: bytesPerPixel = 4; readValue = (p) => reader.getInt32(p, false); break;
    case -32: bytesPerPixel = 4; readValue = (p) => reader.getFloat32(p, false); break;
    case -64: bytesPerPixel = 8; readValue = (p) => reader.getFloat64(p, false); break;
    default: throw new Error(`Unsupported BITPIX: ${bitpix}`);
  }
  if (offset + count * bytesPerPixel > buffer.byteLength) throw new Error("Image data is truncated.");
  for (let i = 0, p = offset; i < count; i++, p += bytesPerPixel) {
    const value = readValue(p) * bscale + bzero;
    data[i] = Number.isFinite(value) ? value : NaN;
  }
  return { fileName, header, bitpix, width, height, data, stats: computeStats(data, false), positiveStats: computeStats(data, true), wcs: readLinearWcs(header) };
}

function computeStats(data, positiveOnly) {
  const values = [];
  const limit = 300000;
  const step = positiveOnly ? 1 : Math.max(1, Math.floor(data.length / 240000));
  let seen = 0;
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (!Number.isFinite(v) || (positiveOnly && v <= 0)) continue;
    seen++;
    if (values.length < limit) values.push(v);
    else {
      const j = Math.floor(Math.random() * seen);
      if (j < limit) values[j] = v;
    }
  }
  if (!values.length) return { values: [0, 1], seen: 0 };
  values.sort((a, b) => a - b);
  return { values, seen };
}
function percentile(stats, p) {
  const values = stats.values;
  const t = Math.max(0, Math.min(100, p)) / 100 * (values.length - 1);
  const lo = Math.floor(t), hi = Math.ceil(t), f = t - lo;
  return values[lo] * (1 - f) + values[hi] * f;
}

function readLinearWcs(h) {
  const crpix1 = Number(h.CRPIX1), crpix2 = Number(h.CRPIX2), crval1 = Number(h.CRVAL1), crval2 = Number(h.CRVAL2);
  let cd11 = Number(h.CD1_1), cd12 = Number(h.CD1_2), cd21 = Number(h.CD2_1), cd22 = Number(h.CD2_2);
  if (![cd11, cd12, cd21, cd22].every(Number.isFinite)) {
    const cdelt1 = Number(h.CDELT1), cdelt2 = Number(h.CDELT2);
    if (![cdelt1, cdelt2].every(Number.isFinite)) return null;
    cd11 = cdelt1; cd12 = 0; cd21 = 0; cd22 = cdelt2;
  }
  if (![crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22].every(Number.isFinite)) return null;
  const det = cd11 * cd22 - cd12 * cd21;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  return { crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, inv11: cd22 / det, inv12: -cd12 / det, inv21: -cd21 / det, inv22: cd11 / det };
}
function wrapPi(x) { x %= 2 * Math.PI; if (x > Math.PI) x -= 2 * Math.PI; if (x < -Math.PI) x += 2 * Math.PI; return x; }
function fitsPixelToSky(xFits, yFits, w) {
  const xi = (w.cd11 * (xFits - w.crpix1) + w.cd12 * (yFits - w.crpix2)) * Math.PI / 180;
  const eta = (w.cd21 * (xFits - w.crpix1) + w.cd22 * (yFits - w.crpix2)) * Math.PI / 180;
  const ra0 = w.crval1 * Math.PI / 180;
  const dec0 = w.crval2 * Math.PI / 180;
  const denom = Math.cos(dec0) - eta * Math.sin(dec0);
  const ra = ra0 + Math.atan2(xi, denom);
  const dec = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.sqrt(denom * denom + xi * xi));
  return { raDeg: ((ra * 180 / Math.PI) % 360 + 360) % 360, decDeg: dec * 180 / Math.PI };
}
function skyToFitsPixel(raDeg, decDeg, w) {
  const ra = raDeg * Math.PI / 180, dec = decDeg * Math.PI / 180;
  const ra0 = w.crval1 * Math.PI / 180, dec0 = w.crval2 * Math.PI / 180;
  const dra = wrapPi(ra - ra0);
  const denom = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(dra);
  if (!(denom > 0)) return null;
  const xiDeg = (Math.cos(dec) * Math.sin(dra) / denom) * 180 / Math.PI;
  const etaDeg = ((Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(dra)) / denom) * 180 / Math.PI;
  return { xFits: w.crpix1 + w.inv11 * xiDeg + w.inv12 * etaDeg, yFits: w.crpix2 + w.inv21 * xiDeg + w.inv22 * etaDeg };
}
function displayToFitsPixel(fits, x, y) { return { xFits: x + 1, yFits: fits.height - y }; }
function fitsToDisplayPixel(fits, xFits, yFits) { return { x: xFits - 1, y: fits.height - yFits }; }
function sampleRawBilinear(fits, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > fits.width - 1 || y > fits.height - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(fits.width - 1, x0 + 1), y1 = Math.min(fits.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = fits.data[y0 * fits.width + x0], b = fits.data[y0 * fits.width + x1], c = fits.data[y1 * fits.width + x0], d = fits.data[y1 * fits.width + x1];
  if (![a,b,c,d].every(Number.isFinite)) return NaN;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
function sampleDisplay(fits, x, y) { return sampleRawBilinear(fits, x, fits.height - 1 - y); }

function simDisplayToRealDisplay(x, y) {
  if (realFits?.wcs && simFits?.wcs) {
    const sp = displayToFitsPixel(simFits, x, y);
    const sky = fitsPixelToSky(sp.xFits, sp.yFits, simFits.wcs);
    const rp = skyToFitsPixel(sky.raDeg, sky.decDeg, realFits.wcs);
    return rp ? fitsToDisplayPixel(realFits, rp.xFits, rp.yFits) : null;
  }
  return { x: x * realFits.width / simFits.width, y: y * realFits.height / simFits.height };
}
function realDisplayToSimDisplay(x, y, includeAlignment = true) {
  let rx = x, ry = y;
  if (includeAlignment && ui.alignNuclei.checked && nucleusOffsetRealPx) { rx -= nucleusOffsetRealPx.x; ry -= nucleusOffsetRealPx.y; }
  if (realFits?.wcs && simFits?.wcs) {
    const rp = displayToFitsPixel(realFits, rx, ry);
    const sky = fitsPixelToSky(rp.xFits, rp.yFits, realFits.wcs);
    const sp = skyToFitsPixel(sky.raDeg, sky.decDeg, simFits.wcs);
    return sp ? fitsToDisplayPixel(simFits, sp.xFits, sp.yFits) : null;
  }
  return { x: rx * simFits.width / realFits.width, y: ry * simFits.height / realFits.height };
}

function formatSummary(fits) {
  const h = fits.header;
  const lines = [fits.fileName, `${fits.width} × ${fits.height} px · BITPIX ${fits.bitpix}`];
  if (h.OBJECT) lines.push(`OBJECT: ${h.OBJECT}`);
  if (h["DATE-OBS"]) lines.push(`DATE-OBS: ${h["DATE-OBS"]}`);
  if (h.PIXSCALE) lines.push(`PIXSCALE: ${h.PIXSCALE} arcsec/px`);
  lines.push(fits.wcs ? `WCS: ${Number(h.CRVAL1).toFixed(5)}°, ${Number(h.CRVAL2).toFixed(5)}°` : "WCS: unavailable");
  return lines.join("\n");
}
async function loadFits(file, kind) {
  if (!file) return;
  ui.status.textContent = `Reading ${file.name}…`;
  try {
    const fits = parseFits(await file.arrayBuffer(), file.name);
    if (kind === "real") { realFits = fits; ui.realInfo.textContent = formatSummary(fits); }
    else { simFits = fits; ui.simInfo.textContent = formatSummary(fits); }
    observedNucleus = null; simulatedNucleus = null; nucleusOffsetRealPx = null;
    refreshNucleusInfo(); updateReadyState(); queueRender();
  } catch (err) {
    console.error(err); ui.status.textContent = `Could not read ${file.name}: ${err.message}`;
  }
}
function updateReadyState() {
  const ready = Boolean(realFits && simFits);
  ui.exportBtn.disabled = !ready;
  ui.emptyState.classList.toggle("hidden", ready);
  const wcsReady = Boolean(realFits?.wcs && simFits?.wcs);
  ui.wcsState.textContent = wcsReady ? "WCS alignment active." : "WCS unavailable. Images aligned by frame size.";
  ui.status.textContent = ready ? ui.wcsState.textContent : "Load observed and simulated FITS files.";
}
function estimatePixelScaleArcsec(wcs) {
  if (!wcs) return null;
  return (Math.hypot(wcs.cd11, wcs.cd21) + Math.hypot(wcs.cd12, wcs.cd22)) * 1800;
}
function refreshNucleusInfo() {
  if (!realFits || !simFits || !observedNucleus || !simulatedNucleus) {
    nucleusOffsetRealPx = null;
    ui.nucleusInfo.textContent = "Pick both nucleus points.";
    return;
  }
  const predicted = simDisplayToRealDisplay(simulatedNucleus.x, simulatedNucleus.y);
  if (!predicted) {
    nucleusOffsetRealPx = null;
    ui.nucleusInfo.textContent = "Could not map the simulated nucleus into the observed frame.";
    return;
  }
  nucleusOffsetRealPx = { x: observedNucleus.x - predicted.x, y: observedNucleus.y - predicted.y };
  const pxScale = Number(realFits.header.PIXSCALE) || estimatePixelScaleArcsec(realFits.wcs) || 0;
  const totalPx = Math.hypot(nucleusOffsetRealPx.x, nucleusOffsetRealPx.y);
  ui.nucleusInfo.textContent = [
    `Observed: x ${observedNucleus.x.toFixed(1)}, y ${observedNucleus.y.toFixed(1)}`,
    `Simulated before shift: x ${predicted.x.toFixed(1)}, y ${predicted.y.toFixed(1)}`,
    `Shift: Δx ${nucleusOffsetRealPx.x.toFixed(1)} px, Δy ${nucleusOffsetRealPx.y.toFixed(1)} px`,
    pxScale ? `Total: ${totalPx.toFixed(1)} px · ${(totalPx * pxScale).toFixed(1)} arcsec` : `Total: ${totalPx.toFixed(1)} px`
  ].join("\n");
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function stretchSimulation(v) { return Math.asinh(DISPLAY.simulationAsinhStrength * clamp01(v)) / Math.asinh(DISPLAY.simulationAsinhStrength); }
function previewSize() {
  if (!realFits) return { width: 1000, height: 800 };
  const maxSide = 1260;
  const factor = Math.min(1, maxSide / Math.max(realFits.width, realFits.height));
  return { width: Math.max(1, Math.round(realFits.width * factor)), height: Math.max(1, Math.round(realFits.height * factor)) };
}
function previewToRealDisplay(px, py, size) { return { x: px * realFits.width / size.width, y: py * realFits.height / size.height }; }
function realToPreviewDisplay(x, y, size) { return { x: x * size.width / realFits.width, y: y * size.height / realFits.height }; }
function formatRaHours(raDeg) {
  let hours = ((raDeg / 15) % 24 + 24) % 24;
  const h = Math.floor(hours), mf = (hours - h) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60);
  return `${String(h).padStart(2,"0")}h${String(m).padStart(2,"0")}m${String(s).padStart(2,"0")}s`;
}
function formatDec(decDeg) {
  const sign = decDeg < 0 ? "−" : "+", a = Math.abs(decDeg), d = Math.floor(a), m = Math.round((a - d) * 60);
  return `${sign}${String(d).padStart(2,"0")}°${String(m).padStart(2,"0")}′`;
}
function drawCoordinateFrame(size) {
  if (!realFits?.wcs) return;
  const m = plotMargins, x0 = m.left, y0 = m.top, x1 = x0 + size.width, y1 = y0 + size.height, ticks = 6;
  ctx.save(); ctx.strokeStyle = "rgba(255,255,255,.72)"; ctx.fillStyle = "#fff"; ctx.lineWidth = 1; ctx.font = "12px Arial"; ctx.textBaseline = "middle";
  ctx.strokeRect(x0 + .5, y0 + .5, size.width, size.height);
  for (let i = 0; i <= ticks; i++) {
    const dx = x0 + i / ticks * size.width, rp = previewToRealDisplay(i / ticks * size.width, size.height - 1, size), fp = displayToFitsPixel(realFits, rp.x, rp.y), sky = fitsPixelToSky(fp.xFits, fp.yFits, realFits.wcs);
    ctx.beginPath(); ctx.moveTo(dx + .5, y1); ctx.lineTo(dx + .5, y1 + 6); ctx.stroke(); ctx.textAlign = "center"; ctx.fillText(formatRaHours(sky.raDeg), dx, y1 + 22);
    if (i > 0 && i < ticks) { ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.beginPath(); ctx.moveTo(dx + .5, y0); ctx.lineTo(dx + .5, y1); ctx.stroke(); ctx.strokeStyle = "rgba(255,255,255,.72)"; }
  }
  for (let i = 0; i <= ticks; i++) {
    const dy = y0 + i / ticks * size.height, rp = previewToRealDisplay(0, i / ticks * size.height, size), fp = displayToFitsPixel(realFits, rp.x, rp.y), sky = fitsPixelToSky(fp.xFits, fp.yFits, realFits.wcs);
    ctx.beginPath(); ctx.moveTo(x0 - 6, dy + .5); ctx.lineTo(x0, dy + .5); ctx.stroke(); ctx.textAlign = "right"; ctx.fillText(formatDec(sky.decDeg), x0 - 10, dy);
    if (i > 0 && i < ticks) { ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.beginPath(); ctx.moveTo(x0, dy + .5); ctx.lineTo(x1, dy + .5); ctx.stroke(); ctx.strokeStyle = "rgba(255,255,255,.72)"; }
  }
  ctx.textAlign = "center"; ctx.fillText("RA", x0 + size.width / 2, y1 + 46);
  ctx.save(); ctx.translate(20, y0 + size.height / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("Dec", 0, 0); ctx.restore(); ctx.restore();
}
function drawMarker(point, size, label) {
  if (!point) return;
  const p = realToPreviewDisplay(point.x, point.y, size);
  const x = plotMargins.left + p.x, y = plotMargins.top + p.y;
  ctx.save(); ctx.strokeStyle = "#fff"; ctx.fillStyle = "#fff"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 11, y); ctx.lineTo(x + 11, y); ctx.moveTo(x, y - 11); ctx.lineTo(x, y + 11); ctx.stroke();
  ctx.font = "11px Arial"; ctx.textAlign = "left"; ctx.fillText(label, x + 10, y - 10); ctx.restore();
}
function render() {
  if (!realFits || !simFits) return;
  const size = previewSize(), m = plotMargins, fullW = size.width + m.left + m.right, fullH = size.height + m.top + m.bottom;
  if (ui.canvas.width !== fullW || ui.canvas.height !== fullH) { ui.canvas.width = fullW; ui.canvas.height = fullH; }
  const image = ctx.createImageData(size.width, size.height), out = image.data;
  const realLow = percentile(realFits.stats, DISPLAY.observedLowPercentile), realHigh = percentile(realFits.stats, DISPLAY.observedHighPercentile), realSpan = Math.max(1e-20, realHigh - realLow);
  const simHigh = Math.max(1e-20, percentile(simFits.positiveStats, DISPLAY.simulationHighPercentile));
  const mode = ui.displayMode.value;
  let k = 0;
  for (let py = 0; py < size.height; py++) for (let px = 0; px < size.width; px++, k += 4) {
    const realP = previewToRealDisplay(px + .5, py + .5, size);
    let rv = clamp01((sampleDisplay(realFits, realP.x, realP.y) - realLow) / realSpan); if (!Number.isFinite(rv)) rv = 0; rv = Math.pow(rv, DISPLAY.observedGamma);
    const base = Math.round(rv * 255);
    const simP = realDisplayToSimDisplay(realP.x, realP.y, true);
    let sv = simP ? sampleDisplay(simFits, simP.x, simP.y) / simHigh : 0; if (!Number.isFinite(sv)) sv = 0; sv = Math.pow(stretchSimulation(sv), DISPLAY.simulationGamma);
    const simGrey = Math.round(clamp01(sv) * 255);
    const grey = mode === "observed" ? base : mode === "simulation" ? simGrey : Math.round(255 - (255 - base) * (255 - simGrey * DISPLAY.overlayOpacity) / 255);
    out[k] = out[k + 1] = out[k + 2] = Math.max(0, Math.min(255, grey)); out[k + 3] = 255;
  }
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, fullW, fullH);
  const imageCanvas = document.createElement("canvas"); imageCanvas.width = size.width; imageCanvas.height = size.height; imageCanvas.getContext("2d").putImageData(image, 0, 0);
  ctx.drawImage(imageCanvas, m.left, m.top); drawCoordinateFrame(size);
  if (observedNucleus) drawMarker(observedNucleus, size, "observed");
  if (simulatedNucleus) {
    const mapped = simDisplayToRealDisplay(simulatedNucleus.x, simulatedNucleus.y);
    if (mapped) drawMarker(mapped, size, "simulated");
  }
  ui.canvasInfo.textContent = `${realFits.width} × ${realFits.height} source`;
}
function queueRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function savePng() {
  if (!realFits || !simFits) return; render();
  ui.canvas.toBlob((blob) => { if (!blob) return; const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "fits_overlay.png"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }, "image/png");
}

function startPicking(mode) {
  pickingMode = mode;
  document.querySelector(".canvas-wrap").classList.add("picking");
  ui.status.textContent = mode === "observed" ? "Click the observed nucleus." : "Click the simulated nucleus.";
  ui.displayMode.value = mode === "observed" ? "observed" : "simulation";
  queueRender();
}
ui.realFile.addEventListener("change", () => loadFits(ui.realFile.files[0], "real"));
ui.simFile.addEventListener("change", () => loadFits(ui.simFile.files[0], "sim"));
ui.displayMode.addEventListener("change", queueRender);
ui.alignNuclei.addEventListener("change", queueRender);
ui.exportBtn.addEventListener("click", savePng);
ui.pickObservedNucleusBtn.addEventListener("click", () => startPicking("observed"));
ui.pickSimulatedNucleusBtn.addEventListener("click", () => startPicking("simulated"));
ui.clearNucleusBtn.addEventListener("click", () => { observedNucleus = null; simulatedNucleus = null; nucleusOffsetRealPx = null; refreshNucleusInfo(); queueRender(); });
ui.canvas.addEventListener("click", (event) => {
  if (!pickingMode || !realFits || !simFits) return;
  const rect = ui.canvas.getBoundingClientRect(), size = previewSize(), m = plotMargins;
  const px = (event.clientX - rect.left) * ui.canvas.width / rect.width - m.left;
  const py = (event.clientY - rect.top) * ui.canvas.height / rect.height - m.top;
  if (px >= 0 && py >= 0 && px < size.width && py < size.height) {
    const realP = previewToRealDisplay(px, py, size);
    if (pickingMode === "observed") observedNucleus = realP;
    else simulatedNucleus = realDisplayToSimDisplay(realP.x, realP.y, false);
    refreshNucleusInfo();
  }
  pickingMode = null;
  document.querySelector(".canvas-wrap").classList.remove("picking");
  ui.displayMode.value = "overlay";
  ui.status.textContent = realFits?.wcs && simFits?.wcs ? "WCS alignment active." : "Images loaded.";
  queueRender();
});
updateReadyState();
