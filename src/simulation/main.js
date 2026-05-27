
let simulationTimeJD = 2451544.5;
let simulationSpeed  = 1;
let isPaused         = false;
let uiAccum          = 0;
window.simulationTimeJD = simulationTimeJD;

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
  simulationTimeJD = selectedJD;
  const cs = cometStateAtJD(simulationTimeJD);
  cometMesh.position.copyFrom(cs.r_scene);
  earthMesh.position.copyFrom(getPlanetPosition(simulationTimeJD, earthEl));
  tailParticles.length = 0;
  for (let i = 0; i < particleMeshes.length; i++) particleMeshes[i].setEnabled(false);
  if (rawParticles) rawParticles.clear();
  cpuSlots.fill(undefined);
  gpuWriteCursor = 0;
  maxUsed = 0;
  expiryByIndex.fill(0);
  betaByIndex?.fill?.(0);
  birthJDByIndex?.fill?.(0);
  lifeSecondsByIndex?.fill?.(0);
  simSeconds = 0;
  window.emitCarry = 0;
});

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
