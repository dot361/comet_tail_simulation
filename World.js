// ─── World setup (AU grid, GUI layer, Sun, starfield) ─────────────────────────
// Globals: auGridMinor, auGridMajor, isAUGridVisible, ui
// Functions: initWorld, addLabel, setAUGridVisible
// Call: initWorld()

let auGridMinor    = null;
let auGridMajor    = null;
let isAUGridVisible = true;
let ui;

let gridObserver = null;

function disposeAUGrid() {
  if (gridObserver) { scene.onBeforeRenderObservable.remove(gridObserver); gridObserver = null; }
  if (auGridMinor) { auGridMinor.dispose(); auGridMinor = null; }
  if (auGridMajor) { auGridMajor.dispose(); auGridMajor = null; }
}

function createAUGridInfinite(gridCamera, {
  plane = "XY",
  offset = 0,
  minorAlpha = 0.012,
  majorAlpha = 0.025,
  renderingGroupId = 0,
  minHalfSizeAU = 12,
  maxHalfSizeAU = 80,
  majorEvery = 5
} = {}) {
  disposeAUGrid();

  const AU_SCENE = AU * SCALE;

  function pickStepAU(radiusAU) {
    if (radiusAU < 6)   return 0.5;
    if (radiusAU < 20)  return 1;
    if (radiusAU < 60)  return 2;
    if (radiusAU < 150) return 5;
    if (radiusAU < 400) return 10;
    return 20;
  }

  function pickHalfSizeAU(radiusAU) {
    return Math.max(minHalfSizeAU, Math.min(maxHalfSizeAU, radiusAU * 1.2));
  }

  let curStepAU = -1, curHalfAU = -1;

  function buildGrid(stepAU, halfSizeAU) {
    if (auGridMinor) { auGridMinor.dispose(); auGridMinor = null; }
    if (auGridMajor) { auGridMajor.dispose(); auGridMajor = null; }

    curStepAU = stepAU;
    curHalfAU = halfSizeAU;

    const extent = halfSizeAU * AU_SCENE;
    const step   = stepAU   * AU_SCENE;
    const N = Math.floor(extent / step);
    const minorLines = [], majorLines = [];

    function addLine(a, b, isMajor) {
      (isMajor ? majorLines : minorLines).push([a, b]);
    }

    for (let k = -N; k <= N; k++) {
      const pos = k * step;
      const isMajor = (k % majorEvery === 0);
      if (plane === "XY") {
        addLine(new BABYLON.Vector3(-extent, pos, offset), new BABYLON.Vector3( extent, pos, offset), isMajor);
        addLine(new BABYLON.Vector3(pos, -extent, offset), new BABYLON.Vector3(pos,  extent, offset), isMajor);
      } else {
        addLine(new BABYLON.Vector3(-extent, offset, pos), new BABYLON.Vector3( extent, offset, pos), isMajor);
        addLine(new BABYLON.Vector3(pos, offset, -extent), new BABYLON.Vector3(pos, offset,  extent), isMajor);
      }
    }

    if (minorLines.length) {
      auGridMinor = BABYLON.MeshBuilder.CreateLineSystem("auGridMinor", { lines: minorLines }, scene);
      auGridMinor.color = new BABYLON.Color3(0.30, 0.30, 0.30);
      auGridMinor.alpha = minorAlpha;
      auGridMinor.isPickable = false;
      auGridMinor.renderingGroupId = renderingGroupId;
      auGridMinor.alwaysSelectAsActiveMesh = true;
    }

    if (majorLines.length) {
      auGridMajor = BABYLON.MeshBuilder.CreateLineSystem("auGridMajor", { lines: majorLines }, scene);
      auGridMajor.color = new BABYLON.Color3(0.45, 0.45, 0.45);
      auGridMajor.alpha = majorAlpha;
      auGridMajor.isPickable = false;
      auGridMajor.renderingGroupId = renderingGroupId;
      auGridMajor.alwaysSelectAsActiveMesh = true;
    }
  }

  const radiusAU0 = (gridCamera?.radius ?? 100) / AU_SCENE;
  buildGrid(pickStepAU(radiusAU0), pickHalfSizeAU(radiusAU0));

  gridObserver = scene.onBeforeRenderObservable.add(() => {
    if (!isAUGridVisible) return;
    const rAU = (gridCamera?.radius ?? 100) / AU_SCENE;
    const wantedStepAU = pickStepAU(rAU);
    const wantedHalfAU = pickHalfSizeAU(rAU);
    if (wantedStepAU !== curStepAU || Math.abs(wantedHalfAU - curHalfAU) > 1e-9) {
      buildGrid(wantedStepAU, wantedHalfAU);
    }
    if (auGridMinor) auGridMinor.position.set(0, 0, offset);
    if (auGridMajor) auGridMajor.position.set(0, 0, offset);
  });
}

