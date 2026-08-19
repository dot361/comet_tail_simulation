// ─── Angle helper ─────────────────────────────────────────────────────────────

function deg2rad(deg) { return deg * Math.PI / 180; }

// ─── Kepler's equation (eccentric anomaly) ────────────────────────────────────

function keplerSolveE(M, e) {
  let E = M;
  for (let k = 0; k < 12; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = -f / fp;
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// ─── Planet position (ecliptic J2000, scene units) ───────────────────────────

function getPlanetPosition(jd, el) {
  const a_m = el.a * AU;
  const n   = Math.sqrt(GMsun / (a_m * a_m * a_m));
  const t   = (jd - 2451545.0) * SECONDS_PER_DAY;

  let M = el.M0 + n * t;
  M = ((M % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);

  const E = keplerSolveE(M, el.e);
  const cosE = Math.cos(E), sinE = Math.sin(E);

  const x_orb = a_m * (cosE - el.e);
  const y_orb = a_m * Math.sqrt(1 - el.e*el.e) * sinE;

  const cO = Math.cos(el.Omega), sO = Math.sin(el.Omega);
  const ci = Math.cos(el.i),     si = Math.sin(el.i);
  const co = Math.cos(el.omega), so = Math.sin(el.omega);

  const xp =  co * x_orb - so * y_orb;
  const yp =  so * x_orb + co * y_orb;
  const ypp = ci * yp;
  const zpp = si * yp;

  return new BABYLON.Vector3(
    (cO * xp  - sO * ypp) * SCALE,
    (sO * xp  + cO * ypp) * SCALE,
    zpp * SCALE
  );
}

// ─── Planet orbit curve ───────────────────────────────────────────────────────

function drawPlanetOrbit(scene, el, segments = 1024, color = new BABYLON.Color3(0.6, 0.7, 0.9)) {
  const pts = [];
  for (let j = 0; j <= segments; j++) {
    const nu = -Math.PI + (2*Math.PI*j)/segments;
    const p = el.a * AU * (1 - el.e*el.e);
    const r = p / (1 + el.e * Math.cos(nu));

    const x_orb = r * Math.cos(nu);
    const y_orb = r * Math.sin(nu);

    const cO = Math.cos(el.Omega), sO = Math.sin(el.Omega);
    const ci = Math.cos(el.i),     si = Math.sin(el.i);
    const co = Math.cos(el.omega), so = Math.sin(el.omega);

    const xp  =  co*x_orb - so*y_orb;
    const yp  =  so*x_orb + co*y_orb;
    const ypp = ci*yp;
    const zpp = si*yp;

    pts.push(new BABYLON.Vector3(
      (cO*xp - sO*ypp) * SCALE,
      (sO*xp + cO*ypp) * SCALE,
      zpp * SCALE
    ));
  }

  const line = BABYLON.MeshBuilder.CreateLines("orbit-"+(el.name||"p"), { points: pts }, scene);
  line.color = color;
  line.isPickable = false;

  // Keep a registry of planet orbit meshes so the View panel can hide/show them
  // without touching the comet orbit.
  if (typeof planetOrbitMeshes !== "undefined" && Array.isArray(planetOrbitMeshes)) {
    planetOrbitMeshes.push(line);
  }

  return line;
}

function planetRadiusToSceneUnits(radiusKm) {
  return radiusKm * 1000 * SCALE * PLANET_SIZE_SCALE;
}

// ─── Stumpff functions (universal Kepler) ─────────────────────────────────────

function stumpffC(z) {
  if (Math.abs(z) < 1e-8) return 0.5 - z/24 + (z*z)/720 - (z*z*z)/40320;
  if (z > 0) { const s = Math.sqrt(z);  return (1 - Math.cos(s)) / z; }
  else       { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / (-z); }
}

function stumpffS(z) {
  if (Math.abs(z) < 1e-8) return 1/6 - z/120 + (z*z)/5040 - (z*z*z)/362880;
  if (z > 0) { const s = Math.sqrt(z);  return (s - Math.sin(s)) / (s*s*s); }
  else       { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s*s*s); }
}

// ─── Universal Kepler propagator ─────────────────────────────────────────────
//
// Single-step solver. For very small mu (e.g. beta close to 1, so
// mu = GMsun*(1-beta) is tiny) combined with longer dt, the universal
// variable x grows large, making z = alpha*x^2 extreme — the Stumpff
// functions' cosh/sinh of sqrt(-z) then blow up and the Newton iteration
// loses all numerical footing well before x converges (confirmed: produces
// positions wrong by 5+ orders of magnitude for some beta>0.998, long-dt
// combinations). keplerUniversalPropagate (below) guards against this by
// substepping; this function is the unguarded per-step math, unchanged from
// before so every previously-working call stays bit-identical.
function _keplerUniversalStep(r0, v0, dt, mu) {
  if (!isFinite(dt) || dt === 0) return { r: r0.clone(), v: v0.clone() };

  const r0mag = r0.length();
  const v0mag = v0.length();
  const vr0   = BABYLON.Vector3.Dot(r0, v0) / Math.max(1e-12, r0mag);
  const alpha  = 2/Math.max(1e-12, r0mag) - (v0mag*v0mag)/mu;

  let x;
  if (Math.abs(alpha) > 1e-12) x = Math.sqrt(mu) * Math.abs(alpha) * Math.abs(dt);
  else                         x = Math.sqrt(mu) * Math.abs(dt) / Math.max(1e-12, r0mag);
  if (dt < 0) x = -x;

  const sqrtMu = Math.sqrt(mu);
  for (let it = 0; it < 60; it++) {
    const z = alpha * x * x;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F = r0mag*vr0/sqrtMu * x*x*C + (1 - alpha*r0mag)*x*x*x*S + r0mag*x - sqrtMu*dt;
    const dF = r0mag*vr0/sqrtMu * x*(1 - z*S) + (1 - alpha*r0mag)*x*x*C + r0mag;
    const dx = -F / dF;
    x += dx;
    if (Math.abs(dx) < 1e-10) break;
  }

  const z = alpha * x * x;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - (x*x / r0mag) * C;
  const g = dt - (x*x*x / sqrtMu) * S;
  const r = r0.scale(f).add(v0.scale(g));
  const rmag = r.length();
  const fdot = (sqrtMu / (rmag * r0mag)) * (z*S - 1) * x;
  const gdot = 1 - (x*x / rmag) * C;
  const v = r0.scale(fdot).add(v0.scale(gdot));

  if (![r.x,r.y,r.z,v.x,v.y,v.z].every(Number.isFinite)) {
    return { r: r0.add(v0.scale(dt)), v: v0.clone() };
  }
  return { r, v };
}

// Keeping |z| = |alpha * x^2| below this bound keeps cosh/sinh(sqrt(|z|))
// within a range where the Newton iteration stays well-conditioned
// (sqrt(50) ~ 7.07, cosh(7.07) ~ 590 — nowhere near float64 precision loss
// or overflow). z scales as 1/N^2 under substepping (x scales as 1/N for a
// fixed alpha), so N = ceil(sqrt(|z_initial|/Z_SAFE)) is the exact substep
// count needed to bring it under the bound.
const KEPLER_Z_SAFE = 50;
const KEPLER_MAX_SUBSTEPS = 64;

function _repulsivePropagate(r0, v0, dt, mu) {
  const accel = (r) => {
    const rn = Math.max(1e-6, r.length());
    return r.scale(-mu / (rn * rn * rn));
  };
  const rmag = Math.max(1e-6, r0.length());
  const tDyn = Math.sqrt((rmag * rmag * rmag) / Math.abs(mu));
  let n = Math.ceil(Math.abs(dt) / (0.02 * tDyn));
  n = Math.min(200000, Math.max(1, n));
  const h = dt / n;
  let r = r0.clone(), v = v0.clone();
  for (let s = 0; s < n; s++) {
    const k1v = accel(r);                        const k1r = v;
    const k2v = accel(r.add(k1r.scale(0.5 * h))); const k2r = v.add(k1v.scale(0.5 * h));
    const k3v = accel(r.add(k2r.scale(0.5 * h))); const k3r = v.add(k2v.scale(0.5 * h));
    const k4v = accel(r.add(k3r.scale(h)));       const k4r = v.add(k3v.scale(h));
    r = r.add(k1r.add(k2r.scale(2)).add(k3r.scale(2)).add(k4r).scale(h / 6));
    v = v.add(k1v.add(k2v.scale(2)).add(k3v.scale(2)).add(k4v).scale(h / 6));
  }
  if (![r.x, r.y, r.z, v.x, v.y, v.z].every(Number.isFinite)) {
    return { r: r0.add(v0.scale(dt)), v: v0.clone() };
  }
  return { r, v };
}

function keplerUniversalPropagate(r0, v0, dt, mu) {
  if (!isFinite(dt) || dt === 0) return { r: r0.clone(), v: v0.clone() };
  if (mu < 0)   return _repulsivePropagate(r0, v0, dt, mu);
  if (mu === 0) return { r: r0.add(v0.scale(dt)), v: v0.clone() };

  const r0mag = Math.max(1e-12, r0.length());
  const v0mag = v0.length();
  const alpha = 2/r0mag - (v0mag*v0mag)/mu;

  let xGuess;
  if (Math.abs(alpha) > 1e-12) xGuess = Math.sqrt(mu) * Math.abs(alpha) * Math.abs(dt);
  else                         xGuess = Math.sqrt(mu) * Math.abs(dt) / r0mag;
  const zGuess = alpha * xGuess * xGuess;

  let nSub = 1;
  if (Math.abs(zGuess) > KEPLER_Z_SAFE) {
    nSub = Math.min(KEPLER_MAX_SUBSTEPS, Math.ceil(Math.sqrt(Math.abs(zGuess) / KEPLER_Z_SAFE)));
  }

  if (nSub === 1) return _keplerUniversalStep(r0, v0, dt, mu);

  const subDt = dt / nSub;
  let r = r0, v = v0;
  for (let s = 0; s < nSub; s++) {
    const step = _keplerUniversalStep(r, v, subDt, mu);
    r = step.r; v = step.v;
  }
  return { r, v };
}

// ─── PQW → IJK rotation ──────────────────────────────────────────────────────

function rotPQWtoIJK(v, Omega, i, omega) {
  const cO = Math.cos(Omega), sO = Math.sin(Omega);
  const ci = Math.cos(i),     si = Math.sin(i);
  const co = Math.cos(omega), so = Math.sin(omega);

  const x  = co*v.x - so*v.y;
  const y  = so*v.x + co*v.y;
  const y2 = ci*y - si*v.z;
  const z2 = si*y + ci*v.z;

  return new BABYLON.Vector3(cO*x - sO*y2, sO*x + cO*y2, z2);
}
