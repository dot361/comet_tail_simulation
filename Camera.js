// ─── Camera setup ─────────────────────────────────────────────────────────────
// Globals: camera, lockedCam, isCamPosLocked, isCameraFocused,
//          autoTrackCometWhileLocked, lockMode, savedArcRotateState,
//          lastCameraTarget, lastCameraRadius
// Functions: initCamera, setFocusOnComet, setViewAxis,
//            lockCameraPositionToJ2000, lockCameraToEarth, unlockCameraPosition
// Call: initCamera()

let camera, lockedCam;
let isCamPosLocked           = false;
let isCameraFocused          = false;
let autoTrackCometWhileLocked = false;
let lockMode                 = "none";
let savedArcRotateState      = null;
let lastCameraTarget, lastCameraRadius;

const camXYZInput   = document.getElementById("camXYZInput");
const camUnitSelect = document.getElementById("camUnitSelect");
const lockCamPosBtn = document.getElementById("lockCamPosBtn");
const lockEarthBtn  = document.getElementById("lockEarthBtn");
const toggleFocusBtn = document.getElementById("toggleFocusBtn");

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
    if (isCamPosLocked) {
      setFocusOnComet(!autoTrackCometWhileLocked);
    } else {
      setFocusOnComet(!isCameraFocused);
    }
  };

  scene.onBeforeRenderObservable.add(() => {
    if (isCamPosLocked && lockMode === "earth" && lockedCam && earthMesh) {
      lockedCam.position.copyFrom(earthMesh.position);
    }
    if (isCamPosLocked && lockedCam && cometMesh && autoTrackCometWhileLocked) {
      lockedCam.setTarget(cometMesh.position);
    }
  });
}

function updateFocusButtonLabel() {
  if (isCamPosLocked) {
    toggleFocusBtn.textContent = autoTrackCometWhileLocked ? "Stop Tracking" : "Track Comet";
  } else {
    toggleFocusBtn.textContent = isCameraFocused ? "Unfocus Camera" : "Focus on Comet";
  }
}

function createLockedCameraAtPosition(position, lookTarget) {
  lockedCam = new BABYLON.UniversalCamera("lockedCam", position.clone(), scene);
  if (lookTarget) lockedCam.setTarget(lookTarget);
  lockedCam.attachControl(canvas, true);
  lockedCam.inputs.removeByType("FreeCameraKeyboardMoveInput");
  lockedCam.inputs.removeByType("FreeCameraMouseWheelInput");
  lockedCam.speed = 0;
  scene.activeCamera = lockedCam;
}

function lockCameraPositionToJ2000() {
  const v = parseVec3FromText(camXYZInput?.value ?? "");
  const unit = camUnitSelect.value;
  if (!v) { console.warn("Invalid camera coordinates. Use: x, y, z"); return; }

  const posScene = j2000ToSceneUnits(v.x, v.y, v.z, unit, AU, SCALE);
  savedArcRotateState = {
    alpha: camera.alpha, beta: camera.beta,
    radius: camera.radius, target: camera.target.clone(),
    lockedTarget: camera.lockedTarget
  };

  lockedCam = new BABYLON.UniversalCamera("lockedCam", posScene.clone(), scene);
  const lookTarget = camera.lockedTarget?.position ?? camera.target;
  lockedCam.setTarget(lookTarget);
  lockedCam.attachControl(canvas, true);
  lockedCam.inputs.removeByType("FreeCameraKeyboardMoveInput");
  lockedCam.inputs.removeByType("FreeCameraMouseWheelInput");
  lockedCam.speed = 0;
  scene.activeCamera = lockedCam;

  isCamPosLocked = true;
  lockMode = "j2000";
  autoTrackCometWhileLocked = false;
  lockCamPosBtn.textContent = "Unlock camera position";
  lockEarthBtn.textContent  = "Lock to Earth";
  updateFocusButtonLabel();
}

function lockCameraToEarth() {
  if (!earthMesh) { console.warn("Earth mesh not available"); return; }
  savedArcRotateState = {
    alpha: camera.alpha, beta: camera.beta,
    radius: camera.radius, target: camera.target.clone(),
    lockedTarget: camera.lockedTarget
  };
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
  if (lockedCam) {
    lockedCam.detachControl(canvas);
    lockedCam.dispose();
    lockedCam = null;
  }
  camera.alpha  = savedArcRotateState.alpha;
  camera.beta   = savedArcRotateState.beta;
  camera.radius = savedArcRotateState.radius;
  camera.setTarget(savedArcRotateState.target);
  camera.lockedTarget = savedArcRotateState.lockedTarget ?? null;
  scene.activeCamera = camera;

  isCamPosLocked = false;
  lockMode = "none";
  autoTrackCometWhileLocked = false;
  lockCamPosBtn.textContent = "Lock camera position";
  lockEarthBtn.textContent  = "Lock to Earth";
  updateFocusButtonLabel();
}

function setFocusOnComet(on) {
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
  if (isCameraFocused) return;
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
