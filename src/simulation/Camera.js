let camera, lockedCam;
let isCamPosLocked            = false;
let isCameraFocused           = false;
let autoTrackCometWhileLocked = false;
let lockMode                  = "none";
let savedArcRotateState       = null;
let lastCameraTarget, lastCameraRadius;

let observerViewActive = false;
let observerViewState  = null;
let lastObserverMetadata = "";

const lockEarthBtn  = document.getElementById("lockEarthBtn");
const toggleFocusBtn = document.getElementById("toggleFocusBtn");

const observerPresetSelect     = document.getElementById("observerPresetSelect");
const observerModeSelect       = document.getElementById("observerModeSelect");
const observerXYZInput         = document.getElementById("observerXYZInput");
const observerUnitSelect       = document.getElementById("observerUnitSelect");
const observerGroundLabelInput = document.getElementById("observerGroundLabelInput");
const observerGroundLonInput   = document.getElementById("observerGroundLonInput");
const observerGroundLatInput   = document.getElementById("observerGroundLatInput");
const observerGroundAltInput   = document.getElementById("observerGroundAltInput");
const observerTargetSelect     = document.getElementById("observerTargetSelect");
const observerRaInput          = document.getElementById("observerRaInput");
const observerDecInput         = document.getElementById("observerDecInput");
const observerFovInput         = document.getElementById("observerFovInput");
const observerRollInput        = document.getElementById("observerRollInput");
const applyObserverViewBtn     = document.getElementById("applyObserverViewBtn");
const exitObserverViewBtn      = document.getElementById("exitObserverViewBtn");
const copyObserverMetadataBtn  = document.getElementById("copyObserverMetadataBtn");
const saveObserverScreenshotBtn = document.getElementById("saveObserverScreenshotBtn");
const exportBetaSizedTelescopeImageBtn = document.getElementById("exportBetaSizedTelescopeImageBtn");
const betaSizeDensityInput     = document.getElementById("betaSizeDensityInput");
const betaSizeQprInput         = document.getElementById("betaSizeQprInput");
const betaSizeMagnifierInput   = document.getElementById("betaSizeMagnifierInput");
const betaSizeMinPxInput       = document.getElementById("betaSizeMinPxInput");
const betaSizeMaxPxInput       = document.getElementById("betaSizeMaxPxInput");
const observerInfo             = document.getElementById("observerInfo");
const observerReticle          = document.getElementById("observerReticle");
const observerStatus           = document.getElementById("observerStatus");

const SPACE_TELESCOPE_PRESETS = {
  manual: null,
  hubble: {
    name: "Hubble Space Telescope",
    shortName: "Hubble",
    type: "earthOrbit",
    altitudeKm: 540,
    inclinationDeg: 28.5,
    periodMin: 95.4,
    raanDeg: 32,
    phaseDeg: 15,
    fovDeg: 0.05,
    note: "Approximate low-Earth orbit position; not a live TLE/ephemeris."
  },
  jwst: {
    name: "James Webb Space Telescope",
    shortName: "JWST",
    type: "earthLine",
    point: "L2",
    distanceKm: 1_500_000,
    fovDeg: 0.07,
    note: "Approximate Sun–Earth L2 viewpoint, 1.5 million km anti-sunward from Earth."
  },
  neowise: {
    name: "NEOWISE / WISE",
    shortName: "NEOWISE",
    type: "earthOrbit",
    altitudeKm: 525,
    inclinationDeg: 97.5,
    periodMin: 94.5,
    raanDeg: 90,
    phaseDeg: 270,
    fovDeg: 47 / 60,
    note: "Historical approximate sun-synchronous polar orbit. NEOWISE ended operations in 2024."
  },
  soho: {
    name: "Solar and Heliospheric Observatory",
    shortName: "SOHO",
    type: "earthLine",
    point: "L1",
    distanceKm: 1_500_000,
    fovDeg: 5.0,
    note: "Approximate Sun–Earth L1 viewpoint, 1.5 million km sunward from Earth."
  },
  stereoA: {
    name: "STEREO-A",
    shortName: "STEREO-A",
    type: "heliocentricOffset",
    longitudeOffsetDeg: -20,
    radialScale: 0.96,
    fovDeg: 1.0,
    note: "Approximate heliocentric viewpoint offset from Earth. Use Horizons/SPICE for publication-grade work."
  }
};

