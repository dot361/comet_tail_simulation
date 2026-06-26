// ─── Reproducible interactive benchmark helper ───────────────────────────────
// Usage after the simulation has started:
//   runCometBenchmark()
// Optional:
//   runCometBenchmark({ counts: [1000000, 2000000, 3000000], runs: 3 })

(function () {
  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function mean(values) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function downloadText(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function csvEscape(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function toCsv(result) {
    const rows = [];
    rows.push([
      "mode", "particles", "median_fps", "mean_fps", "frame_ms",
      "run1", "run2", "run3", "note"
    ]);
    for (const row of result.results) {
      rows.push([
        result.mode,
        row.particles,
        row.medianFps,
        row.meanFps,
        row.frameMs,
        row.runs[0] ?? "",
        row.runs[1] ?? "",
        row.runs[2] ?? "",
        row.note
      ]);
    }
    return rows.map(r => r.map(csvEscape).join(",")).join("\n");
  }

  async function getEnvironment() {
    let adapterInfo = null;
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        adapterInfo = adapter?.info || null;
      }
    } catch (e) {
      adapterInfo = { error: String(e) };
    }

    return {
      mode: rawParticles ? "WebGPU" : "CPU fallback",
      userAgent: navigator.userAgent,
      cpuLogicalThreads: navigator.hardwareConcurrency,
      babylonVersion: BABYLON?.Engine?.Version ?? null,
      renderWidth: engine?.getRenderWidth?.(true) ?? null,
      renderHeight: engine?.getRenderHeight?.(true) ?? null,
      monitorWidth: screen.width,
      monitorHeight: screen.height,
      devicePixelRatio: window.devicePixelRatio,
      webgpuComputeEnabled: window.__engineHasCompute ?? null,
      rawParticlesMax: rawParticles?.max ?? null,
      maxParticlesGpuConstant: typeof MAX_PARTICLES_GPU !== "undefined" ? MAX_PARTICLES_GPU : null,
      maxParticlesCpuConstant: typeof MAX_PARTICLES_CPU !== "undefined" ? MAX_PARTICLES_CPU : null,
      webgpuAdapterInfo: adapterInfo,
      timestamp: new Date().toISOString()
    };
  }

  function benchmarkParticle(i, n, lifeSeconds) {
    // Deterministic, non-random particle cloud near 1 AU in scene units.
    const phi = Math.PI * (3 - Math.sqrt(5));
    const theta = i * phi;
    const radius = 15.0 + 0.30 * Math.sin(i * 0.013);
    const z = 0.04 * Math.sin(i * 0.021);

    const pos = new BABYLON.Vector3(
      radius * Math.cos(theta),
      radius * Math.sin(theta),
      z
    );

    const speed = Math.sqrt(MU_SCENE / Math.max(radius, 1e-6));
    const vel = new BABYLON.Vector3(
      -speed * Math.sin(theta),
       speed * Math.cos(theta),
       0
    );

    const beta = 0.02 + 0.88 * ((i % 1000) / 999);
    return { pos, vel, lifeSeconds, beta };
  }

  async function seedBenchmarkParticles(requestedCount, options) {
    const lifeSeconds = options.lifeSeconds;
    const capacity = rawParticles ? rawParticles.max : cpuSlots.length;
    const count = Math.min(requestedCount, capacity);

    if (particleCountInput) particleCountInput.value = "0";
    window.emitCarry = 0;
    simSeconds = 0;
    gpuWriteCursor = 0;
    maxUsed = count;

    expiryByIndex.fill(0);
    betaByIndex.fill(0);
    birthJDByIndex.fill(simulationTimeJD ?? baseJD);
    lifeSecondsByIndex.fill(0);

    if (rawParticles) {
      if (typeof rawParticles.seedBulk === "function") {
        rawParticles.seedBulk(count, (i, n) => benchmarkParticle(i, n, lifeSeconds));
      } else {
        rawParticles.clear();
        for (let i = 0; i < count; i++) {
          const p = benchmarkParticle(i, count, lifeSeconds);
          rawParticles.seed(i, p.pos, p.vel, p.lifeSeconds, p.beta);
        }
      }
    } else {
      for (let i = 0; i < cpuSlots.length; i++) {
        cpuSlots[i] = null;
        if (particleMeshes[i]) particleMeshes[i].setEnabled(false);
      }
      for (let i = 0; i < count; i++) {
        const p = benchmarkParticle(i, count, lifeSeconds);
        const r0_m = p.pos.scale(1 / SCALE);
        const v0_mps = p.vel.scale(1 / SCALE);
        const mu = GMsun * Math.max(1 - p.beta, 0);
        cpuSlots[i] = { t0JD: simulationTimeJD ?? baseJD, r0_m, v0_mps, mu, lifeSeconds, beta: p.beta };
        const mesh = particleMeshes[i];
        if (mesh) {
          mesh.position.copyFrom(p.pos);
          mesh.setEnabled(true);
        }
      }
    }

    for (let i = 0; i < count; i++) {
      expiryByIndex[i] = lifeSeconds;
      betaByIndex[i] = 0.02 + 0.88 * ((i % 1000) / 999);
      birthJDByIndex[i] = simulationTimeJD ?? baseJD;
      lifeSecondsByIndex[i] = lifeSeconds;
    }

    if (rawParticles && engine?._device?.queue?.onSubmittedWorkDone) {
      await engine._device.queue.onSubmittedWorkDone();
    }

    return count;
  }

  async function measureFpsForCount(count, options) {
    const actualCount = await seedBenchmarkParticles(count, options);

    // Keep the simulation running so WebGPU update+render and CPU fallback work are included.
    isPaused = false;
    isHeadless = false;
    simulationSpeed = options.simulationSpeed;

    await wait(options.warmupSeconds * 1000);

    const runs = [];
    for (let run = 0; run < options.runs; run++) {
      let frames = 0;
      const observer = scene.onAfterRenderObservable.add(() => { frames++; });
      const t0 = performance.now();
      await wait(options.measureSeconds * 1000);
      const t1 = performance.now();
      scene.onAfterRenderObservable.remove(observer);

      const fps = frames / ((t1 - t0) / 1000);
      runs.push(fps);
      await wait(500);
    }

    const med = median(runs);
    return {
      particles: actualCount,
      requestedParticles: count,
      runs,
      medianFps: med,
      meanFps: mean(runs),
      frameMs: 1000 / med,
      note: med > 58 ? "v-sync limited / refresh-rate limited" : "below refresh limit"
    };
  }

  window.runCometBenchmark = async function runCometBenchmark(userOptions = {}) {
    if (typeof scene === "undefined" || typeof engine === "undefined") {
      throw new Error("Start the simulation first, then run runCometBenchmark().");
    }

    const mode = rawParticles ? "WebGPU" : "CPU fallback";
    const capacity = rawParticles ? rawParticles.max : cpuSlots.length;

    const defaultCounts = rawParticles
      ? [5_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]
      : [1_000, 2_500, 5_000];

    const options = {
      counts: defaultCounts.filter(c => c <= capacity),
      runs: 5,
      warmupSeconds: 5,
      measureSeconds: 20,
      simulationSpeed: 3600,
      lifeSeconds: 50 * 365.25 * 86400,
      ...userOptions
    };

    if (!options.counts.length) {
      throw new Error(`No benchmark counts fit the current particle capacity (${capacity}).`);
    }

    const environment = await getEnvironment();
    console.log("Benchmark environment:");
    console.table(environment);
    console.log(`Running ${mode} benchmark for counts:`, options.counts);

    const results = [];
    for (const count of options.counts) {
      console.log(`Benchmarking ${count.toLocaleString()} particles...`);
      const row = await measureFpsForCount(count, options);
      console.table([row]);
      results.push(row);
    }

    const result = { mode, environment, options, results };
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const safeMode = mode.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    downloadText(`benchmark_results_${safeMode}_${timestamp}.json`, JSON.stringify(result, null, 2), "application/json");
    downloadText(`benchmark_results_${safeMode}_${timestamp}.csv`, toCsv(result), "text/csv");

    console.log("Benchmark complete:", result);
    return result;
  };

  console.log("Comet benchmark helper loaded. Start the simulation, then run: runCometBenchmark()");
})();
