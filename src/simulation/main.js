
let simulationTimeJD = 2451544.5;
let simulationSpeed  = 1;
let isPaused         = false;
let uiAccum          = 0;
window.simulationTimeJD = simulationTimeJD;

let isHeadless       = false;
let headlessRunning  = Promise.resolve();
let headlessAbortFlag = { cancelled: false };

const timelineSlider  = document.getElementById("timelineSlider");
const timelineLabel   = document.getElementById("timelineLabel");
const updateViewBtn   = document.getElementById("updateViewBtn");
const timeDisplay     = document.getElementById("simTimeDisplay");

// ─── Time display ─────────────────────────────────────────────────────────────

function updateTimeDisplay(jd) {
  const dt  = julianDayToDate(jd);
  const pad = (n) => n.toString().padStart(2, "0");
  timeDisplay.innerText =
    `${dt.year}/${pad(dt.month)}/${pad(dt.day)} ` +
    `${pad(dt.hours)}:${pad(dt.minutes)}:${pad(dt.seconds)} UTC`;
}

function updateTimelineUIState() {
  timelineSlider.disabled = !isPaused;
  updateViewBtn.disabled  = !isPaused;
}

timelineSlider.addEventListener("input", () => {
  const jd = baseJD + parseInt(timelineSlider.value);
  timelineLabel.textContent = `Date: ${jdToDateString(jd)}`;
});

// ─── Jump-to-date ───────────────────────────────────────────────

updateViewBtn.addEventListener("click", () => {
  const selectedJD = baseJD + parseInt(timelineSlider.value);
  headlessPropagate(selectedJD);
});

// ─── Headless propagation ───────────────────────────────────────────────────

// Optional validation-only emission history. Interactive runs leave this null
// and retain the native heliocentric-distance/activity-exposure law below.
// Density validation can install the same perihelion-relative log10(dM/dt)
// table used by COMTAILS so release-time weighting is no longer a confound.
let validationEmissionScaleAtJD = null;
window.setValidationEmissionLogProfile = function(daysFromPerihelion, logRates) {
  if (!Array.isArray(daysFromPerihelion) || !Array.isArray(logRates) ||
      daysFromPerihelion.length !== logRates.length || daysFromPerihelion.length < 2) {
    throw new Error("Validation emission profile requires equal arrays with at least two samples");
  }
  const days = daysFromPerihelion.map(Number);
  const logs = logRates.map(Number);
  const logMax = Math.max(...logs);
  validationEmissionScaleAtJD = (jd) => {
    const x = jd - t0;
    if (x <= days[0]) return Math.pow(10, logs[0] - logMax);
    if (x >= days[days.length - 1]) return Math.pow(10, logs[logs.length - 1] - logMax);
    let hi = 1;
    while (hi < days.length && days[hi] < x) hi++;
    const lo = hi - 1;
    const f = (x - days[lo]) / (days[hi] - days[lo]);
    const logRate = logs[lo] + f * (logs[hi] - logs[lo]);
    return Math.pow(10, logRate - logMax);
  };
};
window.clearValidationEmissionProfile = function() {
  validationEmissionScaleAtJD = null;
};