function initCamera() {
  camera = new BABYLON.ArcRotateCamera("orbitCamera", Math.PI / 2, Math.PI / 3, 100, BABYLON.Vector3.Zero(), scene);
  camera.allowUpsideDown = false;
  const eps = 0.01;
  camera.lowerBetaLimit = eps;
  camera.upperBetaLimit = Math.PI - eps;
  camera.upVector       = new BABYLON.Vector3(0, 0, 1);
  camera.maxZ = 1e9;
  camera.minZ = 0.1;
  camera.attachControl(canvas, true);
  camera.wheelDeltaPercentage = 0.005;
  camera.panningSensibility    = 300;

  camera.alpha  = Math.PI / 2;
  camera.beta   = Math.PI / 2;
  camera.radius = 120;
  camera.setTarget(BABYLON.Vector3.Zero());

  lastCameraTarget = camera.target.clone();
  lastCameraRadius = camera.radius;

  toggleFocusBtn.onclick = () => {
    if (observerViewActive) {
      setObserverTargetMode("comet");
      return;
    }
    if (isCamPosLocked) {
      setFocusOnComet(!autoTrackCometWhileLocked);
    } else {
      setFocusOnComet(!isCameraFocused);
    }
  };

  applyObserverViewBtn?.addEventListener("click", applyObserverViewFromUI);
  exitObserverViewBtn?.addEventListener("click", exitObserverView);
  copyObserverMetadataBtn?.addEventListener("click", copyObserverMetadata);
  saveObserverScreenshotBtn?.addEventListener("click", saveObserverScreenshot);
  exportBetaSizedTelescopeImageBtn?.addEventListener("click", exportBetaSizedTelescopeImage);

  for (const el of [
    observerPresetSelect, observerModeSelect, observerXYZInput, observerUnitSelect, observerGroundLabelInput,
    observerGroundLonInput, observerGroundLatInput, observerGroundAltInput, observerTargetSelect,
    observerRaInput, observerDecInput, observerFovInput, observerRollInput
  ]) {
    el?.addEventListener("input", () => {
      if (observerViewActive) applyObserverViewFromUI({ keepState: true });
    });
    el?.addEventListener("change", () => {
      if (observerViewActive) applyObserverViewFromUI({ keepState: true });
    });
  }

  observerPresetSelect?.addEventListener("change", () => {
    applyPresetDefaultsToUI(observerPresetSelect.value);
    if (observerViewActive) applyObserverViewFromUI({ keepState: true });
  });

  scene.onBeforeRenderObservable.add(() => {
    if (observerViewActive) {
      updateObserverCamera();
      return;
    }
    if (isCamPosLocked && lockMode === "earth" && lockedCam && earthMesh) {
      lockedCam.position.copyFrom(earthMesh.position);
    }
    if (isCamPosLocked && lockedCam && cometMesh && autoTrackCometWhileLocked) {
      lockedCam.setTarget(cometMesh.position);
    }
  });
}

function updateFocusButtonLabel() {
  if (observerViewActive) {
    toggleFocusBtn.textContent = "Track Comet";
    return;
  }
  if (isCamPosLocked) {
    toggleFocusBtn.textContent = autoTrackCometWhileLocked ? "Stop Tracking" : "Track Comet";
  } else {
    toggleFocusBtn.textContent = isCameraFocused ? "Unfocus Camera" : "Focus on Comet";
  }
}

function saveArcRotateState() {
  return {
    alpha: camera.alpha, beta: camera.beta,
    radius: camera.radius, target: camera.target.clone(),
    lockedTarget: camera.lockedTarget
  };
}

function createLockedCameraAtPosition(position, lookTarget) {
  disposeLockedCamera();
  lockedCam = new BABYLON.UniversalCamera("lockedCam", position.clone(), scene);
  lockedCam.upVector = new BABYLON.Vector3(0, 0, 1);
  if (lookTarget) lockedCam.setTarget(lookTarget);
  lockedCam.attachControl(canvas, true);
  lockedCam.inputs.removeByType("FreeCameraKeyboardMoveInput");
  lockedCam.inputs.removeByType("FreeCameraMouseWheelInput");
  lockedCam.speed = 0;
  lockedCam.maxZ = 1e9;
  lockedCam.minZ = 0.0001;
  scene.activeCamera = lockedCam;
  return lockedCam;
}

function disposeLockedCamera() {
  if (lockedCam) {
    lockedCam.detachControl(canvas);
    lockedCam.dispose();
    lockedCam = null;
  }
}

function lockCameraToEarth() {
  if (observerViewActive) exitObserverView();
  savedArcRotateState = saveArcRotateState();
  createLockedCameraAtPosition(getEarthPositionScene(), cometMesh?.position ?? camera.target);
  isCamPosLocked = true;
  lockMode = "earth";
  autoTrackCometWhileLocked = false;
  if (lockEarthBtn) lockEarthBtn.textContent = "Unlock Earth";
  updateFocusButtonLabel();
}

function lockCameraPositionToJ2000() {
  // The old standalone J2000 lock UI was intentionally removed.
  // Keep this compatibility function so legacy keyboard shortcut L does not crash.
  if (observerPresetSelect) observerPresetSelect.value = "manual";
  if (observerModeSelect) observerModeSelect.value = "j2000";
  applyObserverViewFromUI();
}

function unlockCameraPosition() {
  if (observerViewActive) {
    exitObserverView();
    return;
  }

  disposeLockedCamera();

  if (savedArcRotateState) {
    camera.alpha  = savedArcRotateState.alpha;
    camera.beta   = savedArcRotateState.beta;
    camera.radius = savedArcRotateState.radius;
    camera.setTarget(savedArcRotateState.target);
    camera.lockedTarget = savedArcRotateState.lockedTarget ?? null;
  }

  scene.activeCamera = camera;

  isCamPosLocked = false;
  lockMode = "none";
  autoTrackCometWhileLocked = false;

  if (lockEarthBtn) lockEarthBtn.textContent = "Lock to Earth";

  updateFocusButtonLabel();
}

function setFocusOnComet(on) {
  if (observerViewActive) {
    setObserverTargetMode("comet");
    return;
  }

  if (isCamPosLocked && lockedCam) {
    autoTrackCometWhileLocked = on;
    toggleFocusBtn.textContent = on ? "Unfocus Camera" : "Focus on Comet";
    if (on && cometMesh) lockedCam.setTarget(cometMesh.position);
    return;
  }

  isCameraFocused = on;
  toggleFocusBtn.textContent = on ? "Unfocus Camera" : "Focus on Comet";

  if (on && cometMesh) {
    lastCameraTarget = camera.target.clone();
    lastCameraRadius = camera.radius;
    camera.lockedTarget = cometMesh;
    camera.radius = Math.max(2, Math.min(camera.radius, 1e6));
    if (!Number.isFinite(camera.beta) || camera.beta <= 0) camera.beta = Math.PI / 3;
  } else {
    camera.lockedTarget = null;
    camera.setTarget(lastCameraTarget);
    camera.radius = lastCameraRadius;
  }
}

