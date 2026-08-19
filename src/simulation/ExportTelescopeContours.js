// ─── Telescope contour-comparison export ─────────────────────────────────────
//
// This export is deliberately separate from the visible particle renderer.
// It bakes a reproducible Monte-Carlo dust sample directly at an observation
// epoch and writes particle sky coordinates (RA/Dec) plus beta metadata.
// A separate Python utility bins the particles into a synthetic brightness map
// and draws red isophote contours over black observed FITS contours.

const contourHistoryDaysInput    = document.getElementById('contourHistoryDaysInput');
const contourParticlesPerDayInput = document.getElementById('contourParticlesPerDayInput');
const contourBetaBinsInput       = document.getElementById('contourBetaBinsInput');
const contourWeightModeSelect    = document.getElementById('contourWeightModeSelect');
const exportContourDataBtn       = document.getElementById('exportContourDataBtn');

function contourNumber(v, fallback, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function contourParseBins(value) {
  const bins = String(value ?? '')
    .split(/[\s,;]+/)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const unique = bins.filter((v, i) => i === 0 || v > bins[i - 1]);
  return unique.length >= 2 ? unique : [0, 0.003, 0.01, 0.03, 0.1, 0.3, 1];
}

function contourBinIndex(beta, bins) {
  for (let i = 0; i < bins.length - 1; i++) {
    const last = i === bins.length - 2;
    if (beta >= bins[i] && (beta < bins[i + 1] || (last && beta <= bins[i + 1]))) return i;
  }
  return -1;
}

function contourMakeRng(seed = 123456789) {
  let x = (Number(seed) >>> 0) || 123456789;
  return () => {
    // Mulberry32: small deterministic PRNG, sufficient for reproducible sampling.
    x += 0x6D2B79F5;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function contourRandomSunwardDir(axis, expcos, rng) {
  const u1 = rng(), u2 = rng();
  const z = Math.pow(u1, 1 / (Math.max(0, expcos) + 1));
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * u2;
  const lx = r * Math.cos(phi), ly = r * Math.sin(phi);

  const up = axis.clone().normalize();
  const tmp = Math.abs(up.x) < 0.9
    ? new BABYLON.Vector3(1, 0, 0)
    : new BABYLON.Vector3(0, 1, 0);
  const right = BABYLON.Vector3.Cross(up, tmp).normalize();
  const fwd = BABYLON.Vector3.Cross(right, up).normalize();
  return right.scale(lx).add(fwd.scale(ly)).addInPlace(up.scale(z));
}

function contourRandomIsotropicDir(rng) {
  const z = 2 * rng() - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * rng();
  return new BABYLON.Vector3(r * Math.cos(phi), r * Math.sin(phi), z);
}

function contourRandomNormal(rng) {
  // Box-Muller transform.  Kept local to the export path so a contour export is
  // deterministic for a given seed and does not depend on renderer timing.
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function contourLognormalMeanOneFactor(logSigma, rng) {
  const sigma = Math.max(0, Number(logSigma) || 0);
  if (!(sigma > 0)) return 1;
  // exp(sigma*z - sigma^2/2) has mean one.  This softens unnaturally sharp
  // shells without changing the requested mean ejection speed.
  return Math.exp(sigma * contourRandomNormal(rng) - 0.5 * sigma * sigma);
}

function contourRandomEmission(axis, expcos, isotropicFraction, isotropicSpeedFactor, speedScatterLogSigma, rng) {
  const mix = Math.max(0, Math.min(1, Number(isotropicFraction) || 0));
  const isotropic = rng() < mix;
  const dir = isotropic
    ? contourRandomIsotropicDir(rng)
    : contourRandomSunwardDir(axis, expcos, rng);
  const componentSpeedFactor = isotropic
    ? Math.max(0, Number(isotropicSpeedFactor) || 0)
    : 1;
  return {
    dir,
    isotropic,
    speedFactor: componentSpeedFactor * contourLognormalMeanOneFactor(speedScatterLogSigma, rng)
  };
}

function contourFract(x) {
  return x - Math.floor(x);
}

function contourLinearPdfAt(points, x) {
  if (!Array.isArray(points) || points.length < 2) return null;
  if (x < points[0].x || x > points[points.length - 1].x) return 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (x >= a.x && x <= b.x) {
      const u = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return Math.max(0, a.y + u * (b.y - a.y));
    }
  }
  return 0;
}

function contourBuildBetaSampler(options = {}) {
  // The number-distribution curve and the rendered brightness distribution are
  // not the same thing: for spherical grains, cross-section scales as beta^-2.
  // Sampling the number PDF and assigning the full cross-section to every row is
  // unbiased, but it is noisy because a handful of low-beta particles dominate.
  // Importance sampling draws beta from numberPDF * crossSection instead and
  // gives each row the mean cross-section. The expected synthetic image is the
  // same, while Monte-Carlo speckle is dramatically reduced.
  const explicitPoints = Array.isArray(options.explicitPoints) && options.explicitPoints.length >= 2
    ? options.explicitPoints
      .map(p => ({ x: contourNumber(p.x, 0, 0, 1), y: contourNumber(p.y, 0, 0, Infinity) }))
      .sort((a, b) => a.x - b.x)
    : null;
  const densityKgM3 = contourNumber(options.densityKgM3, 1000, 1, 10000);
  const qpr = contourNumber(options.qpr, 1, 0.0001, 10);
  const weightMode = options.weightMode === 'count' ? 'count' : 'cross_section';
  const requestedMode = String(options.samplingMode || 'auto');
  const samplingMode = weightMode === 'cross_section' && requestedMode !== 'number'
    ? 'cross_section_importance'
    : 'number';
  const betaFloor = contourNumber(options.betaFloor, 1e-4, 1e-8, 1);
  const curveMaxX = explicitPoints && explicitPoints.length
    ? Math.max(...explicitPoints.map((p) => Number(p.x) || 0))
    : 1;
  const betaCeil = Math.max(betaFloor + 1e-9,
    contourNumber(options.betaMax, Math.max(1e-9, curveMaxX), 1e-8, 100));
  const tableSize = Math.floor(contourNumber(options.tableSize, 16384, 256, 65536));
  const xs = new Float64Array(tableSize);
  const numberPdf = new Float64Array(tableSize);
  const proposalPdf = new Float64Array(tableSize);
  const cdf = new Float64Array(tableSize);

  const numberPdfAt = (beta) => {
    if (beta < betaFloor) return 0;
    if (explicitPoints) return contourLinearPdfAt(explicitPoints, beta);
    if (typeof valueAt === 'function') {
      const y = valueAt(beta);
      return y === null ? 0 : Math.max(0, Number(y) || 0);
    }
    return 1;
  };

  let numberSum = 0;
  let crossSectionSum = 0;
  let proposalSum = 0;
  for (let i = 0; i < tableSize; i++) {
    const beta = betaFloor + (betaCeil - betaFloor) * i / (tableSize - 1);
    const nPdf = numberPdfAt(beta);
    const radiusM = contourRadiusMetersFromBeta(beta, densityKgM3, qpr);
    const areaM2 = Math.PI * radiusM * radiusM;
    const proposal = samplingMode === 'cross_section_importance' ? nPdf * areaM2 : nPdf;
    xs[i] = beta;
    numberPdf[i] = nPdf;
    proposalPdf[i] = proposal;
    numberSum += nPdf;
    crossSectionSum += nPdf * areaM2;
    proposalSum += proposal;
  }

  if (!(proposalSum > 0)) {
    throw new Error('Beta PDF is empty. Check betaCurvePoints and betaFloor.');
  }

  let acc = 0;
  for (let i = 0; i < tableSize; i++) {
    acc += proposalPdf[i] / proposalSum;
    cdf[i] = acc;
  }
  cdf[tableSize - 1] = 1;
  const meanCrossSectionM2 = crossSectionSum / Math.max(numberSum, 1e-300);

  const sampleU = (uRaw) => {
    const u = Math.min(1 - Number.EPSILON, Math.max(0, Number(uRaw) || 0));
    let lo = 0, hi = tableSize - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] >= u) hi = mid; else lo = mid + 1;
    }
    const i = lo;
    const c0 = i === 0 ? 0 : cdf[i - 1];
    const c1 = cdf[i];
    const t = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
    const x0 = i === 0 ? xs[0] : xs[i - 1];
    const x1 = xs[i];
    return Math.min(betaCeil, Math.max(betaFloor, x0 + t * (x1 - x0)));
  };

  const brightnessWeightForBeta = (beta) => {
    if (weightMode === 'count') return 1;
    if (samplingMode === 'cross_section_importance') return meanCrossSectionM2;
    const radiusM = contourRadiusMetersFromBeta(beta, densityKgM3, qpr);
    return Math.PI * radiusM * radiusM;
  };

  return {
    sampleU,
    brightnessWeightForBeta,
    metadata: {
      samplingMode,
      betaFloor,
      tableSize,
      meanCrossSectionM2,
      curvePoints: explicitPoints
    }
  };
}

