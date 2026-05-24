// ─── Particle system (CPU + GPU paths) ───────────────────────────────────────
// Globals: rawParticles, tailParticles, gpuWriteCursor, simSeconds,
//          expiryByIndex, maxUsed, cpuSlots, particleMeshes,
//          baseLifetime, particleCountPerSec, cumulativeExposure,
//          distVisMaxScene, vRelMax_kms, vRelMax_scene
// Functions: initParticles, createTailParticle, generateBeta,
//            seedParticleAt, resetExposure
// Call: await initParticles()

// DOM refs grabbed at script-parse time (DOM is ready — scripts are end-of-body)
const particleLifetimeInput  = document.getElementById("particleLifetimeInput");
const particleCountInput     = document.getElementById("particleCountInput");
const ejectionSpeedInput     = document.getElementById("ejectionSpeedInput");
const ejectionGammaInput     = document.getElementById("ejectionGammaInput");
const ejectionKappaInput     = document.getElementById("ejectionKappaInput");
const ejectionExpcosInput    = document.getElementById("ejectionExpcosInput");

let rawParticles;
let tailParticles     = [];
let gpuWriteCursor    = 0;
let simSeconds        = 0;
let expiryByIndex;
let maxUsed           = 0;
let cpuSlots;
let particleMeshes    = [];
let baseLifetime        = 30;
let particleCountPerSec = 1;
let ejectionSpeedMps    = 500;
let ejectionGamma       = 0.5;
let ejectionKappa       = -0.5;
let ejectionExpcos      = 1.0;
let cumulativeExposure  = 0;
let distVisMaxScene   = 2;
let vRelMax_kms       = 50;
let vRelMax_scene     = (vRelMax_kms * 1000) * SCALE;

function resetExposure() { cumulativeExposure = 0; }

// Sunlit-hemisphere sample directed toward `axis`.
// PDF ∝ cos^expcos(θ): expcos=0 → uniform hemisphere, expcos=1 → Lambert, higher → narrower beam.
// z = u^(1/(expcos+1)) is the exact inversion of the CDF for this family.
function randomSunwardDir(axis, expcos) {
  const u1  = Math.random(), u2 = Math.random();
  const z   = Math.pow(u1, 1 / (expcos + 1));
  const r   = Math.sqrt(1 - z * z);
  const phi = 2 * Math.PI * u2;
  const lx  = r * Math.cos(phi), ly = r * Math.sin(phi);

  // Build orthonormal basis with axis as "up"
  const up  = axis.clone().normalize();
  const tmp = Math.abs(up.x) < 0.9
    ? new BABYLON.Vector3(1, 0, 0)
    : new BABYLON.Vector3(0, 1, 0);
  const right = BABYLON.Vector3.Cross(up, tmp).normalize();
  const fwd   = BABYLON.Vector3.Cross(right, up).normalize();

  return right.scale(lx).add(fwd.scale(ly)).addInPlace(up.scale(z));
}

function seedParticleAt(index, r_scene, v_scene_per_s, lifeSeconds, beta) {
  if (rawParticles) rawParticles.seed(index, r_scene, v_scene_per_s, lifeSeconds, beta);
}

function generateBeta(min, max, skew) {
  if (betaUI && betaUI.enabled) {
    return Math.min(1, Math.max(0, sampleBetaFromCurve(Math.random())));
  }
  if (min === max) return min;
  let u = Math.random();
  if (skew !== 0) {
    const k = 1 + Math.abs(skew);
    u = (skew < 0) ? 1 - Math.pow(1 - u, k) : Math.pow(u, k);
  }
  return min + u * (max - min);
}