function setViewAxis(axis) {
  if (isCameraFocused || observerViewActive) return;
  const distance = camera.radius;
  switch (axis) {
    case 'X': camera.alpha = 0;          camera.beta = Math.PI / 2; break;
    case 'Y': camera.alpha = 0;          camera.beta = 0.0001;       break;
    case 'Z': camera.alpha = Math.PI / 2; camera.beta = Math.PI / 2; break;
  }
  camera.radius = distance;
  camera.setTarget(BABYLON.Vector3.Zero());
  lastCameraTarget = camera.target.clone();
}

function setObserverTargetMode(mode) {
  if (observerTargetSelect) observerTargetSelect.value = mode;
  if (observerViewActive) applyObserverViewFromUI({ keepState: true });
}

function applyPresetDefaultsToUI(presetId) {
  const preset = SPACE_TELESCOPE_PRESETS[presetId];
  if (!preset) return;
  if (observerFovInput && Number.isFinite(preset.fovDeg)) {
    observerFovInput.value = String(Number(preset.fovDeg.toFixed(4)));
  }
  if (observerTargetSelect && observerTargetSelect.value !== "radec") {
    observerTargetSelect.value = "comet";
  }
}

function getEarthPositionScene() {
  return earthMesh?.position?.clone?.() ?? getPlanetPosition(simulationTimeJD, earthEl);
}

function gmstDegAtJD(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  return wrapDeg(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000);
}

function getGroundObserverPositionScene(ground = {}) {
  const earthPos = getEarthPositionScene();
  const lonDeg = Number.isFinite(Number(ground.lonDeg)) ? Number(ground.lonDeg) : 0;
  const latDeg = Number.isFinite(Number(ground.latDeg)) ? Number(ground.latDeg) : 0;
  const altM = Number.isFinite(Number(ground.altM)) ? Number(ground.altM) : 0;
  const theta = (gmstDegAtJD(simulationTimeJD) + lonDeg) * DEG;
  const lat = latDeg * DEG;
  const radiusM = PLANET_RADII_KM.Earth * 1000 + altM;
  const cosLat = Math.cos(lat);
  const offsetEq = new BABYLON.Vector3(
    radiusM * cosLat * Math.cos(theta),
    radiusM * cosLat * Math.sin(theta),
    radiusM * Math.sin(lat)
  );
  return earthPos.add(earthCenteredEqToScene(offsetEq));
}

function earthCenteredEqToScene(offsetMetersEq) {
  const ecl = eqToEcl(offsetMetersEq);
  return ecl.scale(SCALE);
}

function getEarthOrbitPresetPosition(preset) {
  const earthPos = getEarthPositionScene();
  const altitudeM = (preset.altitudeKm || 0) * 1000;
  const radiusM = (PLANET_RADII_KM.Earth * 1000) + altitudeM;
  const periodDays = Math.max(1e-9, (preset.periodMin || 95) / (24 * 60));
  const phase = ((simulationTimeJD - baseJD) / periodDays) * 2 * Math.PI + (preset.phaseDeg || 0) * DEG;
  const inc = (preset.inclinationDeg || 0) * DEG;
  const raan = (preset.raanDeg || 0) * DEG;

  const xOrb = radiusM * Math.cos(phase);
  const yOrb = radiusM * Math.sin(phase);

  const cosO = Math.cos(raan), sinO = Math.sin(raan);
  const cosI = Math.cos(inc), sinI = Math.sin(inc);

  const xEq = cosO * xOrb - sinO * cosI * yOrb;
  const yEq = sinO * xOrb + cosO * cosI * yOrb;
  const zEq = sinI * yOrb;

  return earthPos.add(earthCenteredEqToScene(new BABYLON.Vector3(xEq, yEq, zEq)));
}

function getEarthLinePresetPosition(preset) {
  const earthPos = getEarthPositionScene();
  const earthDir = earthPos.lengthSquared() > 0 ? earthPos.normalize() : new BABYLON.Vector3(1, 0, 0);
  const sign = preset.point === "L1" ? -1 : 1;
  return earthPos.add(earthDir.scale(sign * (preset.distanceKm || 0) * 1000 * SCALE));
}

function getHeliocentricOffsetPresetPosition(preset) {
  const earthPos = getEarthPositionScene();
  const angle = (preset.longitudeOffsetDeg || 0) * DEG;
  const radialScale = preset.radialScale || 1;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  return new BABYLON.Vector3(
    radialScale * (earthPos.x * cosA - earthPos.y * sinA),
    radialScale * (earthPos.x * sinA + earthPos.y * cosA),
    earthPos.z
  );
}

function getPresetObserverPosition(presetId) {
  const preset = SPACE_TELESCOPE_PRESETS[presetId];
  if (!preset) return null;
  if (preset.type === "earthOrbit") return getEarthOrbitPresetPosition(preset);
  if (preset.type === "earthLine") return getEarthLinePresetPosition(preset);
  if (preset.type === "heliocentricOffset") return getHeliocentricOffsetPresetPosition(preset);
  return null;
}

