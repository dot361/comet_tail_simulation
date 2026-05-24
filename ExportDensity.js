// ─── Particle density grid export (.npy + meta JSON) ─────────────────────────
//
// Coordinate frame: cometocentric, rotated to (n, m, l) in km:
//   m = anti-solar (Sun→Comet — along tail)
//   l = orbital north (r × v — out of orbital plane)
//   n = l × m (cross-tail, completes right-handed system)
//
// Use convert_to_cube.py to wrap this into the .npz that
// visualize_density_cube.py expects.

// ── NumPy .npy writer (version 1.0) ──────────────────────────────────────────
function _writeNpy(typedArray, shape, dtype) {
  const dictBody  = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape.join(', ')},), }`;
  const baseLen   = 11 + dictBody.length;
  const pad       = (64 - (baseLen % 64)) % 64;
  const headerStr = dictBody + ' '.repeat(pad) + '\n';
  const headerLen = headerStr.length;
  const buf       = new ArrayBuffer(10 + headerLen + typedArray.byteLength);
  const bytes     = new Uint8Array(buf);
  const dv        = new DataView(buf);
  bytes[0]=0x93; bytes[1]=0x4E; bytes[2]=0x55;
  bytes[3]=0x4D; bytes[4]=0x50; bytes[5]=0x59;
  bytes[6]=0x01; bytes[7]=0x00;
  dv.setUint16(8, headerLen, true);
  for (let i = 0; i < headerLen; i++) bytes[10 + i] = headerStr.charCodeAt(i);
  bytes.set(
    new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength),
    10 + headerLen
  );
  return new Uint8Array(buf);
}

function _download(data, filename, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Vector helpers ────────────────────────────────────────────────────────────
function _cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function _norm(v) {
  const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
  return l < 1e-30 ? [0,0,0] : [v[0]/l, v[1]/l, v[2]/l];
}

// ── Main export ───────────────────────────────────────────────────────────────
async function exportDensityGrid() {
  if (!isPaused) {
    console.warn('[ExportDensity] Pause the simulation before exporting.');
    return;
  }

  const gridN       = parseInt(document.getElementById('densityGridNInput')?.value) || 64;
  const maxAgeDays  = parseFloat(document.getElementById('densityMaxAgeInput')?.value || 0);
  const maxRadKm    = parseFloat(document.getElementById('densityMaxRadInput')?.value || 0);
  const maxAgeSec   = maxAgeDays > 0 ? maxAgeDays * SECONDS_PER_DAY : Infinity;
  const maxRadKm2   = maxRadKm > 0 ? maxRadKm * maxRadKm : Infinity; // compare squared
  const fullLifeSec = (baseLifetime ?? parseFloat(particleLifetimeInput?.value) ?? 250) * SECONDS_PER_DAY;
  const minRemainSec = maxAgeSec < Infinity ? Math.max(0, fullLifeSec - maxAgeSec) : 0;

  // ── Cometocentric (n, m, l) frame ─────────────────────────────────────────
  const cs   = cometStateAtJD(simulationTimeJD);
  const cPos = [cs.r_scene.x, cs.r_scene.y, cs.r_scene.z];
  const cVel = [cs.v_scene_per_s.x, cs.v_scene_per_s.y, cs.v_scene_per_s.z];

  const m_hat = _norm(cPos);                   // anti-solar (along tail)
  const l_hat = _norm(_cross(cPos, cVel));      // orbital north
  const n_hat = _norm(_cross(l_hat, m_hat));    // cross-tail

  const sceneToKm = 1 / (SCALE * 1000); // scene units → km

  // ── Collect live particle positions in cometocentric (n, m, l) km ─────────
  const coords = []; // flat [n0,m0,l0, n1,m1,l1, ...]

  if (rawParticles) {
    const data = await rawParticles.readback();
    for (let i = 0; i < maxUsed; i++) {
      const rem = data[i * 4 + 3];
      if (rem <= 0) continue;                  // dead
      if (rem < minRemainSec) continue;        // too old
      const dx = data[i*4]   - cPos[0];
      const dy = data[i*4+1] - cPos[1];
      const dz = data[i*4+2] - cPos[2];
      const dkm2 = (dx*dx + dy*dy + dz*dz) * sceneToKm * sceneToKm;
      if (dkm2 > maxRadKm2) continue;         // too far from nucleus
      coords.push(
        (dx*n_hat[0] + dy*n_hat[1] + dz*n_hat[2]) * sceneToKm,
        (dx*m_hat[0] + dy*m_hat[1] + dz*m_hat[2]) * sceneToKm,
        (dx*l_hat[0] + dy*l_hat[1] + dz*l_hat[2]) * sceneToKm
      );
    }
  } else {
    for (let i = 0; i < maxUsed; i++) {
      if (!cpuSlots[i] || expiryByIndex[i] <= simSeconds) continue;
      const remainSec = expiryByIndex[i] - simSeconds;
      if (remainSec < minRemainSec) continue;  // too old
      const s = cpuSlots[i];
      const { r } = keplerUniversalPropagate(s.r0_m, s.v0_mps,
        (simulationTimeJD - s.t0JD) * SECONDS_PER_DAY, s.mu);
      const dx = r.x * SCALE - cPos[0];
      const dy = r.y * SCALE - cPos[1];
      const dz = r.z * SCALE - cPos[2];
      const dkm2 = (dx*dx + dy*dy + dz*dz) * sceneToKm * sceneToKm;
      if (dkm2 > maxRadKm2) continue;         // too far from nucleus
      coords.push(
        (dx*n_hat[0] + dy*n_hat[1] + dz*n_hat[2]) * sceneToKm,
        (dx*m_hat[0] + dy*m_hat[1] + dz*m_hat[2]) * sceneToKm,
        (dx*l_hat[0] + dy*l_hat[1] + dz*l_hat[2]) * sceneToKm
      );
    }
  }

  const np = coords.length / 3;
  if (np === 0) { console.warn('[ExportDensity] No live particles found.'); return; }

  // ── Percentile-based bounds (1%–99%) with 5 % padding ────────────────────
  // Min/max is dominated by old particles (250-day lifetime, comet moved ~80°
  // in orbit) whose positions project hundreds of millions of km in the current
  // cross-tail frame. Percentile clipping keeps the dense region visible.
  const pctLo = parseFloat(document.getElementById('densityClipLoInput')?.value ?? 1);
  const pctHi = parseFloat(document.getElementById('densityClipHiInput')?.value ?? 99);

  function percentileBounds(arr, lo, hi) {
    const s = Float64Array.from(arr).sort();
    const iLo = Math.floor(lo / 100 * (s.length - 1));
    const iHi = Math.ceil (hi / 100 * (s.length - 1));
    return [s[iLo], s[iHi]];
  }

  const nArr = new Float64Array(np), mArr = new Float64Array(np), lArr = new Float64Array(np);
  for (let k = 0; k < np; k++) { nArr[k]=coords[k*3]; mArr[k]=coords[k*3+1]; lArr[k]=coords[k*3+2]; }

  let [nmin, nmax] = percentileBounds(nArr, pctLo, pctHi);
  let [mmin, mmax] = percentileBounds(mArr, pctLo, pctHi);
  let [lmin, lmax] = percentileBounds(lArr, pctLo, pctHi);

  const pad = 0.05;
  const pn=(nmax-nmin||1)*pad, pm=(mmax-mmin||1)*pad, pl=(lmax-lmin||1)*pad;
  nmin-=pn; nmax+=pn; mmin-=pm; mmax+=pm; lmin-=pl; lmax+=pl;
  const rn=nmax-nmin, rm=mmax-mmin, rl=lmax-lmin;

  // ── Bin into N³ grid: axis0=n, axis1=m, axis2=l ───────────────────────────
  const counts = new Float32Array(gridN * gridN * gridN);
  const n2 = gridN * gridN;
  for (let k = 0; k < np; k++) {
    const in_ = Math.floor(((coords[k*3]   - nmin) / rn) * gridN);
    const im  = Math.floor(((coords[k*3+1] - mmin) / rm) * gridN);
    const il  = Math.floor(((coords[k*3+2] - lmin) / rl) * gridN);
    if (in_<0||in_>=gridN||im<0||im>=gridN||il<0||il>=gridN) continue;
    counts[in_ * n2 + im * gridN + il] += 1;
  }

  // Normalise to number density (particles / km³)
  const voxVol = (rn/gridN) * (rm/gridN) * (rl/gridN);
  const rhoNum = new Float32Array(counts.length);
  for (let i = 0; i < counts.length; i++) rhoNum[i] = counts[i] / voxVol;

  // Edge arrays (N+1, float64) — bin boundaries in km
  function makeEdges(min, range) {
    const e = new Float64Array(gridN + 1);
    for (let i = 0; i <= gridN; i++) e[i] = min + range * (i / gridN);
    return e;
  }

  // ── Download rho_num.npy + meta JSON ──────────────────────────────────────
  const jdStr = simulationTimeJD.toFixed(2);
  const stem  = `density_cube_JD${jdStr}_${gridN}`;

  _download(
    _writeNpy(rhoNum, [gridN, gridN, gridN], '<f4'),
    `${stem}_rho_num.npy`,
    'application/octet-stream'
  );

  const meta = {
    stem,
    jd:               simulationTimeJD,
    gridN,
    particlesExported: np,
    maxParticleAgeDays: maxAgeDays || null,
    boundsClipPct:    { lo: pctLo, hi: pctHi },
    axes:             ['n_cross_tail_km', 'm_along_tail_km', 'l_out_of_plane_km'],
    note:             'grid[in, im, il] = rho_num (particles/km³). Bounds clipped to percentile range to exclude outlier old particles.',
    bounds_km:        { nmin, nmax, mmin, mmax, lmin, lmax },
    voxelSize_km:     { n: rn/gridN, m: rm/gridN, l: rl/gridN },
    n_edges_km:       Array.from(makeEdges(nmin, rn)),
    m_edges_km:       Array.from(makeEdges(mmin, rm)),
    l_edges_km:       Array.from(makeEdges(lmin, rl)),
    ejection: { V0_mps: ejectionSpeedMps, gamma: ejectionGamma, kappa: ejectionKappa, expcos: ejectionExpcos },
    orbitalElements:  { e, q_AU: q/AU, i_deg: i/DEG, Omega_deg: Omega/DEG, omega_deg: omega/DEG, t0_JD: t0 },
  };
  _download(
    JSON.stringify(meta, null, 2),
    `${stem}_meta.json`,
    'application/json'
  );

  console.log(`[ExportDensity] ${np} particles → ${gridN}³ (n,m,l) → ${stem}  [clip ${pctLo}%–${pctHi}%]`);
  console.log(`  n (cross-tail):   [${nmin.toFixed(0)}, ${nmax.toFixed(0)}] km  (${(rn/1e6).toFixed(2)} Mkm)`);
  console.log(`  m (along-tail):   [${mmin.toFixed(0)}, ${mmax.toFixed(0)}] km  (${(rm/1e6).toFixed(2)} Mkm)`);
  console.log(`  l (out-of-plane): [${lmin.toFixed(0)}, ${lmax.toFixed(0)}] km  (${(rl/1e6).toFixed(2)} Mkm)`);
}
