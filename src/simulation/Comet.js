
let e, q, a, i, omega, Omega, t0;
let orbitLine = null;
let customCometLabel;
let currentCometSource = "user";
let currentCometName   = null;
let fadeHalfLifeEDays  = 1500;
let visMode            = 'none';
let velocityScale      = 1.0;
let activityN          = 2;
let activityK          = 1;

const eccentricityInput            = document.getElementById("eccentricityInput");
const perihelionInput              = document.getElementById("perihelionInput");
const inclinationInput             = document.getElementById("inclinationInput");
const longitudeAscendingNodeInput  = document.getElementById("longitudeAscendingNodeInput");
const argumentPerihelionInput      = document.getElementById("argumentPerihelionInput");
const perihelionDateInput          = document.getElementById("perihelionDateInput");
const activityHalfLifeInput        = document.getElementById("activityHalfLifeInput");
const activityExponentInput        = document.getElementById("activityExponentInput");
const activityScaleInput           = document.getElementById("activityScaleInput");
const visModeSelect                = document.getElementById("visModeSelect");

function solveKeplerElliptic(M, eVal) {
  M = Math.atan2(Math.sin(M), Math.cos(M));
  let E = (eVal < 0.8) ? M : Math.PI * Math.sign(M || 1);

  for (let k = 0; k < 50; k++) {
    const f = E - eVal * Math.sin(E) - M;
    const fp = 1 - eVal * Math.cos(E);
    const dE = -f / fp;
    E += dE;
    if (Math.abs(dE) < 1e-13) break;
  }

  return E;
}

function solveKeplerHyperbolic(M, eVal) {
  if (Math.abs(M) < 1e-14) return 0;

  let H = Math.asinh(M / eVal);
  if (Math.abs(M) > 6) {
    H = Math.sign(M) * Math.log((2 * Math.abs(M)) / eVal + 1.8);
  }

  for (let k = 0; k < 80; k++) {
    const sinhH = Math.sinh(H);
    const coshH = Math.cosh(H);
    const f = eVal * sinhH - H - M;
    const fp = eVal * coshH - 1;
    let dH = -f / fp;

    if (Math.abs(dH) > 1) dH = Math.sign(dH);

    H += dH;
    if (Math.abs(dH) < 1e-13) break;
  }

  return H;
}

function solveBarkerParabolic(dt, q_m, mu) {
  const C = Math.sqrt((2 * q_m * q_m * q_m) / mu);
  const B = dt / C;
  let D = Math.cbrt(3 * B);

  for (let k = 0; k < 50; k++) {
    const f = D + (D * D * D) / 3 - B;
    const fp = 1 + D * D;
    const dD = -f / fp;
    D += dD;
    if (Math.abs(dD) < 1e-13) break;
  }

  return D;
}

function stateFromPerihelionElementsPQW(jd) {
  const eVal = e;
  const mu = GMsun;
  const q_m = q;
  const dt = (jd - t0) * SECONDS_PER_DAY;
  const EPS_E = 1e-10;

  let r_pf;
  let v_pf;

  if (eVal < 1 - EPS_E) {
    const a_m = q_m / (1 - eVal);
    const n = Math.sqrt(mu / (a_m * a_m * a_m));
    const M = n * dt;
    const E = solveKeplerElliptic(M, eVal);

    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    const oneMinusECosE = 1 - eVal * cosE;

    const x = a_m * (cosE - eVal);
    const y = a_m * Math.sqrt(1 - eVal * eVal) * sinE;

    const Edot = n / oneMinusECosE;
    const vx = -a_m * sinE * Edot;
    const vy =  a_m * Math.sqrt(1 - eVal * eVal) * cosE * Edot;

    r_pf = new BABYLON.Vector3(x, y, 0);
    v_pf = new BABYLON.Vector3(vx, vy, 0);

  } else if (eVal > 1 + EPS_E) {
    const A = q_m / (eVal - 1);
    const n = Math.sqrt(mu / (A * A * A));
    const M = n * dt;
    const H = solveKeplerHyperbolic(M, eVal);

    const coshH = Math.cosh(H);
    const sinhH = Math.sinh(H);
    const root = Math.sqrt(eVal * eVal - 1);
    const denom = eVal * coshH - 1;

    const x = A * (eVal - coshH);
    const y = A * root * sinhH;

    const Hdot = n / denom;
    const vx = -A * sinhH * Hdot;
    const vy =  A * root * coshH * Hdot;

    r_pf = new BABYLON.Vector3(x, y, 0);
    v_pf = new BABYLON.Vector3(vx, vy, 0);

  } else {
    const D = solveBarkerParabolic(dt, q_m, mu);
    const C = Math.sqrt((2 * q_m * q_m * q_m) / mu);

    const x = q_m * (1 - D * D);
    const y = 2 * q_m * D;

    const Ddot = 1 / (C * (1 + D * D));
    const vx = -2 * q_m * D * Ddot;
    const vy =  2 * q_m * Ddot;

    r_pf = new BABYLON.Vector3(x, y, 0);
    v_pf = new BABYLON.Vector3(vx, vy, 0);
  }

  return { r_pf, v_pf };
}