function getObserverModeLabel(state = observerViewState) {
  const preset = SPACE_TELESCOPE_PRESETS[state?.presetId];
  if (preset) return `${preset.shortName} preset`;
  if (state?.mode === "earth") return "Earth/geocentric";
  if (state?.mode === "ground") return state?.groundObserver?.label || "Ground observatory/topocentric";
  return "Custom J2000";
}

function getObserverPresetNote(state = observerViewState) {
  const preset = SPACE_TELESCOPE_PRESETS[state?.presetId];
  return preset?.note || "";
}

function readObserverStateFromUI() {
  const fovDeg = Math.max(0.01, Math.min(120, parseFloat(observerFovInput?.value ?? "5") || 5));
  const rollDeg = Math.max(-180, Math.min(180, parseFloat(observerRollInput?.value ?? "0") || 0));
  const raDeg = wrapDeg(parseFloat(observerRaInput?.value ?? "0") || 0);
  const decDeg = Math.max(-90, Math.min(90, parseFloat(observerDecInput?.value ?? "0") || 0));

  let customPosition = null;
  const v = parseVec3FromText(observerXYZInput?.value ?? "");
  if (v) {
    customPosition = j2000ToSceneUnits(v.x, v.y, v.z, observerUnitSelect?.value ?? "AU", AU, SCALE);
  }

  const groundObserver = {
    label: observerGroundLabelInput?.value?.trim?.() || "Ground observatory",
    lonDeg: parseFloat(observerGroundLonInput?.value ?? "0") || 0,
    latDeg: parseFloat(observerGroundLatInput?.value ?? "0") || 0,
    altM: parseFloat(observerGroundAltInput?.value ?? "0") || 0
  };

  return {
    presetId: observerPresetSelect?.value ?? "manual",
    mode: observerModeSelect?.value ?? "earth",
    groundObserver,
    targetMode: observerTargetSelect?.value ?? "comet",
    fovDeg,
    rollDeg,
    raDeg,
    decDeg,
    customPosition
  };
}

function applyObserverViewFromUI() {
  const next = readObserverStateFromUI();
  if (next.presetId === "manual" && next.mode === "j2000" && !next.customPosition) {
    console.warn("Invalid observer coordinates. Use: x, y, z");
    if (observerInfo) observerInfo.textContent = "Invalid observer coordinates. Use: x, y, z";
    return;
  }

  if (!observerViewActive) {
    if (isCamPosLocked) unlockCameraPosition();
    savedArcRotateState = saveArcRotateState();
    createLockedCameraAtPosition(getObserverPosition(next), getObserverTarget(next));
    observerViewActive = true;
    isCamPosLocked = true;
    lockMode = "observer";
  }

  observerViewState = next;
  updateObserverCamera();
  if (lockEarthBtn) lockEarthBtn.textContent = "Lock to Earth";
  updateFocusButtonLabel();
  observerReticle?.classList.add("active");
  observerStatus?.classList.add("active");
}

function getObserverPosition(state = observerViewState) {
  const presetPos = getPresetObserverPosition(state?.presetId);
  if (presetPos) return presetPos;
  if (state?.mode === "earth") return getEarthPositionScene();
  if (state?.mode === "ground") return getGroundObserverPositionScene(state?.groundObserver);
  return state?.customPosition?.clone?.() ?? BABYLON.Vector3.Zero();
}

function getObserverTarget(state = observerViewState) {
  const observerPos = getObserverPosition(state);
  if (state?.targetMode === "radec") {
    const dir = raDecDegToEclipticDirection(state.raDeg, state.decDeg);
    return observerPos.add(dir.scale(AU * SCALE));
  }
  return cometMesh?.position?.clone?.() ?? BABYLON.Vector3.Zero();
}

function updateObserverCamera() {
  if (!observerViewActive || !lockedCam || !observerViewState) return;

  const pos = getObserverPosition(observerViewState);
  const target = getObserverTarget(observerViewState);
  lockedCam.position.copyFrom(pos);
  lockedCam.fov = observerViewState.fovDeg * DEG;
  lockedCam.fovMode = BABYLON.Camera.FOVMODE_VERTICAL_FIXED;
  lockedCam.minZ = 0.000001;
  lockedCam.maxZ = 1e10;
  lockedCam.setTarget(target);
  lockedCam.rotation.z = observerViewState.rollDeg * DEG;

  updateObserverMetadata(pos, target);
}

