// ─── Synchrones, syndynes, and CSV export ────────────────────────────────────
// Globals: synchroneMeshes, syndyneMeshes, synchroneEpochJD, syndyneEpochJD,
//          lastSynchroneLines, lastSyndyneLines,
//          synBtn, syndyneBtn, exportCSVBtn
// Functions: initSyndyneSynchrone, computePAFromSynchrone,
//            generateSynchronesAtEpoch, generateSyndynesAtEpoch,
//            drawSynchrones, clearSynchrones, drawSyndynes, clearSyndynes
// Call: initSyndyneSynchrone()

let synchroneMeshes  = [];
let syndyneMeshes    = [];
let synchroneEpochJD = null;
let syndyneEpochJD   = null;
let lastSynchroneLines = null;
let lastSyndyneLines   = null;

const synBtn       = document.getElementById("generateSynchronesBtn");
const syndyneBtn   = document.getElementById("generateSyndynesBtn");
const exportCSVBtn = document.getElementById("exportSynSydCSVBtn");
const synDaysInput  = document.getElementById("synchroneDaysInput");
const synBetasInput = document.getElementById("synchroneBetasInput");

// ─── Position angle from a synchrone curve ───────────────────────────────────

function computePAFromSynchrone({ synchronePoints, cometPos, earthPos }) {
  if (!synchronePoints || synchronePoints.length < 2) return null;

  const cometEq = eclToEq(cometPos);
  const earthEq = eclToEq(earthPos);

  let iClosest = 0, dMin = Number.POSITIVE_INFINITY;
  for (let i = 0; i < synchronePoints.length; i++) {
    const di = BABYLON.Vector3.DistanceSquared(synchronePoints[i], cometPos);
    if (di < dMin) { dMin = di; iClosest = i; }
  }

  const candidates = [];
  if (iClosest > 0)                             candidates.push(iClosest - 1);
  if (iClosest < synchronePoints.length - 1)   candidates.push(iClosest + 1);

  let iOut = candidates[0], bestOutDist = -1;
  for (const j of candidates) {
    const dj = BABYLON.Vector3.DistanceSquared(synchronePoints[j], cometPos);
    if (dj > bestOutDist) { bestOutDist = dj; iOut = j; }
  }

  const P1eq = eclToEq(synchronePoints[iClosest]);
  const P2eq = eclToEq(synchronePoints[iOut]);
  const d    = P2eq.subtract(P1eq).normalize();
  const los  = cometEq.subtract(earthEq).normalize();
  const dPerp = d.subtract(los.scale(BABYLON.Vector3.Dot(d, los))).normalize();
  const rGeo  = cometEq.subtract(earthEq).normalize();
  const ra    = Math.atan2(rGeo.y, rGeo.x);
  const dec   = Math.asin(rGeo.z);
  const east  = new BABYLON.Vector3(-Math.sin(ra), Math.cos(ra), 0).normalize();
  const north = new BABYLON.Vector3(
    -Math.cos(ra) * Math.sin(dec),
    -Math.sin(ra) * Math.sin(dec),
     Math.cos(dec)
  ).normalize();

  let pa = Math.atan2(
    BABYLON.Vector3.Dot(dPerp, east),
    BABYLON.Vector3.Dot(dPerp, north)
  ) * 180 / Math.PI;
  if (pa < 0) pa += 360;
  return pa;
}

// ─── Generation ───────────────────────────────────────────────────────────────