function cometStateAtJD(jd) {
  const { r_pf, v_pf } = stateFromPerihelionElementsPQW(jd);
  const r = rotPQWtoIJK(r_pf, Omega, i, omega);
  const v = rotPQWtoIJK(v_pf, Omega, i, omega);

  return {
    r_scene:       r.scale(SCALE),
    v_scene_per_s: v.scale(SCALE),
    rh_AU:         r.length() / AU
  };
}

// ─── Orbit drawing ────────────────────────────────────────────────────────────

function drawOrbit(segments = 800) {
  if (orbitLine) orbitLine.dispose();

  const points = [];
  const RMAX = 50 * AU;
  const p = a * (1 - e * e);

  let nuMin, nuMax;
  if (e < 1) {
    nuMin = -Math.PI; nuMax = Math.PI;
  } else if (Math.abs(e - 1) < 1e-12) {
    const pPar  = 2 * q;
    const c     = Math.min(1, Math.max(-1, (pPar / RMAX) - 1));
    const nuCap = Math.acos(c);
    const eps   = 1e-3;
    nuMin = -Math.min(nuCap, Math.PI - eps);
    nuMax =  Math.min(nuCap, Math.PI - eps);
  } else {
    const nuAsym  = Math.acos(-1 / e);
    const cNeeded = (p / RMAX) - 1;
    const arg = Math.min(1, Math.max(-1, cNeeded / e));
    const nuR = Math.acos(arg);
    const eps = 1e-3;
    const nuCap = Math.min(nuAsym - eps, nuR || (nuAsym - eps));
    nuMin = -nuCap; nuMax = nuCap;
  }

  for (let j = 0; j <= segments; j++) {
    const nu    = nuMin + (nuMax - nuMin) * (j / segments);
    const denom = 1 + e * Math.cos(nu);
    if (denom <= 0) continue;
    const r = (Math.abs(e - 1) < 1e-12) ? (2 * q) / denom : p / denom;
    if (!isFinite(r) || r > RMAX) continue;

    const x_orb = r * Math.cos(nu);
    const y_orb = r * Math.sin(nu);
    const cO = Math.cos(Omega), sO = Math.sin(Omega);
    const co = Math.cos(omega), so = Math.sin(omega);
    const ci = Math.cos(i),     si = Math.sin(i);
    const xp =  co*x_orb - so*y_orb;
    const yp =  so*x_orb + co*y_orb;
    const X  =  cO*xp - sO*(ci*yp);
    const Y  =  sO*xp + cO*(ci*yp);
    const Z  =  si*yp;
    points.push(new BABYLON.Vector3(X * SCALE, Y * SCALE, Z * SCALE));
  }

  orbitLine = BABYLON.MeshBuilder.CreateLines("orbitPath", { points }, scene);
  orbitLine.color = new BABYLON.Color3(0.8, 0.8, 0.8);
  orbitLine.isPickable = false;
}

// ─── Label helpers ────────────────────────────────────────────────────────────

function cometClassCode(eVal, a_AU, i_deg) {
  if (eVal >= 1.0) return "HYP";
  const P = Math.pow(a_AU, 1.5);
  if (P < 20 && i_deg < 40) return "SP";
  if (P < 200) return "HT";
  return "LP";
}