function contourObserverScenePosition(observationJD = simulationTimeJD) {
  // For reproducible exports, use the observer position at the requested
  // observation epoch rather than whatever happens to be rendered on screen.
  if (observerViewActive && observerViewState) return getObserverPosition(observerViewState);
  return getPlanetPosition(observationJD, earthEl);
}

function contourRadiusMetersFromBeta(beta, densityKgM3, qpr) {
  const betaSafe = Math.max(1e-8, Math.abs(beta));
  const densityGcm3 = Math.max(1e-12, densityKgM3 / 1000);
  return (0.57 * qpr / (densityGcm3 * betaSafe)) * 1e-6;
}

function contourApplyUiPreset(preset = {}) {
  const set = (id, value) => {
    if (value === undefined || value === null) return;
    const el = document.getElementById(id);
    if (el) el.value = String(value);
  };

  const orbit = preset.comet || preset.orbit || {};
  set('eccentricityInput', orbit.e);
  set('perihelionInput', orbit.qAU);
  set('inclinationInput', orbit.iDeg);
  set('longitudeAscendingNodeInput', orbit.OmegaDeg);
  set('argumentPerihelionInput', orbit.omegaDeg);
  set('perihelionDateInput', orbit.perihelionJD);

  const tail = preset.tail || {};
  set('particleCountInput', tail.particlesPerDay);
  set('particleLifetimeInput', tail.lifetimeDays);
  set('activityExponentInput', tail.activityExponent);
  set('activityScaleInput', tail.activityScale);
  set('activityHalfLifeInput', tail.activityHalfLifeEDays);
  set('ejectionSpeedInput', tail.ejectionSpeedMps);
  set('ejectionGammaInput', tail.ejectionGamma);
  set('ejectionKappaInput', tail.ejectionKappa);
  set('ejectionExpcosInput', tail.ejectionExpcos);

  if (Array.isArray(tail.betaCurvePoints) && tail.betaCurvePoints.length >= 2 && typeof betaUI !== 'undefined') {
    betaUI.pts = tail.betaCurvePoints.map(p => ({ x: Number(p.x), y: Number(p.y) }));
    recomputeDomain();
    rebuildBetaTables();
    drawBetaCurve();
  }

  updateOrbitParameters();

  if (Number.isFinite(Number(preset.observationJD))) {
    setSimTime(Number(preset.observationJD), { resetParticles: true, focus: true });
  }

  if (preset.activateEarthTelescope !== false) {
    if (observerPresetSelect) observerPresetSelect.value = 'manual';
    if (observerModeSelect) observerModeSelect.value = 'earth';
    if (observerTargetSelect) observerTargetSelect.value = 'comet';
    if (observerFovInput && Number.isFinite(Number(preset.previewFovDeg))) observerFovInput.value = String(preset.previewFovDeg);
    if (observerRollInput && Number.isFinite(Number(preset.previewRollDeg))) observerRollInput.value = String(preset.previewRollDeg);
    applyObserverViewFromUI();
  }
}

