// ─── Particle system (CPU + GPU paths) ───────────────────────────────────────
// Globals: rawParticles, tailParticles, gpuWriteCursor, simSeconds,
//          expiryByIndex, maxUsed, cpuSlots, particleMeshes,
//          baseLifetime, particleCountPerSec, cumulativeExposure,
//          distVisMaxScene, vRelMax_kms, vRelMax_scene
// Functions: initParticles, createTailParticle, generateBeta,
//            seedParticleAt, resetExposure
// Call: await initParticles()

// DOM refs grabbed at script-parse time (DOM is ready — scripts are end-of-body)
const particleLifetimeInput = document.getElementById("particleLifetimeInput");
const particleCountInput    = document.getElementById("particleCountInput");

let rawParticles;
let tailParticles     = [];
let gpuWriteCursor    = 0;
let simSeconds        = 0;
let expiryByIndex;
let maxUsed           = 0;
let cpuSlots;
let particleMeshes    = [];
let baseLifetime      = 30;
let particleCountPerSec = 1;
let cumulativeExposure  = 0;
let distVisMaxScene   = 2;
let vRelMax_kms       = 50;
let vRelMax_scene     = (vRelMax_kms * 1000) * SCALE;

function resetExposure() { cumulativeExposure = 0; }

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