function generateSynchronesAtEpoch({ observationJD, emissionOffsetsDays, betaValues }) {
  const lines = [];
  for (const dDays of emissionOffsetsDays) {
    const emissionJD = observationJD + dDays;
    const csEmit = cometStateAtJD(emissionJD);
    if (!csEmit) continue;
    const r0_m   = csEmit.r_scene.scale(1 / SCALE);
    const v0_mps = csEmit.v_scene_per_s.scale(1 / SCALE);
    const pts = [];
    for (const beta of betaValues) {
      const muEff = GMsun * Math.max(0, 1 - beta);
      const dtSec = (observationJD - emissionJD) * SECONDS_PER_DAY;
      let r_m;
      if (muEff <= 0 || dtSec === 0) { r_m = r0_m.add(v0_mps.scale(dtSec)); }
      else                           { r_m = keplerUniversalPropagate(r0_m, v0_mps, dtSec, muEff).r; }
      pts.push(r_m.scale(SCALE));
    }
    if (pts.length >= 2) lines.push({ dDays, betas: [...betaValues], points: pts });
  }
  lastSynchroneLines = lines;
  return lines;
}

function generateSyndynesAtEpoch({ observationJD, emissionOffsetsDays, betaValues }) {
  const lines = [];
  for (const beta of betaValues) {
    const pts = [];
    for (const dDays of emissionOffsetsDays) {
      const emissionJD = observationJD + dDays;
      const csEmit = cometStateAtJD(emissionJD);
      if (!csEmit) continue;
      const r0_m   = csEmit.r_scene.scale(1 / SCALE);
      const v0_mps = csEmit.v_scene_per_s.scale(1 / SCALE);
      const muEff = GMsun * Math.max(0, 1 - beta);
      const dtSec = (observationJD - emissionJD) * SECONDS_PER_DAY;
      let r_m;
      if (muEff <= 0 || dtSec === 0) { r_m = r0_m.add(v0_mps.scale(dtSec)); }
      else                           { r_m = keplerUniversalPropagate(r0_m, v0_mps, dtSec, muEff).r; }
      pts.push(r_m.scale(SCALE));
    }
    if (pts.length >= 2) lines.push({ beta, dDaysList: [...emissionOffsetsDays], points: pts });
  }
  lastSyndyneLines = lines;
  return lines;
}

// ─── Draw / clear ─────────────────────────────────────────────────────────────

function drawSynchrones(lines) {
  clearSynchrones();
  for (const L of lines) {
    const mesh = BABYLON.MeshBuilder.CreateLines(`synchrone_${L.dDays}`, { points: L.points }, scene);
    mesh.color = new BABYLON.Color3(1.0, 0.75, 0.3);
    mesh.isPickable = false;
    mesh.renderingGroupId = 2;
    synchroneMeshes.push(mesh);
  }
}

function clearSynchrones() {
  synchroneMeshes.forEach(m => m.dispose());
  synchroneMeshes.length = 0;
}

function drawSyndynes(lines) {
  clearSyndynes();
  for (const L of lines) {
    const mesh = BABYLON.MeshBuilder.CreateLines(`syndyne_${L.beta}`, { points: L.points }, scene);
    mesh.color = new BABYLON.Color3(0.35, 0.75, 1.0);
    mesh.isPickable = false;
    mesh.renderingGroupId = 2;
    syndyneMeshes.push(mesh);
  }
}