function userModelLabel(eVal, a_AU, q_AU, i_deg) {
  return `User model · ${cometClassCode(eVal, a_AU, i_deg)} · q ${q_AU.toFixed(2)} AU`;
}

function setActiveCometLabelText(text) {
  if (!customCometLabel) return;
  const tb = customCometLabel.children?.find?.(c => c instanceof BABYLON.GUI.TextBlock);
  if (tb) tb.text = text;
}

function ensureCometLabel(mesh, text, opts = {}) {
  if (mesh._cometLabel) return mesh._cometLabel;
  const nameFromMeta = mesh.metadata?.cometName;
  const nameFromMesh = mesh.name && mesh.name !== "comet" ? mesh.name : null;
  const finalText = nameFromMeta || nameFromMesh || text;
  const lbl = addLabel(mesh, finalText, { color: "#ffd7a8", fontSize: 16, offsetY: -24, ...opts });
  mesh._cometLabel = lbl;
  return lbl;
}

function applyElementsToUI(elts) {
  if (elts.e !== undefined)         eccentricityInput.value           = String(elts.e);
  if (elts.q_AU !== undefined)      perihelionInput.value             = String(elts.q_AU);
  if (elts.i_deg !== undefined)     inclinationInput.value            = String(elts.i_deg);
  if (elts.Omega_deg !== undefined) longitudeAscendingNodeInput.value = String(elts.Omega_deg);
  if (elts.omega_deg !== undefined) argumentPerihelionInput.value     = String(elts.omega_deg);
  if (elts.t0_JD !== undefined)     perihelionDateInput.value         = String(elts.t0_JD);
}

function activatePresetComet(mesh) {
  const name = mesh.metadata?.cometName || mesh.name || "Comet";
  const elts = mesh.metadata?.elts;
  if (!elts) { console.warn("[CometSim] Preset comet clicked but no metadata.elts on:", mesh.name); return; }
  currentCometSource = "preset";
  currentCometName   = name;
  applyElementsToUI(elts);
  if (customCometLabel) {
    const tb = customCometLabel.children?.find?.(c => c instanceof BABYLON.GUI.TextBlock);
    if (tb) tb.text = currentCometName;
  }
  setFocusOnComet(true);
}

// ─── Orbit parameter update ───────────────────────────────────────────────────

function updateOrbitParameters() {
  e     = parseFloat(eccentricityInput.value);
  q     = parseFloat(perihelionInput.value) * AU;
  i     = parseFloat(inclinationInput.value) * DEG;
  Omega = parseFloat(longitudeAscendingNodeInput.value) * DEG;
  omega = parseFloat(argumentPerihelionInput.value) * DEG;
  t0    = parseFloat(perihelionDateInput.value);
  activityN = parseFloat(activityExponentInput.value);
  activityK = parseFloat(activityScaleInput.value);

  fadeHalfLifeEDays = parseFloat(activityHalfLifeInput.value);
  if (!isFinite(fadeHalfLifeEDays) || fadeHalfLifeEDays <= 0) fadeHalfLifeEDays = 1500;

  a = q / (1 - e);

  if (orbitLine) orbitLine.dispose();
  drawOrbit();

  baseLifetime         = parseFloat(particleLifetimeInput.value);
  particleCountPerSec  = parseFloat(particleCountInput.value) || 1;
  ejectionSpeedMps  = parseFloat(ejectionSpeedInput?.value)  || 0;
  ejectionGamma     = parseFloat(ejectionGammaInput?.value)  ?? 0.5;
  ejectionKappa     = parseFloat(ejectionKappaInput?.value)  ?? -0.5;
  ejectionExpcos    = parseFloat(ejectionExpcosInput?.value) ?? 1.0;
  particleCountPerSec  = Math.max(0.01, particleCountPerSec);

  if (!isFinite(activityN)) activityN = 2;
  if (!isFinite(activityK)) activityK = 1;
  activityN = Math.max(0, Math.min(6, activityN));
  activityK = Math.max(0, activityK);

  if (customCometLabel) {
    const tb = customCometLabel.children?.find?.(c => c instanceof BABYLON.GUI.TextBlock);
    if (tb) {
      tb.text = (currentCometSource === "user" || !currentCometName)
        ? userModelLabel(e, a / AU, q / AU, i / DEG)
        : currentCometName;
    }
  }

  resetExposure();
}

