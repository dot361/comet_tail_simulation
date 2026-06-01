// Console-friendly FITS observation setup.
//
// This file intentionally contains NO comet-specific built-in shortcut.
// Paste an explicit object into the browser console and run:
//
//   await applyFitsObservationPreset({ ... }, { prefill: true });
//
// The helper configures the custom comet orbit, observation time, observer,
// telescope pointing, FITS frame geometry/WCS and FITS render settings.

function setFitsPresetInput(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) el.value = String(value);
}

function finiteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number.`);
  return n;
}

function optionalFiniteNumber(value, fallback = undefined) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cloneFitsPreset(value) {
  return (typeof structuredClone === "function")
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function normalizeBetaCurvePoints(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const out = points.map((p, index) => {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`tail.betaCurve.points[${index}] must contain finite x and y values.`);
    }
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }).sort((a, b) => a.x - b.x);

  for (let i = 1; i < out.length; i++) {
    if (!(out[i].x > out[i - 1].x)) {
      throw new Error("tail.betaCurve point x values must be strictly increasing.");
    }
  }
  return out;
}

function applyFitsBetaCurve(betaCurve) {
  if (!betaCurve || typeof betaUI === "undefined") return;
  betaUI.enabled = betaCurve.enabled !== false;
  if (Array.isArray(betaCurve.points) && betaCurve.points.length >= 2) {
    betaUI.pts = betaCurve.points.map(p => ({ x: p.x, y: p.y }));
  }
  recomputeDomain();
  rebuildBetaTables();
  drawBetaCurve();
}

function normalizeFitsObservationPreset(input) {
  if (!input || typeof input !== "object") throw new Error("Pass a FITS observation object.");

  const preset = cloneFitsPreset(input);
  preset.name = preset.name || preset.object || "Custom FITS observation";
  preset.object = preset.object || "Custom comet";

  // Orbit parameters are deliberately required. The helper must never silently
  // leave the previously selected comet active.
  const c = preset.comet || {};
  preset.comet = {
    e: finiteNumber(c.e, "comet.e"),
    qAU: finiteNumber(c.qAU, "comet.qAU"),
    iDeg: finiteNumber(c.iDeg, "comet.iDeg"),
    OmegaDeg: finiteNumber(c.OmegaDeg, "comet.OmegaDeg"),
    omegaDeg: finiteNumber(c.omegaDeg, "comet.omegaDeg"),
    perihelionJD: finiteNumber(c.perihelionJD, "comet.perihelionJD")
  };

  let jd = Number(preset.jd);
  if (!Number.isFinite(jd) && preset.dateObs) {
    const ms = Date.parse(preset.dateObs);
    if (Number.isFinite(ms)) jd = ms / 86400000 + 2440587.5;
  }
  if (!Number.isFinite(jd)) throw new Error("Provide preset.jd or a parseable preset.dateObs.");
  preset.jd = jd;
  preset.mjd = optionalFiniteNumber(preset.mjd, jd - 2400000.5);
  preset.dateObs = preset.dateObs || new Date((jd - 2440587.5) * 86400000).toISOString();
  preset.exptimeS = optionalFiniteNumber(preset.exptimeS, 0);

  const obs = preset.observer || {};
  preset.observer = {
    type: obs.type || "earth",
    label: obs.label || (obs.type === "ground" ? "Ground observatory" : "Earth/geocentric"),
    lonDeg: optionalFiniteNumber(obs.lonDeg, 0),
    latDeg: optionalFiniteNumber(obs.latDeg, 0),
    altM: optionalFiniteNumber(obs.altM, 0),
    xyz: obs.xyz,
    unit: obs.unit || "AU"
  };

  const target = preset.target || {};
  preset.target = {
    mode: target.mode || "comet",
    raDeg: optionalFiniteNumber(target.raDeg, 0),
    decDeg: optionalFiniteNumber(target.decDeg, 0)
  };

  const image = preset.image || {};
  const width = Math.max(1, Math.round(optionalFiniteNumber(image.width, engine?.getRenderWidth?.(true) || 1920)));
  const height = Math.max(1, Math.round(optionalFiniteNumber(image.height, engine?.getRenderHeight?.(true) || 1080)));
  const pixelScaleArcsec = optionalFiniteNumber(image.pixelScaleArcsec, undefined);
  const fovXDeg = optionalFiniteNumber(image.fovXDeg,
    Number.isFinite(pixelScaleArcsec) ? width * pixelScaleArcsec / 3600 : undefined);
  const fovYDeg = optionalFiniteNumber(image.fovYDeg,
    Number.isFinite(pixelScaleArcsec) ? height * pixelScaleArcsec / 3600 : 5);
  const rollDeg = optionalFiniteNumber(image.rollDeg, 0);

  const w = image.wcs || {};
  const scaleDeg = Number.isFinite(pixelScaleArcsec) ? pixelScaleArcsec / 3600 : fovYDeg / height;
  const theta = rollDeg * Math.PI / 180;
  preset.image = {
    width,
    height,
    pixelScaleArcsec: Number.isFinite(pixelScaleArcsec) ? pixelScaleArcsec : scaleDeg * 3600,
    fovXDeg: Number.isFinite(fovXDeg) ? fovXDeg : width * scaleDeg,
    fovYDeg,
    rollDeg,
    wcs: {
      radesys: w.radesys || "ICRS",
      equinox: optionalFiniteNumber(w.equinox, 2000.0),
      ctype1: w.ctype1 || "RA---TAN",
      ctype2: w.ctype2 || "DEC--TAN",
      cunit1: w.cunit1 || "deg",
      cunit2: w.cunit2 || "deg",
      crpix1: optionalFiniteNumber(w.crpix1, (width + 1) / 2),
      crpix2: optionalFiniteNumber(w.crpix2, (height + 1) / 2),
      crval1: optionalFiniteNumber(w.crval1, preset.target.raDeg),
      crval2: optionalFiniteNumber(w.crval2, preset.target.decDeg),
      // If no CD matrix is supplied, create a simple TAN matrix. The sign
      // convention makes RA increase toward the left, as in common FITS images.
      cd11: optionalFiniteNumber(w.cd11, -scaleDeg * Math.cos(theta)),
      cd12: optionalFiniteNumber(w.cd12,  scaleDeg * Math.sin(theta)),
      cd21: optionalFiniteNumber(w.cd21, -scaleDeg * Math.sin(theta)),
      cd22: optionalFiniteNumber(w.cd22, -scaleDeg * Math.cos(theta))
    }
  };

  const tail = preset.tail || {};
  const betaCurve = tail.betaCurve || {};
  preset.tail = {
    particleCountPerDay: optionalFiniteNumber(tail.particleCountPerDay, 500),
    lifetimeDays: optionalFiniteNumber(tail.lifetimeDays, 250),
    activityExponent: optionalFiniteNumber(tail.activityExponent, 2),
    activityScale: optionalFiniteNumber(tail.activityScale, 1),
    activityHalfLifeEDays: optionalFiniteNumber(tail.activityHalfLifeEDays, 1500),
    ejectionSpeedMps: optionalFiniteNumber(tail.ejectionSpeedMps, 500),
    ejectionBetaExponent: optionalFiniteNumber(tail.ejectionBetaExponent, 0.5),
    ejectionDistanceExponent: optionalFiniteNumber(tail.ejectionDistanceExponent, -0.5),
    sunwardConeSharpness: optionalFiniteNumber(tail.sunwardConeSharpness, 1),
    betaCurve: {
      enabled: betaCurve.enabled !== false,
      points: normalizeBetaCurvePoints(betaCurve.points)
    }
  };

  const render = preset.render || {};
  preset.render = {
    densityKgM3: optionalFiniteNumber(render.densityKgM3, 1000),
    qpr: optionalFiniteNumber(render.qpr, 1),
    visibleAngularMagnifier: optionalFiniteNumber(render.visibleAngularMagnifier, 1e11),
    minRenderedRadiusPx: optionalFiniteNumber(render.minRenderedRadiusPx, 0.05),
    maxRenderedRadiusPx: optionalFiniteNumber(render.maxRenderedRadiusPx, 3),
    // FITS export writes floating-point density directly. This is a linear
    // particle contribution, not an 8-bit canvas opacity.
    fitsParticleWeight: optionalFiniteNumber(render.fitsParticleWeight, optionalFiniteNumber(render.fitsParticleAlpha, 1.0)),
    // Optional weighting by beta-derived physical radius in micrometres.
    // Keep at 0 for a pure projected particle-density image.
    fitsSizeWeightExponent: optionalFiniteNumber(render.fitsSizeWeightExponent, 0),
    // Fixed unresolved-particle PSF. This replaces visual particle-disc sizes
    // in FITS export. Adjust to the telescope seeing / instrument sampling.
    fitsSeeingFwhmPx: optionalFiniteNumber(render.fitsSeeingFwhmPx, 1.5)
  };

  return preset;
}

async function applyFitsObservationPreset(input, options = {}) {
  const preset = normalizeFitsObservationPreset(input);
  const { prefill = true, dtDays = 1.0, activateTelescope = true } = options;
  const c = preset.comet;

  // Set the orbit explicitly. Do not silently load a built-in comet preset.
  setFitsPresetInput("eccentricityInput", c.e);
  setFitsPresetInput("perihelionInput", c.qAU);
  setFitsPresetInput("inclinationInput", c.iDeg);
  setFitsPresetInput("longitudeAscendingNodeInput", c.OmegaDeg);
  setFitsPresetInput("argumentPerihelionInput", c.omegaDeg);
  setFitsPresetInput("perihelionDateInput", c.perihelionJD);

  // Apply dust-tail parameters before recomputing or prefilling the tail.
  const tail = preset.tail;
  setFitsPresetInput("particleCountInput", tail.particleCountPerDay);
  setFitsPresetInput("particleLifetimeInput", tail.lifetimeDays);
  setFitsPresetInput("activityExponentInput", tail.activityExponent);
  setFitsPresetInput("activityScaleInput", tail.activityScale);
  setFitsPresetInput("activityHalfLifeInput", tail.activityHalfLifeEDays);
  setFitsPresetInput("ejectionSpeedInput", tail.ejectionSpeedMps);
  setFitsPresetInput("ejectionGammaInput", tail.ejectionBetaExponent);
  setFitsPresetInput("ejectionKappaInput", tail.ejectionDistanceExponent);
  setFitsPresetInput("ejectionExpcosInput", tail.sunwardConeSharpness);
  applyFitsBetaCurve(tail.betaCurve);

  window.switchToPreset?.(preset.object);
  window.updateOrbitParameters?.();

  window.setSimTime?.(preset.jd, { resetParticles: true, focus: false });

  const obs = preset.observer;
  setFitsPresetInput("observerGroundLabelInput", obs.label);
  setFitsPresetInput("observerGroundLonInput", obs.lonDeg);
  setFitsPresetInput("observerGroundLatInput", obs.latDeg);
  setFitsPresetInput("observerGroundAltInput", obs.altM);
  if (obs.xyz) setFitsPresetInput("observerXYZInput", Array.isArray(obs.xyz) ? obs.xyz.join(", ") : obs.xyz);
  setFitsPresetInput("observerUnitSelect", obs.unit);

  setFitsPresetInput("observerRaInput", preset.target.raDeg);
  setFitsPresetInput("observerDecInput", preset.target.decDeg);
  setFitsPresetInput("observerFovInput", preset.image.fovYDeg);
  setFitsPresetInput("observerRollInput", preset.image.rollDeg);

  // Keep the separate β-size PNG visualisation reproducible from the pasted object.
  setFitsPresetInput("betaSizeDensityInput", preset.render.densityKgM3);
  setFitsPresetInput("betaSizeQprInput", preset.render.qpr);
  setFitsPresetInput("betaSizeMagnifierInput", preset.render.visibleAngularMagnifier);
  setFitsPresetInput("betaSizeMinPxInput", preset.render.minRenderedRadiusPx);
  setFitsPresetInput("betaSizeMaxPxInput", preset.render.maxRenderedRadiusPx);

  const presetSelect = document.getElementById("observerPresetSelect");
  const modeSelect = document.getElementById("observerModeSelect");
  const targetSelect = document.getElementById("observerTargetSelect");
  if (presetSelect) presetSelect.value = "manual";
  if (modeSelect) modeSelect.value = obs.type === "ground" ? "ground" : (obs.type === "j2000" ? "j2000" : "earth");
  if (targetSelect) targetSelect.value = preset.target.mode === "radec" ? "radec" : "comet";

  window.currentFitsObservationPreset = cloneFitsPreset(preset);

  if (prefill && typeof window.headlessPropagate === "function") {
    await window.headlessPropagate(preset.jd, { dtDays });
  }
  if (activateTelescope) window.applyObserverViewFromUI?.();

  console.info("[CometSim] Applied custom FITS observation:", preset);
  console.info("[CometSim] Export with: exportTelescopeTailFits()");
  return preset;
}

window.normalizeFitsObservationPreset = normalizeFitsObservationPreset;
window.applyFitsObservationPreset = applyFitsObservationPreset;
window.applyFitsBetaCurve = applyFitsBetaCurve;