function updateObserverMetadata(observerPos, target) {
  if (!observerViewActive || !observerViewState || !cometMesh) return;

  const cometRaDec = heliocentricSceneToRaDec(cometMesh.position, observerPos);
  const targetRaDec = observerViewState.targetMode === "radec"
    ? { raDeg: observerViewState.raDeg, decDeg: observerViewState.decDeg }
    : cometRaDec;

  const distanceAU = BABYLON.Vector3.Distance(observerPos, cometMesh.position) / (AU * SCALE);
  const date = jdToDateString(simulationTimeJD);
  const fovH = observerViewState.fovDeg * (engine.getRenderWidth(true) / Math.max(1, engine.getRenderHeight(true)));
  const modeLabel = getObserverModeLabel(observerViewState);
  const targetLabel = observerViewState.targetMode === "comet" ? "Comet nucleus" : "Manual RA/Dec";
  const presetNote = getObserverPresetNote(observerViewState);

  lastObserverMetadata = [
    `Date UTC: ${date} (JD ${simulationTimeJD.toFixed(5)})`,
    `Observer: ${modeLabel}`,
    `Target: ${targetLabel}`,
    `Comet apparent RA/Dec: ${cometRaDec.raDeg.toFixed(5)}°, ${cometRaDec.decDeg.toFixed(5)}°  (${formatRaHours(cometRaDec.raDeg)}, ${formatDecDeg(cometRaDec.decDeg)})`,
    `Camera target RA/Dec: ${targetRaDec.raDeg.toFixed(5)}°, ${targetRaDec.decDeg.toFixed(5)}°`,
    `Distance to comet: ${distanceAU.toFixed(6)} AU`,
    `FOV: ${observerViewState.fovDeg.toFixed(3)}° vertical × ${fovH.toFixed(3)}° horizontal`,
    `Roll: ${observerViewState.rollDeg.toFixed(2)}°`,
    presetNote ? `Preset note: ${presetNote}` : null,
    `Scene scale: ${SCALE} scene units per meter`
  ].filter(Boolean).join("\n");

  if (observerInfo) observerInfo.textContent = lastObserverMetadata;
  if (observerStatus) {
    observerStatus.textContent = `Telescope view · ${modeLabel} · ${date} · FOV ${observerViewState.fovDeg.toFixed(2)}° · RA ${formatRaHours(cometRaDec.raDeg)} Dec ${formatDecDeg(cometRaDec.decDeg)}`;
  }
}

function exitObserverView() {
  if (!observerViewActive) return;
  disposeLockedCamera();
  if (savedArcRotateState) {
    camera.alpha  = savedArcRotateState.alpha;
    camera.beta   = savedArcRotateState.beta;
    camera.radius = savedArcRotateState.radius;
    camera.setTarget(savedArcRotateState.target);
    camera.lockedTarget = savedArcRotateState.lockedTarget ?? null;
  }
  scene.activeCamera = camera;
  observerViewActive = false;
  observerViewState = null;
  isCamPosLocked = false;
  lockMode = "none";
  autoTrackCometWhileLocked = false;
  observerReticle?.classList.remove("active");
  observerStatus?.classList.remove("active");
  if (observerInfo) observerInfo.textContent = "Telescope view is not active.";
  if (lockEarthBtn) lockEarthBtn.textContent = "Lock to Earth";
  updateFocusButtonLabel();
}

async function copyObserverMetadata() {
  if (!lastObserverMetadata) updateObserverCamera();
  const text = lastObserverMetadata || "No observer metadata available.";
  try {
    await navigator.clipboard.writeText(text);
    if (observerInfo) observerInfo.textContent = text + "\n\nCopied to clipboard.";
  } catch (err) {
    console.warn("Clipboard write failed", err);
    if (observerInfo) observerInfo.textContent = text + "\n\nClipboard write failed; select and copy manually.";
  }
}

function sleepFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function isCanvasMostlyBlank(canvasToCheck) {
  try {
    const probe = document.createElement("canvas");
    const w = probe.width = Math.min(64, Math.max(1, canvasToCheck.width));
    const h = probe.height = Math.min(64, Math.max(1, canvasToCheck.height));
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    pctx.drawImage(canvasToCheck, 0, 0, w, h);
    const data = pctx.getImageData(0, 0, w, h).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 4 || data[i + 1] > 4 || data[i + 2] > 4) nonBlack++;
      if (nonBlack > 8) return false;
    }
    return true;
  } catch (err) {
    // If the browser blocks probing, do not treat it as blank.
    return false;
  }
}

function drawScreenshotOverlays(ctx, width, height) {
  const overlay = document.getElementById("particleOverlay");
  if (overlay) {
    try { ctx.drawImage(overlay, 0, 0, width, height); }
    catch (err) { console.warn("Could not include particle overlay in screenshot", err); }
  }

  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = Math.max(1, Math.round(width / 1200));
  const cx = width / 2, cy = height / 2;
  const len = Math.max(24, height * 0.035);
  ctx.beginPath();
  ctx.moveTo(cx - len, cy); ctx.lineTo(cx + len, cy);
  ctx.moveTo(cx, cy - len); ctx.lineTo(cx, cy + len);
  ctx.stroke();
}