function clearSyndynes() {
  syndyneMeshes.forEach(m => m.dispose());
  syndyneMeshes.length = 0;
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportSynchroneSyndyneCSV() {
  if (!isPaused) { console.warn("Pause the simulation before exporting CSV."); return; }
  const hasSyn = Array.isArray(lastSynchroneLines) && lastSynchroneLines.length;
  const hasSyd = Array.isArray(lastSyndyneLines)   && lastSyndyneLines.length;
  if (!hasSyn && !hasSyd) { console.warn("Nothing to export. Generate synchrones/syndynes first."); return; }

  const epochJD    = synchroneEpochJD ?? syndyneEpochJD ?? simulationTimeJD;
  const earthScene = getPlanetPosition(epochJD, earthEl);
  const cometScene = cometStateAtJD(epochJD).r_scene;
  const cometRD    = heliocentricSceneToRaDec(cometScene, earthScene);

  const rows = [["type","epochJD","dDays","beta","pointIndex","raDeg","decDeg","cometRaDeg","cometDecDeg"]];

  if (hasSyn) {
    for (const L of lastSynchroneLines) {
      for (let k = 0; k < L.points.length; k++) {
        const beta = (L.betas || [])[k] ?? "";
        const rd   = heliocentricSceneToRaDec(L.points[k], earthScene);
        rows.push(["synchrone", epochJD, L.dDays, beta, k,
          rd.raDeg.toFixed(8), rd.decDeg.toFixed(8),
          cometRD.raDeg.toFixed(8), cometRD.decDeg.toFixed(8)]);
      }
    }
  }
  if (hasSyd) {
    for (const L of lastSyndyneLines) {
      for (let k = 0; k < L.points.length; k++) {
        const dDays = (L.dDaysList || [])[k] ?? "";
        const rd    = heliocentricSceneToRaDec(L.points[k], earthScene);
        rows.push(["syndyne", epochJD, dDays, L.beta, k,
          rd.raDeg.toFixed(8), rd.decDeg.toFixed(8),
          cometRD.raDeg.toFixed(8), cometRD.decDeg.toFixed(8)]);
      }
    }
  }

  const fname = `synchrone_syndyne_radec_JD${epochJD.toFixed(2)}.csv`;
  downloadCSV(fname, rows);
  console.log(`[CSV] Exported ${rows.length - 1} rows -> ${fname}`);
}

// ─── Initialisation (wires up button handlers) ────────────────────────────────

function initSyndyneSynchrone() {
  synBtn.addEventListener("click", async () => {
    if (!isPaused) { console.warn("Pause simulation before generating synchrones"); return; }
    const days  = parseNumberList(synDaysInput.value);
    const betas = parseNumberList(synBetasInput.value);
    if (days.length === 0 || betas.length === 0) { console.warn("Invalid synchrone inputs"); return; }

    synBtn.textContent = "Computing…";
    synBtn.disabled    = true;
    await new Promise(r => setTimeout(r, 0));

    synchroneEpochJD = simulationTimeJD;
    const lines = generateSynchronesAtEpoch({
      observationJD: synchroneEpochJD,
      emissionOffsetsDays: days,
      betaValues: betas
    });
    drawSynchrones(lines);

    const earthPosNow = getPlanetPosition(simulationTimeJD, earthEl);
    console.log("=== Synchrone PA report ===");
    for (const L of [...lines].sort((a, b) => a.dDays - b.dDays)) {
      if (!L.points || L.points.length < 2) continue;
      const pa = computePAFromSynchrone({
        synchronePoints: L.points,
        cometPos: cometMesh.position,
        earthPos: earthPosNow
      });
      if (pa !== null) console.log(`Synchrone ${String(L.dDays).padStart(4)} d : ${pa.toFixed(1)} deg`);
    }
    const cometToSun   = cometMesh.position.scale(-1).normalize();
    const pseudoPoints = [cometMesh.position, cometMesh.position.add(cometToSun)];
    const PA_antisolar = computePAFromSynchrone({ synchronePoints: pseudoPoints, cometPos: cometMesh.position, earthPos: earthPosNow });
    console.log("Antisolar PA:", PA_antisolar?.toFixed(1), "deg");

    synBtn.textContent = "Generate synchrones";
    synBtn.disabled    = false;
  });

  syndyneBtn.addEventListener("click", async () => {
    const days  = parseNumberList(synDaysInput.value);
    const betas = parseNumberList(synBetasInput.value);
    if (days.length === 0 || betas.length === 0) { console.warn("Invalid syndyne inputs"); return; }

    syndyneBtn.textContent = "Computing…";
    syndyneBtn.disabled    = true;
    await new Promise(r => setTimeout(r, 0));

    syndyneEpochJD = simulationTimeJD;
    const lines = generateSyndynesAtEpoch({
      observationJD: syndyneEpochJD,
      emissionOffsetsDays: days,
      betaValues: betas
    });
    drawSyndynes(lines);

    syndyneBtn.textContent = "Generate syndynes";
    syndyneBtn.disabled    = false;
  });

  exportCSVBtn.addEventListener("click", exportSynchroneSyndyneCSV);
}