async function headlessPropagate(targetJD, {
  dtDays = 1.0,
  collectMetrics = false,
  waitForGpu = false,
} = {}) {
  // Cancel any running headless pass
  headlessAbortFlag.cancelled = true;
  headlessAbortFlag = { cancelled: false };
  const myFlag = headlessAbortFlag;

  // Wait for the previous pass to fully exit before touching shared state
  await headlessRunning.catch(() => {});
  if (myFlag.cancelled) return;

  let resolveRunning;
  headlessRunning = new Promise(r => { resolveRunning = r; });

  // Progress overlay
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.72);display:flex;' +
    'flex-direction:column;align-items:center;justify-content:center;' +
    'z-index:9999;color:#e8e8e8;font-family:monospace;font-size:13px;gap:10px;';
  const label = document.createElement('div');
  const barWrap = document.createElement('div');
  barWrap.style.cssText = 'width:280px;height:6px;background:#2a2a2a;border-radius:3px;overflow:hidden;';
  const fill = document.createElement('div');
  fill.style.cssText = 'height:100%;width:0%;background:#4ab4ff;border-radius:3px;';
  barWrap.appendChild(fill);
  overlay.appendChild(label);
  overlay.appendChild(barWrap);
  document.body.appendChild(overlay);

  const savedPaused = isPaused;
  isPaused  = true;
  isHeadless = true;

  const lifetimeDays = baseLifetime / velocityScale;
  const startJD      = targetJD - lifetimeDays;
  const totalSteps   = Math.ceil(lifetimeDays / dtDays);
  const dtSeconds    = dtDays * SECONDS_PER_DAY;
  const metrics = {
    targetJD,
    startJD,
    historyDays: lifetimeDays,
    dtDays,
    totalSteps,
    requestedBirths: 0,
    attemptedBirths: 0,
    acceptedBirths: 0,
    hardCapClippedBirths: 0,
    capacityDroppedBirths: 0,
    gpuDispatches: 0,
    particleStepUpdates: 0,
    finalActiveParticles: 0,
    finalMaxUsed: 0,
    bufferCapacity: rawParticles?.max ?? cpuSlots?.length ?? 0,
    completed: false,
  };

  setSimTime(startJD, { resetParticles: true, focus: false });
  window.emitCarry = 0;

  try {
    for (let step = 0; step < totalSteps; step++) {
      if (myFlag.cancelled) break;

      const cs  = cometStateAtJD(simulationTimeJD);
      const rAU = Math.max(1e-3, cs.rh_AU);

      if (rAU <= ACTIVE_R_AU) {
        cumulativeExposure += dtDays / (rAU * rAU);
      }
      const ageFactor = Math.exp(-Math.LN2 * (cumulativeExposure / Math.max(1e-6, fadeHalfLifeEDays)));

      const Q = Math.max(0, activityK) * ageFactor / Math.pow(rAU, Math.max(0, activityN));
      const scale = validationEmissionScaleAtJD
        ? Math.max(0, Math.min(1, validationEmissionScaleAtJD(simulationTimeJD)))
        : Math.min(1, Q);
      const pPerDay = Math.max(0, parseFloat(particleCountInput.value) || 0);
      window.emitCarry += pPerDay * scale * dtDays;
      let births = Math.floor(window.emitCarry);
      window.emitCarry -= births;
      if (collectMetrics) metrics.requestedBirths += births;
      if (births > HARD_CAP) {
        if (collectMetrics) metrics.hardCapClippedBirths += births - HARD_CAP;
        births = HARD_CAP;
      }

      for (let k = 0; k < births; k++) {
        const accepted = createTailParticle(simulationTimeJD);
        if (collectMetrics) {
          metrics.attemptedBirths++;
          if (accepted) metrics.acceptedBirths++;
          else metrics.capacityDroppedBirths++;
        }
      }

      simulationTimeJD += dtDays;
      simSeconds       += dtSeconds;

      if (rawParticles && maxUsed > 0) {
        rawParticles.computeOnly(dtSeconds, maxUsed);
        if (collectMetrics) {
          metrics.gpuDispatches++;
          metrics.particleStepUpdates += maxUsed;
        }
      }

      // Yield every 20 steps so the browser stays responsive
      if (step % 20 === 19) {
        const pct = Math.round((step + 1) / totalSteps * 100);
        fill.style.width = pct + '%';
        label.textContent = `Prefilling tail… ${pct}%  (${jdToDateString(simulationTimeJD)})`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (!myFlag.cancelled) {
      if (waitForGpu && rawParticles && engine?._device?.queue?.onSubmittedWorkDone) {
        await engine._device.queue.onSubmittedWorkDone();
      }

      simulationTimeJD        = targetJD;
      window.simulationTimeJD = targetJD;
      timelineSlider.value    = String(Math.floor(targetJD - baseJD));
      timelineLabel.textContent = `Date: ${jdToDateString(targetJD)}`;
      updateTimeDisplay(targetJD);
      const cs = cometStateAtJD(targetJD);
      cometMesh.position.copyFrom(cs.r_scene);
      earthMesh.position.copyFrom(getPlanetPosition(targetJD, earthEl));

      // CPU path: the render loop only updates mesh positions when unpaused,
      // so force one position pass here so particles appear correctly when paused.
      if (!rawParticles) {
        for (let k = 0; k < maxUsed; k++) {
          const slot  = cpuSlots[k];
          const alive = (expiryByIndex[k] > simSeconds) && slot;
          const mesh  = particleMeshes[k];
          if (!alive) { if (mesh.isEnabled()) mesh.setEnabled(false); continue; }
          const dt = (targetJD - slot.t0JD) * SECONDS_PER_DAY;
          let rScene;
          if (dt <= 0) {
            rScene = slot.r0_m.scale(SCALE);
          } else if (slot.mu === 0) {
            rScene = slot.r0_m.add(slot.v0_mps.scale(dt)).scale(SCALE);
          } else {
            rScene = keplerUniversalPropagate(slot.r0_m, slot.v0_mps, dt, slot.mu).r.scale(SCALE);
          }
          mesh.position.copyFrom(rScene);
          if (!mesh.isEnabled()) mesh.setEnabled(true);
        }
      }

      if (collectMetrics) {
        let activeParticles = 0;
        for (let k = 0; k < maxUsed; k++) {
          if (expiryByIndex[k] > simSeconds) activeParticles++;
        }
        metrics.finalActiveParticles = activeParticles;
        metrics.finalMaxUsed = maxUsed;
        metrics.completed = true;
      }
    }
  } finally {
    isHeadless = false;
    isPaused   = savedPaused;
    document.body.removeChild(overlay);
    resolveRunning();
  }

  return collectMetrics ? metrics : undefined;
}
window.headlessPropagate = headlessPropagate;

// ─── Set simulation time ────────────────

function setSimTime(jd, opts = {}) {
  const { resetParticles = true, focus = true } = opts;
  simulationTimeJD = jd;
  window.simulationTimeJD = simulationTimeJD;
  timelineSlider.value = String(Math.floor(jd - baseJD));
  timelineLabel.textContent = `Date: ${jdToDateString(jd)}`;
  updateTimeDisplay(jd);

  const cs = cometStateAtJD(jd);
  cometMesh.position.copyFrom(cs.r_scene);
  earthMesh.position.copyFrom(getPlanetPosition(jd, earthEl));

  if (resetParticles) {
    tailParticles.length = 0;
    for (let i = 0; i < particleMeshes.length; i++) particleMeshes[i].setEnabled(false);
    if (rawParticles) rawParticles.clear();
    gpuWriteCursor = 0;
    maxUsed = 0;
    expiryByIndex.fill(0);
    simSeconds = 0;
    window.emitCarry = 0;
    resetExposure();
  }

  if (focus) setFocusOnComet(true);
}
window.setSimTime = setSimTime;

// ─── Main entry point ─────────────────────────────────────────────────────────

async function startSimulation() {
  await initEngine();
  initCamera();
  initWorld();
  initPlanets();
  initComet();
  initSyndyneSynchrone();
  await initParticles();
  initUI();

  window.addEventListener("resize", () => {
    engine.resize();
    if (rawParticles) rawParticles.resize();
  });

  startRenderLoop();
}
