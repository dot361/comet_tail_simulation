
(function () {
  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function mean(values) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  function quantile(values, q) {
    const s = [...values].sort((a, b) => a - b);
    if (!s.length) return NaN;
    const x = (s.length - 1) * q;
    const lo = Math.floor(x);
    const hi = Math.ceil(x);
    if (lo === hi) return s[lo];
    return s[lo] + (s[hi] - s[lo]) * (x - lo);
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
      runs: 3,
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
    downloadText(`comet_benchmark_json.json`, JSON.stringify(result, null, 2), "application/json");
    downloadText(`comet_benchmark_csv.csv`, toCsv(result), "text/csv");

    console.log("Benchmark complete:", result);
    return result;
  };

  async function waitForCompletedGpuWork() {
    const queue = engine?._device?.queue;
    if (!queue?.onSubmittedWorkDone) {
      throw new Error("The completed-work benchmark requires a WebGPU queue with onSubmittedWorkDone().");
    }
    await queue.onSubmittedWorkDone();
  }

  function completedWorkSummary(frameTimesMs) {
    const med = median(frameTimesMs);
    const q25 = quantile(frameTimesMs, 0.25);
    const q75 = quantile(frameTimesMs, 0.75);
    return {
      medianFrameMs: med,
      meanFrameMs: mean(frameTimesMs),
      q25FrameMs: q25,
      q75FrameMs: q75,
      iqrFrameMs: q75 - q25,
      medianCompletedFps: 1000 / med,
      meanCompletedFps: 1000 / mean(frameTimesMs),
    };
  }

  function setBenchmarkInput(id, value) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Benchmark input not found: ${id}`);
    element.value = String(value);
  }

  function applyTailRebuildScenario(options) {
    if (typeof window.loadComet === "function") window.loadComet(options.cometId);

    setBenchmarkInput("particleLifetimeInput", options.historyDays);
    setBenchmarkInput("particleCountInput", options.particlesPerDay);
    setBenchmarkInput("ejectionSpeedInput", options.ejectionSpeedMps);
    setBenchmarkInput("ejectionGammaInput", options.ejectionGamma);
    setBenchmarkInput("ejectionKappaInput", options.ejectionKappa);
    setBenchmarkInput("ejectionExpcosInput", options.ejectionExpcos);
    setBenchmarkInput("activityExponentInput", options.activityExponent);
    setBenchmarkInput("activityScaleInput", options.activityScale);
    setBenchmarkInput("activityHalfLifeInput", options.activityHalfLifeEDays);
    updateOrbitParameters();
    setSimTime(options.targetJD, { resetParticles: true, focus: false });
  }

  async function waitForOneDisplayedTailFrame() {
    await new Promise(resolve => scene.onAfterRenderObservable.addOnce(resolve));
    await waitForCompletedGpuWork();
  }

  /**
   * Time the real fixed-epoch tail rebuild path, including stochastic emission,
   * WebGPU buffer writes, all compute dispatches, GPU completion, and the first
   * completed frame that displays the rebuilt particle population.
   */
  window.runTailRebuildBenchmark = async function runTailRebuildBenchmark(userOptions = {}) {
    if (!rawParticles || !(engine instanceof BABYLON.WebGPUEngine)) {
      throw new Error("The tail-rebuild benchmark requires the WebGPU particle path.");
    }
    if (window.__completedWorkBenchmarkOwnsLoop) {
      throw new Error("Run the tail-rebuild benchmark before the fixed-frame benchmark stops the normal render loop.");
    }

    const options = {
      scenarioName: "67P_2021-09-06_appendixA_history_and_rate",
      cometId: "67P",
      targetJD: 2459463.5,
      historyDays: 300,
      particlesPerDay: 16_500,
      dtDays: 0.1,
      runs: 5,
      cooldownMs: 1000,
      renderWidth: 1920,
      renderHeight: 1080,
      ejectionSpeedMps: 14,
      ejectionGamma: 0.19,
      ejectionKappa: -0.14,
      ejectionExpcos: 2.18,
      activityExponent: 2.35,
      activityScale: 1,
      activityHalfLifeEDays: 1500,
      ...userOptions,
    };

    for (const key of ["runs", "historyDays", "particlesPerDay", "dtDays"]) {
      if (!Number.isFinite(options[key]) || options[key] <= 0) {
        throw new Error(`${key} must be positive.`);
      }
    }
    if (!Number.isInteger(options.runs)) throw new Error("runs must be an integer.");

    engine.setSize(options.renderWidth, options.renderHeight);
    rawParticles.resize();
    applyTailRebuildScenario(options);
    await waitForCompletedGpuWork();

    const environment = await getEnvironment();
    environment.pointSizePx = typeof POINT_PX !== "undefined" ? POINT_PX : null;
    const runs = [];

    for (let run = 0; run < options.runs; run++) {
      applyTailRebuildScenario(options);
      await waitForCompletedGpuWork();
      const start = performance.now();
      const rebuild = await headlessPropagate(options.targetJD, {
        dtDays: options.dtDays,
        collectMetrics: true,
        waitForGpu: true,
      });
      await waitForOneDisplayedTailFrame();
      const elapsedMs = performance.now() - start;

      const sample = {
        run: run + 1,
        elapsedMs,
        elapsedSeconds: elapsedMs / 1000,
        ...rebuild,
        valid: rebuild.completed && rebuild.hardCapClippedBirths === 0 && rebuild.capacityDroppedBirths === 0,
      };
      runs.push(sample);
      console.log(
        `[tail-rebuild] run ${run + 1}/${options.runs}: ${(elapsedMs / 1000).toFixed(3)} s, ` +
        `${rebuild.finalActiveParticles} active, ${rebuild.hardCapClippedBirths} clipped, ` +
        `${rebuild.capacityDroppedBirths} capacity-dropped`
      );
      if (options.cooldownMs > 0) await wait(options.cooldownMs);
    }

    const elapsedValues = runs.map(run => run.elapsedSeconds);
    const q25 = quantile(elapsedValues, 0.25);
    const q75 = quantile(elapsedValues, 0.75);
    const result = {
      benchmark: "completed fixed-epoch tail rebuild latency",
      timingBoundary: "idle GPU before rebuild -> emission and propagation -> idle GPU -> first completed displayed tail frame",
      scenario: options.scenarioName,
      environment,
      options,
      runs,
      summary: {
        medianSeconds: median(elapsedValues),
        meanSeconds: mean(elapsedValues),
        q25Seconds: q25,
        q75Seconds: q75,
        iqrSeconds: q75 - q25,
        allRunsValid: runs.every(run => run.valid),
        medianFinalActiveParticles: median(runs.map(run => run.finalActiveParticles)),
        medianAcceptedBirths: median(runs.map(run => run.acceptedBirths)),
        medianParticleStepUpdates: median(runs.map(run => run.particleStepUpdates)),
      },
      timestamp: new Date().toISOString(),
    };
    console.log("[tail-rebuild] result", result);
    return result;
  };

  async function submitCompletedWorkFrames(mode, frameCount, maxInFlightFrames, fixedDtSeconds) {
    let submitted = 0;
    while (submitted < frameCount) {
      const chunk = Math.min(maxInFlightFrames, frameCount - submitted);

      for (let frame = 0; frame < chunk; frame++) {
        if (mode === "compute_only") {
          rawParticles.computeOnly(fixedDtSeconds, maxUsed);
          continue;
        }

        // Render the same two canvases used by the interactive application:
        // Babylon.js first, followed by the raw WebGPU particle overlay.  The
        // normal onAfterRender particle callback is disabled by isHeadless.
        engine.beginFrame();
        scene.render();

        const viewProjection = new Float32Array(scene.getTransformMatrix().m);
        const cometState = cometStateAtJD(simulationTimeJD);
        rawParticles.update(
          fixedDtSeconds,
          Math.max(1, maxUsed),
          viewProjection,
          cometState.v_scene_per_s,
          cometState.r_scene,
          { baseLifetime, visMode, distVisMaxScene, vRelMax_scene }
        );
        engine.endFrame();
      }

      // Bound the queue depth. This prevents a long test from measuring only
      // JavaScript command submission or accumulating thousands of unfinished
      // frames. The timer includes every one of these completion waits.
      await waitForCompletedGpuWork();
      submitted += chunk;
    }
  }

  /**
   * Measure completed WebGPU work for a fixed number of frames.
   *
   * This is intentionally separate from runCometBenchmark(), whose wall-clock
   * frame counter is useful interactively but can get ahead of asynchronous GPU
   * execution. The Playwright runner in validation/performance calls this once
   * per particle-count/mode pair and saves each result immediately.
   */
  window.runCompletedWorkBenchmark = async function runCompletedWorkBenchmark(userOptions = {}) {
    if (!rawParticles || !(engine instanceof BABYLON.WebGPUEngine)) {
      throw new Error("The completed-work benchmark requires the WebGPU particle path.");
    }

    const options = {
      count: 1_000_000,
      mode: "update_render",
      runs: 10,
      framesPerRun: 1000,
      warmupFrames: 240,
      maxInFlightFrames: 240,
      fixedDtSeconds: 60,
      renderWidth: 1920,
      renderHeight: 1080,
      cooldownMs: 250,
      lifeSeconds: 50 * 365.25 * 86400,
      ...userOptions,
    };

    if (!["compute_only", "update_render"].includes(options.mode)) {
      throw new Error(`Unknown benchmark mode: ${options.mode}`);
    }
    for (const key of ["count", "runs", "framesPerRun", "maxInFlightFrames"]) {
      if (!Number.isInteger(options[key]) || options[key] < 1) {
        throw new Error(`${key} must be a positive integer.`);
      }
    }
    if (!Number.isFinite(options.fixedDtSeconds) || options.fixedDtSeconds <= 0) {
      throw new Error("fixedDtSeconds must be positive.");
    }
    if (options.count > rawParticles.max) {
      throw new Error(`Requested ${options.count} particles but the GPU buffer capacity is ${rawParticles.max}.`);
    }

    // Take exclusive control of frame submission. No normal requestAnimationFrame
    // callbacks are restarted because the automation closes this page after the
    // benchmark. This also prevents background UI work from entering a batch.
    if (!window.__completedWorkBenchmarkOwnsLoop) {
      engine.stopRenderLoop();
      isPaused = true;
      isHeadless = true;
      window.__completedWorkBenchmarkOwnsLoop = true;
      await waitForCompletedGpuWork();
    }

    engine.setSize(options.renderWidth, options.renderHeight);
    rawParticles.resize();
    await waitForCompletedGpuWork();

    const actualCount = await seedBenchmarkParticles(options.count, options);
    const environment = await getEnvironment();
    environment.pointSizePx = typeof POINT_PX !== "undefined" ? POINT_PX : null;

    console.log(
      `[completed-work] warm-up: mode=${options.mode}, particles=${actualCount}, frames=${options.warmupFrames}`
    );
    if (options.warmupFrames > 0) {
      await submitCompletedWorkFrames(
        options.mode,
        options.warmupFrames,
        options.maxInFlightFrames,
        options.fixedDtSeconds
      );
    }

    const runs = [];
    for (let run = 0; run < options.runs; run++) {
      await waitForCompletedGpuWork();
      const start = performance.now();
      await submitCompletedWorkFrames(
        options.mode,
        options.framesPerRun,
        options.maxInFlightFrames,
        options.fixedDtSeconds
      );
      const elapsedMs = performance.now() - start;
      const frameMs = elapsedMs / options.framesPerRun;
      const sample = {
        run: run + 1,
        elapsedMs,
        completedFrames: options.framesPerRun,
        frameMs,
        completedFps: 1000 / frameMs,
      };
      runs.push(sample);
      console.log(
        `[completed-work] ${options.mode} ${actualCount} run ${run + 1}/${options.runs}: ` +
        `${frameMs.toFixed(4)} ms/frame (${sample.completedFps.toFixed(2)} completed FPS)`
      );
      if (options.cooldownMs > 0) await wait(options.cooldownMs);
    }

    const summary = completedWorkSummary(runs.map(run => run.frameMs));
    const result = {
      benchmark: "fixed-frame completed WebGPU work",
      timingBoundary: "queue idle -> fixed submissions with bounded queue depth -> queue idle",
      mode: options.mode,
      particles: actualCount,
      environment,
      options,
      runs,
      summary,
      timestamp: new Date().toISOString(),
    };
    console.log("[completed-work] result", result);
    return result;
  };

  console.log(
    "Comet benchmark helpers loaded. Start the simulation, then run runCometBenchmark() " +
    "runTailRebuildBenchmark(), or runCompletedWorkBenchmark()."
  );
})();