function setAUGridVisible(on) {
  isAUGridVisible = !!on;
  if (auGridMinor) auGridMinor.setEnabled(isAUGridVisible);
  if (auGridMajor) auGridMajor.setEnabled(isAUGridVisible);
  const toggleGridBtn = document.getElementById("toggleGridBtn");
  if (toggleGridBtn) toggleGridBtn.textContent = isAUGridVisible ? "Hide Grid" : "Show Grid";
}

function addLabel(mesh, text, opts = {}) {
  const rect = new BABYLON.GUI.Rectangle();
  rect.background = "transparent";
  rect.thickness  = 0;
  rect.paddingLeft  = "6px";
  rect.paddingRight = "6px";
  ui.addControl(rect);
  rect.linkWithMesh(mesh);
  rect.linkOffsetX = opts.offsetX ?? 18;
  rect.linkOffsetY = opts.offsetY ?? -18;

  const tb = new BABYLON.GUI.TextBlock();
  tb.text         = text;
  tb.color        = opts.color ?? "#cfd8ff";
  tb.fontSize     = opts.fontSize ?? 14;
  tb.outlineWidth = 2;
  tb.outlineColor = "#000000";
  rect.addControl(tb);
  return rect;
}

function createStarfield(starCount = 8000, radius = 15000) {
  const pcs = new BABYLON.PointsCloudSystem("starfield", 1, scene);
  pcs.addPoints(starCount, (p) => {
    const theta = Math.random() * 2 * Math.PI;
    const phi   = Math.acos(2 * Math.random() - 1);
    p.position = new BABYLON.Vector3(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    );
    p.color = new BABYLON.Color4(1, 1, 1, 1);
  });
  pcs.buildMeshAsync().then((mesh) => {
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.infiniteDistance = true;
    mesh.renderingGroupId = 0;
    if (mesh.material) {
      mesh.material.pointSize = 2.0;
      mesh.material.disableLighting = true;
      mesh.material.backFaceCulling = false;
      mesh.material.disableDepthWrite = true;
    }
  });
}

function initWorld() {
  createAUGridInfinite(camera, {
    plane: "XY", offset: 0,
    minorAlpha: 0.010, majorAlpha: 0.020,
    minHalfSizeAU: 12, maxHalfSizeAU: 100,
    majorEvery: 5, renderingGroupId: 0
  });

  const toggleGridBtn = document.getElementById("toggleGridBtn");
  toggleGridBtn?.addEventListener("click", () => setAUGridVisible(!isAUGridVisible));
  setAUGridVisible(true);

  ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("ui");

  const sun = BABYLON.MeshBuilder.CreateSphere("sun", { diameter: 0.8 }, scene);
  const sunMat = new BABYLON.StandardMaterial("sunMat", scene);
  sunMat.emissiveColor = new BABYLON.Color3(1, 1, 0.5);
  sun.material = sunMat;

  const glow = new BABYLON.GlowLayer("glow", scene);
  glow.referenceMeshToUseItsOwnMaterial(sun);
  glow.intensity = 0.05;
  scene.onBeforeRenderObservable.add(() => {
    const r = camera.radius;
    const t = Math.min(1, Math.max(0, (r - 50) / 400));
    glow.intensity = 0.08 * (1 - 0.9 * t);
  });

  createStarfield();
}
