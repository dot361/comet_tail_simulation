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

const camXYZInput   = document.getElementById("camXYZInput");
const camUnitSelect = document.getElementById("camUnitSelect");
const lockCamPosBtn = document.getElementById("lockCamPosBtn");
const lockEarthBtn  = document.getElementById("lockEarthBtn");
const toggleFocusBtn = document.getElementById("toggleFocusBtn");

const observerModeSelect       = document.getElementById("observerModeSelect");
const observerXYZInput         = document.getElementById("observerXYZInput");
const observerUnitSelect       = document.getElementById("observerUnitSelect");
const observerTargetSelect     = document.getElementById("observerTargetSelect");
const observerRaInput          = document.getElementById("observerRaInput");
const observerDecInput         = document.getElementById("observerDecInput");
const observerFovInput         = document.getElementById("observerFovInput");
const observerRollInput        = document.getElementById("observerRollInput");
const applyObserverViewBtn     = document.getElementById("applyObserverViewBtn");
const exitObserverViewBtn      = document.getElementById("exitObserverViewBtn");
const copyObserverMetadataBtn  = document.getElementById("copyObserverMetadataBtn");
const saveObserverScreenshotBtn = document.getElementById("saveObserverScreenshotBtn");
const observerInfo             = document.getElementById("observerInfo");
const observerReticle          = document.getElementById("observerReticle");
const observerStatus           = document.getElementById("observerStatus");

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

  lockCamPosBtn.onclick = () => {
    if (isCamPosLocked && lockMode === "j2000") {
      unlockCameraPosition();
    } else {
      lockCameraPositionToJ2000();
    }
  };

  lockEarthBtn.onclick = () => {
    if (isCamPosLocked && lockMode === "earth") {
      unlockCameraPosition();
    } else {
      lockCameraToEarth();
    }
  };

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

  for (const el of [
    observerModeSelect, observerXYZInput, observerUnitSelect, observerTargetSelect,
    observerRaInput, observerDecInput, observerFovInput, observerRollInput
  ]) {
    el?.addEventListener("input", () => {
      if (observerViewActive) applyObserverViewFromUI({ keepState: true });
    });
    el?.addEventListener("change", () => {
      if (observerViewActive) applyObserverViewFromUI({ keepState: true });
    });
  }

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

function lockCameraPositionToJ2000() {
  const v = parseVec3FromText(camXYZInput?.value ?? "");
  const unit = camUnitSelect.value;
  if (!v) { console.warn("Invalid camera coordinates. Use: x, y, z"); return; }

  if (observerViewActive) exitObserverView();

  const posScene = j2000ToSceneUnits(v.x, v.y, v.z, unit, AU, SCALE);
  savedArcRotateState = saveArcRotateState();

  const lookTarget = camera.lockedTarget?.position ?? camera.target;
  createLockedCameraAtPosition(posScene, lookTarget);

  isCamPosLocked = true;
  lockMode = "j2000";
  autoTrackCometWhileLocked = false;
  lockCamPosBtn.textContent = "Unlock camera position";
  lockEarthBtn.textContent  = "Lock to Earth";
  updateFocusButtonLabel();
}

function lockCameraToEarth() {
  if (!earthMesh) { console.warn("Earth mesh not available"); return; }
  if (observerViewActive) exitObserverView();

  savedArcRotateState = saveArcRotateState();
  const lookTarget = camera.lockedTarget?.position ?? camera.target;
  createLockedCameraAtPosition(earthMesh.position, lookTarget);

  isCamPosLocked = true;
  lockMode = "earth";
  autoTrackCometWhileLocked = false;
  lockCamPosBtn.textContent = "Lock camera position";
  lockEarthBtn.textContent  = "Unlock Earth lock";
  updateFocusButtonLabel();
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
  lockCamPosBtn.textContent = "Lock camera position";
  lockEarthBtn.textContent  = "Lock to Earth";
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
    case 'X': camera.alpha = 0; camera.beta = Math.PI / 2; break;
    case 'Y': camera.alpha = 0; camera.beta = 0.0001;       break;
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

  return {
    mode: observerModeSelect?.value ?? "earth",
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
  if (next.mode === "j2000" && !next.customPosition) {
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
  lockCamPosBtn.textContent = "Lock camera position";
  lockEarthBtn.textContent  = "Lock to Earth";
  updateFocusButtonLabel();
  observerReticle?.classList.add("active");
  observerStatus?.classList.add("active");
}

function getObserverPosition(state = observerViewState) {
  if (state?.mode === "earth") return earthMesh?.position?.clone?.() ?? BABYLON.Vector3.Zero();
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
  lockedCam.rotation.z += observerViewState.rollDeg * DEG;

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
  const modeLabel = observerViewState.mode === "earth" ? "Earth/geocentric" : "Custom J2000";
  const targetLabel = observerViewState.targetMode === "comet" ? "Comet nucleus" : "Manual RA/Dec";

  lastObserverMetadata = [
    `Date UTC: ${date} (JD ${simulationTimeJD.toFixed(5)})`,
    `Observer: ${modeLabel}`,
    `Target: ${targetLabel}`,
    `Comet apparent RA/Dec: ${cometRaDec.raDeg.toFixed(5)}°, ${cometRaDec.decDeg.toFixed(5)}°  (${formatRaHours(cometRaDec.raDeg)}, ${formatDecDeg(cometRaDec.decDeg)})`,
    `Camera target RA/Dec: ${targetRaDec.raDeg.toFixed(5)}°, ${targetRaDec.decDeg.toFixed(5)}°`,
    `Distance to comet: ${distanceAU.toFixed(6)} AU`,
    `FOV: ${observerViewState.fovDeg.toFixed(3)}° vertical × ${fovH.toFixed(3)}° horizontal`,
    `Roll: ${observerViewState.rollDeg.toFixed(2)}°`,
    `Scene scale: ${SCALE} scene units per meter`
  ].join("\n");

  if (observerInfo) observerInfo.textContent = lastObserverMetadata;
  if (observerStatus) {
    observerStatus.textContent = `Telescope view · ${modeLabel} · ${date} · FOV ${observerViewState.fovDeg.toFixed(2)}° · RA ${formatRaHours(cometRaDec.raDeg)} Dec ${formatDecDeg(cometRaDec.decDeg)}`;
  }
}

function exitObserverView() {
  if (!observerViewActive) return;
  disposeLockedCamera();
  if (savedArcRotateState) {
    camera.alpha = savedArcRotateState.alpha;
    camera.beta = savedArcRotateState.beta;
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
  lockCamPosBtn.textContent = "Lock camera position";
  lockEarthBtn.textContent = "Lock to Earth";
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

async function saveObserverScreenshot() {
  const source = canvas;
  if (!source || !engine || !scene) return;

  if (saveObserverScreenshotBtn) saveObserverScreenshotBtn.textContent = "Saving…";

  try {
    scene.render();
    await sleepFrame();

    let tmp = makeScreenshotCanvasFromSource(source);

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