// ─── Initialisation ───────────────────────────────────────────────────────────

function initComet() {
  e     = parseFloat(eccentricityInput.value);
  q     = parseFloat(perihelionInput.value) * AU;
  a     = q / (1 - e);
  i     = parseFloat(inclinationInput.value) * DEG;
  omega = parseFloat(argumentPerihelionInput.value) * DEG;
  Omega = parseFloat(longitudeAscendingNodeInput.value) * DEG;
  t0    = parseFloat(perihelionDateInput.value);

  fadeHalfLifeEDays = parseFloat(activityHalfLifeInput?.value) || 1500;
  activityN = parseFloat(activityExponentInput?.value ?? 2) || 2;
  activityK = parseFloat(activityScaleInput?.value ?? 1)   || 1;

  drawOrbit();

  document.getElementById("toggleOrbitBtn").addEventListener("click", () => {
    if (orbitLine) orbitLine.setEnabled(!orbitLine.isEnabled());
  });

  const initialPos = new BABYLON.Vector3(-0.02449938703, -0.07948059791, -0.00387641697);
  const comet = BABYLON.MeshBuilder.CreateSphere("comet", { diameter: 0.2 }, scene);
  cometMesh = comet;
  cometMesh.position = initialPos;
  const cometMat = new BABYLON.StandardMaterial("cometMat", scene);
  cometMat.diffuseColor  = new BABYLON.Color3(0.7, 0.7, 0.7);
  cometMat.emissiveColor = new BABYLON.Color3(0.1, 0.1, 0.1);
  cometMesh.material = cometMat;

  customCometLabel = ensureCometLabel(cometMesh, userModelLabel(e, a / AU, q / AU, i / DEG));

  // Preset label finders
  const PRESET_FINDERS = [
    { key: "67p",     id: "67P",     name: "67P/Churyumov–Gerasimenko" },
    { key: "c2024e1", id: "C2024E1", name: "C/2024 E1" },
    { key: "133p",    id: "133P",    name: "133P/Elst–Pizarro" },
    { key: "3i",      id: "3I",      name: "3I/ATLAS" }
  ];
  for (const f of PRESET_FINDERS) {
    const mesh = scene.meshes.find(m =>
      m !== cometMesh &&
      m.name.toLowerCase().includes("comet") &&
      m.name.toLowerCase().includes(f.key)
    );
    if (!mesh) continue;
    mesh.metadata = mesh.metadata || {};
    mesh.metadata.presetId  = f.id;
    mesh.metadata.cometName = mesh.metadata.cometName || f.name;
    ensureCometLabel(mesh, mesh.metadata.cometName);
  }

  scene.onPointerObservable.add((pi) => {
    if (pi.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
    const picked = pi.pickInfo?.pickedMesh;
    if (!picked || picked === cometMesh) return;
    const pid = picked.metadata?.presetId;
    if (pid && typeof window.loadComet === "function") {
      window.loadComet(pid);
      window.switchToPreset?.(picked.metadata?.cometName || pid);
    }
  });

  scene.onPointerObservable.add((pi) => {
    if (pi.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
    const picked = pi.pickInfo?.pickedMesh;
    if (!picked || picked === cometMesh) return;
    const isPreset = !!(picked.metadata?.cometName && picked.metadata?.elts);
    if (isPreset) activatePresetComet(picked);
  });

  window.switchToPreset = function(name) {
    currentCometSource = "preset";
    currentCometName   = name || "Comet";
    setActiveCometLabelText(currentCometName);
  };

  window.switchToUser = function() {
    currentCometSource = "user";
    currentCometName   = null;
    setActiveCometLabelText(userModelLabel(e, a / AU, q / AU, i / DEG));
  };

  window.updateOrbitParameters = updateOrbitParameters;

  if (typeof window.loadComet === "function") {
    window._skipInitialFocus = true;
    setTimeout(() => {
      window.loadComet("67P");
      window.switchToPreset?.("67P/Churyumov–Gerasimenko");
    }, 100);
  }
}