function createTailParticle(timeNowJD) {
  const cs             = cometStateAtJD(timeNowJD);
  const cometPos_scene = cs.r_scene;
  const cometVel_scene = cs.v_scene_per_s;
  const beta           = generateBeta();
  const r0_scene       = cometPos_scene.clone();
  const v_scene        = cometVel_scene.clone();
  const lifeSeconds    = (baseLifetime / velocityScale) * SECONDS_PER_DAY;

  // Whipple/Finson-Probstein ejection: v_ej = V0 * β^γ * r_h^κ
  // Direction: cosine^expcos-weighted sunlit hemisphere (expcos=0 uniform, 1=Lambert, >1 narrower).
  if (ejectionSpeedMps > 0) {
    const rh_AU   = Math.max(cs.rh_AU, 0.1);
    const vEj_mps = ejectionSpeedMps
      * Math.pow(Math.max(beta, 0), ejectionGamma)
      * Math.pow(rh_AU, ejectionKappa);
    const sunward = cometPos_scene.scale(-1).normalize();
    const ejDir   = randomSunwardDir(sunward, ejectionExpcos);
    v_scene.addInPlace(ejDir.scale(vEj_mps * SCALE));
  }

  if (rawParticles) {
    if (gpuWriteCursor >= rawParticles.max) gpuWriteCursor = 0;
    let tries = 0;
    while (tries < rawParticles.max && expiryByIndex[gpuWriteCursor] > simSeconds) {
      gpuWriteCursor = (gpuWriteCursor + 1) % rawParticles.max;
      tries++;
    }
    if (tries === rawParticles.max) return;
    const idx = gpuWriteCursor;
    expiryByIndex[idx] = simSeconds + lifeSeconds;
    gpuWriteCursor = (gpuWriteCursor + 1) % rawParticles.max;
    if (idx + 1 > maxUsed) maxUsed = idx + 1;
    seedParticleAt(idx, r0_scene, v_scene, lifeSeconds, beta);
  } else {
    const MAX_PARTICLES = cpuSlots.length;
    if (gpuWriteCursor >= MAX_PARTICLES) gpuWriteCursor = 0;
    let tries = 0;
    while (tries < MAX_PARTICLES && expiryByIndex[gpuWriteCursor] > simSeconds) {
      gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
      tries++;
    }
    if (tries === MAX_PARTICLES) return;
    const idx    = gpuWriteCursor;
    const r0_m   = r0_scene.scale(1 / SCALE);
    const v0_mps = v_scene.scale(1 / SCALE);
    const mu_p   = GMsun * Math.max(1 - beta, 0);
    cpuSlots[idx] = { t0JD: timeNowJD, r0_m, v0_mps, mu: mu_p, lifeSeconds, beta };
    expiryByIndex[idx] = simSeconds + lifeSeconds;
    gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
    if (idx + 1 > maxUsed) maxUsed = idx + 1;
    const mesh = particleMeshes[idx];
    mesh.position.copyFrom(r0_scene);
    mesh.setEnabled(true);
    if (mesh.material) mesh.material.alpha = 0.5;
  }
}

async function initParticles() {
  const MAX_PARTICLES = useCompute ? MAX_PARTICLES_GPU : MAX_PARTICLES_CPU;
  cpuSlots      = new Array(MAX_PARTICLES);
  expiryByIndex = new Float32Array(MAX_PARTICLES);

  updateOrbitParameters();

  rawParticles = useCompute ? await setupRawParticles(engine, canvas, MAX_PARTICLES) : null;
  if (rawParticles) rawParticles.clear();

  if (!useCompute) {
    for (let idx = 0; idx < MAX_PARTICLES; idx++) {
      const mesh = BABYLON.MeshBuilder.CreateIcoSphere("tailParticle", { radius: 0.05, subdivisions: 2 }, scene);
      const mat  = new BABYLON.StandardMaterial("tailMat", scene);
      mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
      mat.diffuseColor  = new BABYLON.Color3(0.6, 0.6, 0.6);
      mat.alpha = 0.5;
      mesh.material = mat;
      mesh.setEnabled(false);
      particleMeshes.push(mesh);
    }
  }
}
