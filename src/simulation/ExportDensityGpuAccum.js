// ─── GPU density-cube export (accumulates the REAL particle buffer) ──────────
//
// This is the validation-grade density export: rather than an offline analytic
// bake or a single buffer snapshot, it reads back the ACTUAL WebGPU particle
// positions — the ones the
// browser integrated with its own leapfrog kernel (ParticlesGPU.js) from the
// live emission model (Particles.js) — and accumulates them over many frames
// into one cometocentric density cube.
//
// Why accumulate: a single snapshot holds at most MAX_PARTICLES_GPU live grains
// (~1e6), which is shot-noise-limited in the sparse tail. Letting the live loop
// keep emitting + integrating while we read back over N frames stacks many
// realizations of the quasi-steady tail (in the cometocentric frame the steady
// structure is stationary), filling the grid and smoothing the morphology.
//
// Nothing here reimplements COMTAILS or even re-derives the dynamics: it is a
// pure measurement of what the GPU simulation actually produced. The only thing
// it shares with the COMTAILS comparison is the grid (fixed bounds + intrinsic
// n/m/l frame), so the two cubes line up voxel-for-voxel for a normalized
// morphology comparison.
//
// Requires the WebGPU (compute) path — rawParticles must exist. Run it from a
// real browser; the software-GL headless harness has no WebGPU.

const gpuAccumFramesInput = document.getElementById('gpuAccumFramesInput');
const gpuAccumGridNInput  = document.getElementById('gpuAccumGridNInput');
const exportGpuAccumBtn    = document.getElementById('exportGpuAccumBtn');