async function bakeAndExportTelescopeContourData(options = {}) {
  const observationJD = contourNumber(options.observationJD, simulationTimeJD);
  const historyDays = contourNumber(options.historyDays, Number(contourHistoryDaysInput?.value || 240), 1, 10000);
  const dtDays = contourNumber(options.dtDays, 1, 0.05, 50);
  const particlesPerDay = contourNumber(options.particlesPerDay, Number(contourParticlesPerDayInput?.value || 1200), 1, 1000000);
  const maxParticles = Math.floor(contourNumber(options.maxParticles, 500000, 100, 5000000));
  const bins = contourParseBins(options.betaBins ?? contourBetaBinsInput?.value);
  const weightMode = options.weightMode || contourWeightModeSelect?.value || 'cross_section';
  const densityKgM3 = contourNumber(options.densityKgM3, 1000, 1, 10000);
  const qpr = contourNumber(options.qpr, 1, 0.0001, 10);
  const seed = Math.floor(contourNumber(options.seed, 20240530, 1, 4294967295));
  const rng = contourMakeRng(seed);

  const useUi = options.useUiParameters !== false;
  const speedMps = contourNumber(options.ejectionSpeedMps, useUi ? ejectionSpeedMps : 80, 0, 100000);
  const gamma = contourNumber(options.ejectionGamma, useUi ? ejectionGamma : 0.35, 0, 3);
  const kappa = contourNumber(options.ejectionKappa, useUi ? ejectionKappa : -0.5, -5, 5);
  const expcos = contourNumber(options.ejectionExpcos, useUi ? ejectionExpcos : 1, 0, 20);
  const isotropicFraction = contourNumber(options.ejectionIsotropicFraction, 0, 0, 1);
  const isotropicSpeedFactor = contourNumber(options.ejectionIsotropicSpeedFactor, 1, 0, 20);
  const speedScatterLogSigma = contourNumber(options.ejectionSpeedScatterLogSigma, 0, 0, 2);
  const activityExponent = contourNumber(options.activityExponent, useUi ? activityN : 2, 0, 10);
  const activityScale = contourNumber(options.activityScale, useUi ? activityK : 1, 0, 1e12);
  const betaCurvePoints = options.betaCurvePoints || null;
  const betaSamplingMode = options.betaSamplingMode || 'auto';
  const betaFloor = contourNumber(options.betaFloor, 1e-4, 1e-8, 1);
  const stratifyBeta = options.stratifyBeta !== false;
  const birthTimeSubsteps = Math.floor(contourNumber(options.birthTimeSubsteps, 8, 1, 128));
  const betaSampler = contourBuildBetaSampler({
    explicitPoints: betaCurvePoints,
    densityKgM3,
    qpr,
    weightMode,
    samplingMode: betaSamplingMode,
    betaFloor
  });

  const observerScene = contourObserverScenePosition(observationJD);
  const nucleusScene = cometStateAtJD(observationJD).r_scene;
  const nucleusRaDec = heliocentricSceneToRaDec(nucleusScene, observerScene);
  const rows = [[
    'particle_index', 'beta', 'beta_bin', 'radius_um_from_beta', 'cross_section_m2',
    'brightness_weight', 'ra_deg', 'dec_deg', 'birth_jd', 'age_days',
    'ejection_component', 'ejection_speed_mps',
    'distance_from_comet_km', 'position_au_x', 'position_au_y', 'position_au_z'
  ]];

  const startJD = observationJD - historyDays;
  const nSteps = Math.ceil(historyDays / dtDays);
  let emitted = 0;

  const btn = exportContourDataBtn;
  const oldText = btn?.textContent;
  if (btn) btn.textContent = 'Baking contour data…';

  try {
    for (let step = 0; step < nSteps && emitted < maxParticles; step++) {
      const intervalStartJD = startJD + step * dtDays;
      const intervalWidthDays = Math.min(dtDays, observationJD - intervalStartJD);
      if (!(intervalWidthDays > 0)) break;
      const midCs = cometStateAtJD(intervalStartJD + 0.5 * intervalWidthDays);
      const rhAU = Math.max(0.05, midCs.rh_AU);
      const activity = Math.min(1, activityScale / Math.pow(rhAU, activityExponent));
      const births = Math.min(maxParticles - emitted, Math.max(0, Math.round(particlesPerDay * activity * intervalWidthDays)));
      const nBirthSubsteps = Math.max(1, Math.min(birthTimeSubsteps, births || 1));
      const emitStates = new Array(nBirthSubsteps);
      for (let s = 0; s < nBirthSubsteps; s++) {
        const birthJD = intervalStartJD + ((s + 0.5) / nBirthSubsteps) * intervalWidthDays;
        emitStates[s] = { birthJD, cs: cometStateAtJD(birthJD) };
      }
      const birthPhase = Math.floor(rng() * nBirthSubsteps);
      const betaPhase = rng();

      for (let j = 0; j < births; j++) {
        const emitState = emitStates[(j + birthPhase) % nBirthSubsteps];
        const birthJD = emitState.birthJD;
        const cs = emitState.cs;
        const particleRhAU = Math.max(0.05, cs.rh_AU);
        const betaU = stratifyBeta ? contourFract(betaPhase + (j + rng()) / Math.max(1, births)) : rng();
        const beta = betaSampler.sampleU(betaU);
        const r0Scene = cs.r_scene.clone();
        const vScene = cs.v_scene_per_s.clone();
        let ejectionComponent = 0; // 0 = sunward/dayside, 1 = isotropic background
        let particleEjectionSpeedMps = 0;
        if (speedMps > 0) {
          const vEj = speedMps * Math.pow(Math.max(beta, 1e-12), gamma) * Math.pow(particleRhAU, kappa);
          const sunward = r0Scene.scale(-1).normalize();
          const emission = contourRandomEmission(
            sunward, expcos, isotropicFraction, isotropicSpeedFactor, speedScatterLogSigma, rng
          );
          ejectionComponent = emission.isotropic ? 1 : 0;
          particleEjectionSpeedMps = vEj * emission.speedFactor;
          vScene.addInPlace(emission.dir.scale(particleEjectionSpeedMps * SCALE));
        }

        const dt = (observationJD - birthJD) * SECONDS_PER_DAY;
        const r0m = r0Scene.scale(1 / SCALE);
        const v0mps = vScene.scale(1 / SCALE);
        const mu = GMsun * (1 - beta);
        let rm;
        if (mu === 0) rm = r0m.add(v0mps.scale(dt));
        else rm = keplerUniversalPropagate(r0m, v0mps, dt, mu).r;
        const posScene = rm.scale(SCALE);
        const rd = heliocentricSceneToRaDec(posScene, observerScene);
        const radiusM = contourRadiusMetersFromBeta(beta, densityKgM3, qpr);
        const crossSectionM2 = Math.PI * radiusM * radiusM;
        const brightnessWeight = betaSampler.brightnessWeightForBeta(beta);
        const betaBin = contourBinIndex(beta, bins);
        const dKm = BABYLON.Vector3.Distance(posScene, nucleusScene) / SCALE / 1000;

        rows.push([
          emitted, beta, betaBin, radiusM * 1e6, crossSectionM2, brightnessWeight,
          rd.raDeg, rd.decDeg, birthJD, observationJD - birthJD,
          ejectionComponent, particleEjectionSpeedMps, dKm,
          posScene.x / (AU * SCALE), posScene.y / (AU * SCALE), posScene.z / (AU * SCALE)
        ]);
        emitted++;
      }

      if ((step % 5) === 0) {
        if (btn) btn.textContent = `Baking contour data… ${Math.round(100 * step / Math.max(1, nSteps))}%`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const date = jdToDateString(observationJD);
    const stem = String(options.filenamePrefix || `telescope_contours_${date}_JD${observationJD.toFixed(5)}`)
      .replace(/[^a-zA-Z0-9_.-]+/g, '_');
    downloadCSV(`${stem}_particles.csv`, rows);
    downloadJSON(`${stem}_meta.json`, {
      format: 'comet-tail-contour-particles-v2',
      createdUTC: new Date().toISOString(),
      observationJD,
      observationDateUTC: date,
      particlesExported: emitted,
      observer: observerViewActive ? getObserverModeLabel(observerViewState) : 'Earth/geocentric fallback',
      nucleus: { raDeg: nucleusRaDec.raDeg, decDeg: nucleusRaDec.decDeg },
      betaBins: bins,
      brightnessWeight: weightMode,
      betaToRadius: { densityKgM3, qpr, formula: 'radius_um = 0.57*qpr/(density_g_cm3*beta)' },
      bake: { historyDays, dtDays, particlesPerDay, maxParticles, seed, birthTimeSubsteps, stratifyBeta },
      betaSampling: betaSampler.metadata,
      tailModel: {
        ejectionSpeedMps: speedMps,
        ejectionGamma: gamma,
        ejectionKappa: kappa,
        ejectionExpcos: expcos,
        ejectionIsotropicFraction: isotropicFraction,
        ejectionIsotropicSpeedFactor: isotropicSpeedFactor,
        ejectionSpeedScatterLogSigma: speedScatterLogSigma,
        activityExponent,
        activityScale
      },
      orbit: { e, qAU: q / AU, iDeg: i / DEG, OmegaDeg: Omega / DEG, omegaDeg: omega / DEG, perihelionJD: t0 },
      comparisonHints: options.comparisonHints && typeof options.comparisonHints === 'object'
        ? options.comparisonHints
        : null,
      note: 'Use the companion external/contour_overlay tool. Red contour lines are synthetic isophotes. Per-beta panels are diagnostic subsets, not a replacement for total synthetic isophotes.'
    });
    console.log(`[ContourExport] ${emitted} baked particles exported as ${stem}_particles.csv`);
    return { stem, emitted, rows };
  } finally {
    if (btn) btn.textContent = oldText || 'Export telescope contour data';
  }
}

function contourOptionsFromUi() {
  return {
    historyDays: Number(contourHistoryDaysInput?.value || 240),
    particlesPerDay: Number(contourParticlesPerDayInput?.value || 1200),
    betaBins: contourBetaBinsInput?.value,
    weightMode: contourWeightModeSelect?.value || 'cross_section'
  };
}

exportContourDataBtn?.addEventListener('click', async () => {
  try {
    await bakeAndExportTelescopeContourData(contourOptionsFromUi());
  } catch (err) {
    console.error('[ContourExport] failed', err);
    alert(`Contour export failed: ${err?.message || err}`);
  }
});

window.contourApplyUiPreset = contourApplyUiPreset;
window.bakeAndExportTelescopeContourData = bakeAndExportTelescopeContourData;