function downloadCanvas(canvasToDownload) {
  const a = document.createElement("a");
  a.href = canvasToDownload.toDataURL("image/png");
  a.download = `comet_telescope_view_${jdToDateString(simulationTimeJD)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function makeScreenshotCanvasFromSource(source) {
  const tmp = document.createElement("canvas");
  tmp.width = Math.max(1, source.width || engine.getRenderWidth(true));
  tmp.height = Math.max(1, source.height || engine.getRenderHeight(true));
  const ctx = tmp.getContext("2d");
  ctx.drawImage(source, 0, 0, tmp.width, tmp.height);
  drawScreenshotOverlays(ctx, tmp.width, tmp.height);
  return tmp;
}


function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJSON(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }));
}

function safeParseNumber(input, fallback, min = -Infinity, max = Infinity) {
  const v = parseFloat(input?.value ?? String(fallback));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function readBetaSizeExportSettings() {
  const densityKgM3 = safeParseNumber(betaSizeDensityInput, 1000, 1, 10000);
  const qpr = safeParseNumber(betaSizeQprInput, 1, 0.0001, 10);
  const visibleAngularMagnifier = safeParseNumber(betaSizeMagnifierInput, 1e13, 1, 1e20);
  const minRenderedRadiusPx = safeParseNumber(betaSizeMinPxInput, 0.2, 0, 1000);
  const maxRenderedRadiusPx = safeParseNumber(betaSizeMaxPxInput, 35, 0.01, 10000);
  const betaFloor = 1e-6;
  return { densityKgM3, qpr, visibleAngularMagnifier, minRenderedRadiusPx, maxRenderedRadiusPx, betaFloor };
}

function radiusMetersFromBeta(beta, settings) {
  const betaSafe = Math.max(settings.betaFloor, Math.abs(beta || 0));
  const densityGcm3 = settings.densityKgM3 / 1000;
  const radiusUm = (0.57 * settings.qpr) / Math.max(1e-12, densityGcm3 * betaSafe);
  return radiusUm * 1e-6;
}

function drawReticleOnly(ctx, width, height) {
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = Math.max(1, Math.round(width / 1200));
  const cx = width / 2, cy = height / 2;
  const len = Math.max(24, height * 0.035);
  ctx.beginPath();
  ctx.moveTo(cx - len, cy); ctx.lineTo(cx + len, cy);
  ctx.moveTo(cx, cy - len); ctx.lineTo(cx, cy + len);
  ctx.stroke();
}

function makeBaseSceneScreenshotCanvas(source) {
  const tmp = document.createElement("canvas");
  tmp.width = Math.max(1, source.width || engine.getRenderWidth(true));
  tmp.height = Math.max(1, source.height || engine.getRenderHeight(true));
  const ctx = tmp.getContext("2d");
  ctx.drawImage(source, 0, 0, tmp.width, tmp.height);
  return tmp;
}

function setGuiControlVisibilityTemporarily(control, visible, restoreList) {
  if (!control || typeof control.isVisible === "undefined") return;
  restoreList.push({ control, isVisible: control.isVisible });
  control.isVisible = visible;
}

async function makeFreshSceneCanvasWithoutParticleOverlay() {
  // The β-size export redraws particles itself. The base image should therefore
  // not contain the normal particle layer OR the bright comet nucleus/glow.
  // Otherwise the exported PNG gets an artificial halo around the nucleus before
  // the β-derived particle discs are even drawn.
  const temporarilyHiddenMeshes = [];
  const temporarilyHiddenGui = [];
  const glowState = sunGlow ? { intensity: sunGlow.intensity } : null;

  function hideMeshForExport(mesh) {
    if (mesh?.isEnabled?.()) {
      temporarilyHiddenMeshes.push(mesh);
      mesh.setEnabled(false);
    }
  }

  try {
    if (Array.isArray(particleMeshes)) {
      for (const mesh of particleMeshes) hideMeshForExport(mesh);
    }

    // Hide the rendered comet nucleus and its GUI label only for the export base.
    // The particle positions are still calculated relative to cometMesh.position.
    hideMeshForExport(cometMesh);
    setGuiControlVisibilityTemporarily(cometMesh?._cometLabel, false, temporarilyHiddenGui);
    setGuiControlVisibilityTemporarily(customCometLabel, false, temporarilyHiddenGui);

    // Babylon GlowLayer can brighten emissive scene objects. Disable it during
    // the base capture so it cannot create a nucleus-looking bloom artifact.
    if (sunGlow) sunGlow.intensity = 0;

    scene.render();
    await sleepFrame();
    let tmp = makeBaseSceneScreenshotCanvas(canvas);

    if (isCanvasMostlyBlank(tmp) && BABYLON.Tools?.CreateScreenshotUsingRenderTargetAsync && scene.activeCamera) {
      const size = { width: engine.getRenderWidth(true), height: engine.getRenderHeight(true) };
      const dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(engine, scene.activeCamera, size);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      tmp = document.createElement("canvas");
      tmp.width = size.width;
      tmp.height = size.height;
      tmp.getContext("2d").drawImage(img, 0, 0, tmp.width, tmp.height);
    }

    return tmp;
  } finally {
    for (const mesh of temporarilyHiddenMeshes) mesh.setEnabled(true);
    for (const item of temporarilyHiddenGui) item.control.isVisible = item.isVisible;
    if (sunGlow && glowState) sunGlow.intensity = glowState.intensity;
  }
}

function projectScenePointToPixel(pos, width, height) {
  const activeCam = scene.activeCamera;
  const viewport = activeCam.viewport.toGlobal(width, height);

  // IMPORTANT: the FITS image can be square while the browser canvas is 16:9.
  // scene.getTransformMatrix() uses the browser aspect ratio, which stretches a
  // square FITS export and produces an incorrect tail shape. Build a projection
  // matrix for the requested export dimensions instead.
  const aspect = Math.max(1e-12, width / Math.max(1, height));
  const near = Math.max(1e-9, activeCam.minZ || 1e-6);
  const far = Math.max(near * 10, activeCam.maxZ || 1e10);
  const projection = BABYLON.Matrix?.PerspectiveFovLH
    ? BABYLON.Matrix.PerspectiveFovLH(activeCam.fov, aspect, near, far, true)
    : activeCam.getProjectionMatrix(true);
  const transform = activeCam.getViewMatrix(true).multiply(projection);

  return BABYLON.Vector3.Project(
    pos,
    BABYLON.Matrix.Identity(),
    transform,
    viewport
  );
}

async function collectLiveParticleRecordsForExport(settings, exportSize = null) {
  const records = [];
  const activeCam = scene.activeCamera;
  if (!activeCam) return records;
  const exportWidth = Math.max(1, Math.round(exportSize?.width || engine.getRenderWidth(true)));
  const exportHeight = Math.max(1, Math.round(exportSize?.height || engine.getRenderHeight(true)));

  let gpuPositions = null;
  if (rawParticles?.readback) {
    gpuPositions = await rawParticles.readback();
  }

  const limit = Math.max(0, maxUsed || 0);
  for (let i = 0; i < limit; i++) {
    if (!expiryByIndex || expiryByIndex[i] <= simSeconds) continue;

    let pos = null;
    let lifeLeftSeconds = Math.max(0, expiryByIndex[i] - simSeconds);
    const beta = Number(betaByIndex?.[i] ?? cpuSlots?.[i]?.beta ?? 0);

    if (gpuPositions) {
      const o = i * 4;
      const lifeFromGpu = gpuPositions[o + 3];
      if (!(lifeFromGpu > 0)) continue;
      pos = new BABYLON.Vector3(gpuPositions[o], gpuPositions[o + 1], gpuPositions[o + 2]);
      lifeLeftSeconds = lifeFromGpu;
    } else if (particleMeshes?.[i]?.isEnabled?.()) {
      pos = particleMeshes[i].position.clone();
    } else if (cpuSlots?.[i]) {
      const slot = cpuSlots[i];
      const dt = (simulationTimeJD - slot.t0JD) * SECONDS_PER_DAY;
      if (dt <= 0) pos = slot.r0_m.scale(SCALE);
      else if (slot.mu <= 0) pos = slot.r0_m.add(slot.v0_mps.scale(dt)).scale(SCALE);
      else pos = keplerUniversalPropagate(slot.r0_m, slot.v0_mps, dt, slot.mu).r.scale(SCALE);
    }

    if (!pos) continue;

    const radiusM = radiusMetersFromBeta(beta, settings);
    const distanceM = Math.max(1e-9, BABYLON.Vector3.Distance(activeCam.position, pos) / SCALE);
    const angularRadiusRad = Math.atan(radiusM / distanceM);
    const trueRadiusPx = angularRadiusRad / Math.max(1e-12, activeCam.fov || (observerViewState?.fovDeg || 5) * DEG) * exportHeight;
    const renderedRadiusPx = Math.max(
      settings.minRenderedRadiusPx,
      Math.min(settings.maxRenderedRadiusPx, trueRadiusPx * settings.visibleAngularMagnifier)
    );

    const projected = projectScenePointToPixel(pos, exportWidth, exportHeight);
    const insideFrame = projected.z >= 0 && projected.z <= 1 &&
      projected.x >= -renderedRadiusPx && projected.x <= exportWidth + renderedRadiusPx &&
      projected.y >= -renderedRadiusPx && projected.y <= exportHeight + renderedRadiusPx;

    const ageDays = birthJDByIndex?.[i] ? simulationTimeJD - birthJDByIndex[i] : null;
    const cometDistanceKm = cometMesh ? BABYLON.Vector3.Distance(pos, cometMesh.position) / SCALE / 1000 : null;
    const crossSectionM2 = Math.PI * radiusM * radiusM;
    const massKg = (4 / 3) * Math.PI * radiusM * radiusM * radiusM * settings.densityKgM3;

    records.push({
      index: i,
      beta,
      radiusM,
      radiusUm: radiusM * 1e6,
      diameterUm: radiusM * 2e6,
      densityKgM3: settings.densityKgM3,
      qpr: settings.qpr,
      massKg,
      crossSectionM2,
      distanceFromObserverM: distanceM,
      distanceFromObserverAU: distanceM / AU,
      angularRadiusRad,
      trueRadiusPx,
      renderedRadiusPx,
      screenX: projected.x,
      screenY: projected.y,
      screenZ: projected.z,
      insideFrame,
      positionSceneX: pos.x,
      positionSceneY: pos.y,
      positionSceneZ: pos.z,
      positionAUX: pos.x / (AU * SCALE),
      positionAUY: pos.y / (AU * SCALE),
      positionAUZ: pos.z / (AU * SCALE),
      distanceFromCometKm: cometDistanceKm,
      birthJD: birthJDByIndex?.[i] || null,
      ageDays,
      remainingLifetimeDays: lifeLeftSeconds / SECONDS_PER_DAY
    });
  }
  return records;
}

function drawBetaSizedParticles(ctx, records) {
  ctx.save();

  // Draw crisp β-sized discs, not soft additive radial gradients. The previous
  // gradient + "lighter" blend mode made dense near-nucleus particles look
  // like a fake glowing coma/halo. This keeps the particles visible while making
  // the exported image easier to interpret geometrically.
  ctx.globalCompositeOperation = "source-over";

  const visible = records.filter(r => r.insideFrame).sort((a, b) => b.renderedRadiusPx - a.renderedRadiusPx);
  for (const r of visible) {
    const radius = Math.max(0.001, r.renderedRadiusPx);
    const alpha = Math.max(0.18, Math.min(0.82, 0.34 + Math.log10(Math.max(1.001, radius)) * 0.16));

    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath();
    ctx.arc(r.screenX, r.screenY, radius, 0, Math.PI * 2);
    ctx.fill();

    if (radius >= 2) {
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  ctx.restore();
}

function buildBetaSizedParticleCsv(records) {
  const header = [
    "particle_index", "beta_simulation_input", "radius_um_from_beta", "diameter_um_from_beta",
    "radius_m_from_beta", "density_kg_m3", "qpr", "mass_kg", "cross_section_m2",
    "distance_from_observer_au", "angular_radius_rad", "true_radius_px_unmagnified",
    "rendered_radius_px", "screen_x_px", "screen_y_px", "screen_z", "inside_exported_frame",
    "position_au_x", "position_au_y", "position_au_z", "distance_from_comet_km",
    "birth_jd", "age_days", "remaining_lifetime_days"
  ];
  const rows = [header];
  for (const r of records) {
    rows.push([
      r.index, r.beta, r.radiusUm, r.diameterUm, r.radiusM, r.densityKgM3, r.qpr,
      r.massKg, r.crossSectionM2, r.distanceFromObserverAU, r.angularRadiusRad,
      r.trueRadiusPx, r.renderedRadiusPx, r.screenX, r.screenY, r.screenZ,
      r.insideFrame ? 1 : 0, r.positionAUX, r.positionAUY, r.positionAUZ,
      r.distanceFromCometKm, r.birthJD, r.ageDays, r.remainingLifetimeDays
    ]);
  }
  return rows;
}

function summarizeBetaSizedParticles(records) {
  const visible = records.filter(r => r.insideFrame);
  const radii = visible.map(r => r.radiusUm).sort((a, b) => a - b);
  const rendered = visible.map(r => r.renderedRadiusPx).sort((a, b) => a - b);
  const pct = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * q)))] : null;
  const sum = (arr, f) => arr.reduce((acc, x) => acc + f(x), 0);
  return {
    liveParticles: records.length,
    particlesInsideExportedFrame: visible.length,
    radiusUm: { min: pct(radii, 0), p50: pct(radii, 0.5), p90: pct(radii, 0.9), max: pct(radii, 1) },
    renderedRadiusPx: { min: pct(rendered, 0), p50: pct(rendered, 0.5), p90: pct(rendered, 0.9), max: pct(rendered, 1) },
    totalCrossSectionM2InsideFrame: sum(visible, r => r.crossSectionM2),
    totalMassKgInsideFrame: sum(visible, r => r.massKg)
  };
}

async function exportBetaSizedTelescopeImage() {
  if (!scene || !engine || !canvas) return;
  if (!observerViewActive) {
    if (observerInfo) observerInfo.textContent = `${lastObserverMetadata || ""}\n\nActivate telescope view first, then export the β-size telescope image.`.trim();
    return;
  }

  const btn = exportBetaSizedTelescopeImageBtn;
  if (btn) btn.textContent = "Exporting…";

  try {
    updateObserverCamera();
    const settings = readBetaSizeExportSettings();
    const baseCanvas = await makeFreshSceneCanvasWithoutParticleOverlay();
    const ctx = baseCanvas.getContext("2d");
    const records = await collectLiveParticleRecordsForExport(settings);

    drawBetaSizedParticles(ctx, records);
    drawReticleOnly(ctx, baseCanvas.width, baseCanvas.height);

    const date = jdToDateString(simulationTimeJD);
    const baseName = `beta_size_telescope_${date}_JD${simulationTimeJD.toFixed(5)}`.replace(/[^a-zA-Z0-9_.-]+/g, "_");

    downloadCanvasWithName(baseCanvas, `${baseName}.png`);
    downloadCSV(`${baseName}_particles.csv`, buildBetaSizedParticleCsv(records));

    const summary = summarizeBetaSizedParticles(records);

    if (observerInfo) observerInfo.textContent = `${lastObserverMetadata || ""}\n\nExported β-size telescope image with ${records.length} live particles. ${summary.particlesInsideExportedFrame} particles are inside the exported frame.`;
  } catch (err) {
    console.error("β-size telescope export failed", err);
    if (observerInfo) observerInfo.textContent = `${lastObserverMetadata || ""}\n\nβ-size telescope export failed: ${err.message || err}`;
  } finally {
    if (btn) btn.textContent = "Export β-size telescope image";
  }
}

function downloadCanvasWithName(canvasToDownload, filename) {
  const a = document.createElement("a");
  a.href = canvasToDownload.toDataURL("image/png");
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function saveObserverScreenshot() {
  const source = canvas;
  if (!source || !engine || !scene) return;

  if (saveObserverScreenshotBtn) saveObserverScreenshotBtn.textContent = "Saving…";

  try {
    // Render a fresh frame and wait for the browser to present it before reading the canvas.
    scene.render();
    await sleepFrame();

    let tmp = makeScreenshotCanvasFromSource(source);

    // Some browser/GPU combinations produce a valid PNG that contains only a cleared buffer.
    // In that case, use Babylon's render-target screenshot path as a fallback.
    if (isCanvasMostlyBlank(tmp) && BABYLON.Tools?.CreateScreenshotUsingRenderTargetAsync && scene.activeCamera) {
      const size = { width: engine.getRenderWidth(true), height: engine.getRenderHeight(true) };
      const dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(engine, scene.activeCamera, size);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      tmp = document.createElement("canvas");
      tmp.width = size.width;
      tmp.height = size.height;
      const ctx = tmp.getContext("2d");
      ctx.drawImage(img, 0, 0, tmp.width, tmp.height);
      drawScreenshotOverlays(ctx, tmp.width, tmp.height);
    }

    downloadCanvas(tmp);
  } catch (err) {
    console.error("Screenshot failed", err);
    if (observerInfo) observerInfo.textContent = `${lastObserverMetadata || ""}\n\nScreenshot failed: ${err.message || err}`;
  } finally {
    if (saveObserverScreenshotBtn) saveObserverScreenshotBtn.textContent = "Save screenshot";
  }
}