function gaNumber(v, fallback, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function gaCross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function gaNorm(v) {
  const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
  return l < 1e-30 ? [0,0,0] : [v[0]/l, v[1]/l, v[2]/l];
}

// Wait for one rendered frame. The render loop's onAfterRenderObservable (set up
// in startRenderLoop) runs the GPU integration first; our addOnce fires after
// it, so by the time this resolves the buffer has been advanced for the frame.
function gaNextFrame() {
  return new Promise(resolve => scene.onAfterRenderObservable.addOnce(() => resolve()));
}

function gaResolveFixedBounds(options) {
  const fixedNum = (optKey, id, fallback) => {
    if (options[optKey] !== undefined && Number.isFinite(Number(options[optKey]))) return Number(options[optKey]);
    const v = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    nmin: fixedNum('nmin', 'densityFixedNminInput', -2.0e6),
    nmax: fixedNum('nmax', 'densityFixedNmaxInput',  2.0e6),
    mmin: fixedNum('mmin', 'densityFixedMminInput', -2.0e6),
    mmax: fixedNum('mmax', 'densityFixedMmaxInput',  2.0e6),
    lmin: fixedNum('lmin', 'densityFixedLminInput', -2.0e6),
    lmax: fixedNum('lmax', 'densityFixedLmaxInput',  2.0e6),
  };
}

async function accumulateAndExportGpuDensityCube(options = {}) {
  if (!rawParticles) {
    alert('GPU accumulation export needs the WebGPU (compute) particle path. It is not available in this session.');
    return;
  }

  const nFrames = Math.floor(gaNumber(options.nFrames, Number(gpuAccumFramesInput?.value || 200), 1, 100000));
  const gridN   = Math.floor(gaNumber(options.gridN,   Number(gpuAccumGridNInput?.value  || 64),  2, 1024));
  const { nmin, nmax, mmin, mmax, lmin, lmax } = gaResolveFixedBounds(options);

  const rn = nmax - nmin, rm = mmax - mmin, rl = lmax - lmin;
  const sceneToKm = 1 / (SCALE * 1000);
  const n3 = gridN * gridN * gridN;
  const counts = new Float64Array(n3);
  const gridN2 = gridN * gridN;

  const startJD = simulationTimeJD;
  const wasPaused = isPaused;
  if (wasPaused) isPaused = false; // let the live loop emit + integrate while we read back

  const btn = exportGpuAccumBtn;
  const oldText = btn?.textContent;
  let framesUsed = 0;
  let totalParticles = 0;

  try {
    for (let f = 0; f < nFrames; f++) {
      await gaNextFrame();
      const data = await rawParticles.readback();

      // Recompute the cometocentric (n,m,l) frame at the current epoch so the
      // quasi-steady tail stacks coherently across frames as the comet moves.
      const cs   = cometStateAtJD(simulationTimeJD);
      const cPos = [cs.r_scene.x, cs.r_scene.y, cs.r_scene.z];
      const cVel = [cs.v_scene_per_s.x, cs.v_scene_per_s.y, cs.v_scene_per_s.z];
      const m_hat = gaNorm(cPos);                       // radial
      const l_hat = gaNorm(gaCross(cPos, cVel));        // out-of-plane / normal
      const n_hat = gaNorm(gaCross(l_hat, m_hat));      // cross-tail / transverse

      for (let i = 0; i < maxUsed; i++) {
        const rem = data[i * 4 + 3];
        if (rem <= 0) continue; // expired / unused slot
        const dx = data[i*4]   - cPos[0];
        const dy = data[i*4+1] - cPos[1];
        const dz = data[i*4+2] - cPos[2];
        const nKm = (dx*n_hat[0] + dy*n_hat[1] + dz*n_hat[2]) * sceneToKm;
        const mKm = (dx*m_hat[0] + dy*m_hat[1] + dz*m_hat[2]) * sceneToKm;
        const lKm = (dx*l_hat[0] + dy*l_hat[1] + dz*l_hat[2]) * sceneToKm;

        const in_ = Math.floor(((nKm - nmin) / rn) * gridN);
        if (in_ < 0 || in_ >= gridN) continue;
        const im = Math.floor(((mKm - mmin) / rm) * gridN);
        if (im < 0 || im >= gridN) continue;
        const il = Math.floor(((lKm - lmin) / rl) * gridN);
        if (il < 0 || il >= gridN) continue;

        counts[in_ * gridN2 + im * gridN + il] += 1;
        totalParticles++;
      }

      framesUsed++;
      if (btn && (f % 4) === 0) btn.textContent = `Accumulating… ${Math.round(100 * (f + 1) / nFrames)}%`;
    }
  } finally {
    isPaused = wasPaused;
    if (btn) btn.textContent = oldText || 'Export GPU density cube (accumulated)';
  }

  const endJD = simulationTimeJD;

  // Average per-voxel occupancy across frames, then per-volume → relative
  // number density (the absolute scale is set by the emission rate, so this is
  // a normalized/shape quantity — matching the live-sim model, not calibrated).
  const voxVolKm3 = (rn / gridN) * (rm / gridN) * (rl / gridN);
  const rhoNum = new Float32Array(n3);
  const invF = framesUsed > 0 ? 1 / framesUsed : 0;
  for (let idx = 0; idx < n3; idx++) rhoNum[idx] = counts[idx] * invF / voxVolKm3;

  const makeEdges = (min, range) => {
    const e = new Float64Array(gridN + 1);
    for (let k = 0; k <= gridN; k++) e[k] = min + range * (k / gridN);
    return e;
  };

  const jdStr = startJD.toFixed(2);
  const stem = `gpu_density_cube_JD${jdStr}_${gridN}`;

  _download(_writeNpy(rhoNum, [gridN, gridN, gridN], '<f4'), `${stem}_rho_num.npy`, 'application/octet-stream');

  const meta = {
    format: 'comet-tail-gpu-accumulated-density-cube-v1',
    createdUTC: new Date().toISOString(),
    source: 'gpu-particle-buffer-readback',
    note: 'Accumulated readback of the actual WebGPU particle positions (leapfrog-integrated from the live emission model). RELATIVE number density (frame-averaged occupancy / voxel volume). Intrinsic cometocentric n/m/l frame, recomputed each frame.',
    normalized: true,
    accumulation: { framesRequested: nFrames, framesUsed, startJD, endJD, simDaysSpanned: endJD - startJD, totalParticleHits: totalParticles, maxParticlesGpu: rawParticles.max },
    shape: [gridN, gridN, gridN],
    axes: ['n_cross_tail_km (transverse)', 'm_along_tail_km (radial)', 'l_out_of_plane_km (normal)'],
    bounds_km: { nmin, nmax, mmin, mmax, lmin, lmax },
    voxelSize_km: { n: rn / gridN, m: rm / gridN, l: rl / gridN },
    n_edges_km: Array.from(makeEdges(nmin, rn)),
    m_edges_km: Array.from(makeEdges(mmin, rm)),
    l_edges_km: Array.from(makeEdges(lmin, rl)),
    ejection: { V0_mps: ejectionSpeedMps, gamma: ejectionGamma, kappa: ejectionKappa, expcos: ejectionExpcos },
    orbitalElements: { e, q_AU: q / AU, i_deg: i / DEG, Omega_deg: Omega / DEG, omega_deg: omega / DEG, t0_JD: t0 },
  };
  _download(JSON.stringify(meta, null, 2), `${stem}_meta.json`, 'application/json');

  console.log(`[GpuAccumDensity] ${stem}: ${framesUsed} frames, ${totalParticles.toExponential(3)} particle-hits, `
    + `sim span ${(endJD - startJD).toFixed(3)} d.`);
  return { stem, meta };
}

// ── One readback of the CURRENT GPU buffer, binned into a fresh counts cube ──
//
// For driving from a script: call window.headlessPropagate(jd) to build an
// INDEPENDENT realization of the tail at a fixed epoch (emission uses unseeded
// RNG, so each rebuild differs), then call this to bin that realization, then
// sum across rebuilds in the driver. This gives genuine high statistics at a
// FIXED epoch with NO temporal blurring — unlike playing frames forward, where
// consecutive readbacks are the same drifting particles. Returns plain arrays
// so it serializes cleanly back to Python via page.evaluate.
async function gpuDensitySnapshot(options = {}) {
  if (!rawParticles) throw new Error('WebGPU particle path unavailable (need a real browser).');
  const gridN = Math.floor(gaNumber(options.gridN, Number(gpuAccumGridNInput?.value || 64), 2, 1024));
  const { nmin, nmax, mmin, mmax, lmin, lmax } = gaResolveFixedBounds(options);
  const rn = nmax - nmin, rm = mmax - mmin, rl = lmax - lmin;
  const sceneToKm = 1 / (SCALE * 1000);
  const gridN2 = gridN * gridN;
  const counts = new Float64Array(gridN * gridN * gridN);

  const data = await rawParticles.readback();
  const cs   = cometStateAtJD(simulationTimeJD);
  const cPos = [cs.r_scene.x, cs.r_scene.y, cs.r_scene.z];
  const cVel = [cs.v_scene_per_s.x, cs.v_scene_per_s.y, cs.v_scene_per_s.z];
  const m_hat = gaNorm(cPos);
  const l_hat = gaNorm(gaCross(cPos, cVel));
  const n_hat = gaNorm(gaCross(l_hat, m_hat));

  let hits = 0;
  for (let i = 0; i < maxUsed; i++) {
    if (data[i * 4 + 3] <= 0) continue;
    const dx = data[i*4]   - cPos[0];
    const dy = data[i*4+1] - cPos[1];
    const dz = data[i*4+2] - cPos[2];
    const nKm = (dx*n_hat[0] + dy*n_hat[1] + dz*n_hat[2]) * sceneToKm;
    const mKm = (dx*m_hat[0] + dy*m_hat[1] + dz*m_hat[2]) * sceneToKm;
    const lKm = (dx*l_hat[0] + dy*l_hat[1] + dz*l_hat[2]) * sceneToKm;
    const in_ = Math.floor(((nKm - nmin) / rn) * gridN); if (in_ < 0 || in_ >= gridN) continue;
    const im  = Math.floor(((mKm - mmin) / rm) * gridN); if (im  < 0 || im  >= gridN) continue;
    const il  = Math.floor(((lKm - lmin) / rl) * gridN); if (il  < 0 || il  >= gridN) continue;
    counts[in_ * gridN2 + im * gridN + il] += 1;
    hits++;
  }

  return {
    gridN, hits, jd: simulationTimeJD,
    bounds_km: { nmin, nmax, mmin, mmax, lmin, lmax },
    counts: Array.from(counts),
  };
}
window.gpuDensitySnapshot = gpuDensitySnapshot;

exportGpuAccumBtn?.addEventListener('click', async () => {
  try {
    await accumulateAndExportGpuDensityCube();
  } catch (err) {
    console.error('[GpuAccumDensity] failed', err);
    alert(`GPU accumulation export failed: ${err?.message || err}`);
  }
});

window.accumulateAndExportGpuDensityCube = accumulateAndExportGpuDensityCube;
