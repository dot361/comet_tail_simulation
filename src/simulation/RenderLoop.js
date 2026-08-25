// ─── Render loop ─────────────────────────────────────────────────────────────

function startRenderLoop() {
  const statusAnnouncer = document.getElementById("simulationStatusAnnouncer");
  let accessibilityStatusAccum = 0;

  if (rawParticles) {
    scene.onAfterRenderObservable.add(() => {
      if (isHeadless) return;
      const dtSeconds = isPaused ? 0 : (engine.getDeltaTime() / 1000) * simulationSpeed;
      const vpF32     = new Float32Array(scene.getTransformMatrix().m);
      const cs        = cometStateAtJD(simulationTimeJD);
      rawParticles.update(
        dtSeconds,
        Math.max(1, maxUsed),
        vpF32,
        cs.v_scene_per_s,
        cs.r_scene,
        { baseLifetime, visMode, distVisMaxScene, vRelMax_scene }
      );
    });
  }

  engine.runRenderLoop(() => {
    if (!isPaused) {
      const dtSeconds = (engine.getDeltaTime() / 1000) * simulationSpeed;
      simSeconds += dtSeconds;

      const dtDays  = dtSeconds / SECONDS_PER_DAY;
      const rAU_now = Math.max(1e-3, cometMesh.position.length() / (SCALE * AU));

      if (rAU_now <= ACTIVE_R_AU) {
        cumulativeExposure += dtDays / (rAU_now * rAU_now);
      }

      const ageFactor = Math.exp(-Math.LN2 * (cumulativeExposure / Math.max(1e-6, fadeHalfLifeEDays)));

      simulationTimeJD += dtDays;
      window.simulationTimeJD = simulationTimeJD;

      uiAccum += engine.getDeltaTime() / 1000;
      if (uiAccum >= UI_PERIOD) {
        timelineSlider.value = Math.floor(simulationTimeJD - baseJD);
        timelineLabel.textContent = `Date: ${jdToDateString(simulationTimeJD)}`;
        updateTimeDisplay(simulationTimeJD);
        fpsCounter.textContent = "FPS: " + engine.getFps().toFixed(0);

        if (hasCompute) {
          let active = 0;
          for (let k = 0; k < maxUsed; k++) { if (expiryByIndex[k] > simSeconds) active++; }
          particleCounter.textContent = "Particles (GPU): " + active;
        } else {
          let active = 0;
          for (let k = 0; k < maxUsed; k++) { if (expiryByIndex[k] > simSeconds && cpuSlots[k]) active++; }
          particleCounter.textContent = "Particles (CPU): " + active;
        }
        uiAccum = 0;
      }

      const cs_now        = cometStateAtJD(simulationTimeJD);
      const cometVel_scene = cs_now.v_scene_per_s;
      const cometVel_mps   = cometVel_scene.scale(1 / SCALE);
      cometMesh.position.copyFrom(cs_now.r_scene);

      const rAU  = cometMesh.position.length() / (SCALE * AU);
      const rSafe = Math.max(1e-3, rAU);
      const Q    = Math.max(0, activityK) * ageFactor / Math.pow(rSafe, Math.max(0, activityN));
      const scale = Math.min(1, Q);

      const PARTICLES_PER_SIM_DAY_AT_1_AU = Math.max(0, parseFloat(particleCountInput.value) || 0);
      const targetThisFrame = PARTICLES_PER_SIM_DAY_AT_1_AU * scale * dtDays;

      const boxQ     = document.getElementById("actBoxQ");
      const boxDecay = document.getElementById("actBoxDecay");
      if (boxQ)     boxQ.textContent     = `Q: ${Q.toFixed(3)}`;
      if (boxDecay) boxDecay.textContent = `decay: ${(ageFactor * 100).toFixed(1)}%`;

      accessibilityStatusAccum += engine.getDeltaTime() / 1000;
      if (statusAnnouncer && accessibilityStatusAccum >= 5) {
        statusAnnouncer.textContent = [
          boxQ?.textContent,
          boxDecay?.textContent,
          particleCounter?.textContent,
          fpsCounter?.textContent
        ].filter(Boolean).join("; ");
        accessibilityStatusAccum = 0;
      }

      window.emitCarry = (typeof window.emitCarry !== "undefined") ? window.emitCarry : 0;
      window.emitCarry += targetThisFrame;
      let births = Math.floor(window.emitCarry);
      window.emitCarry -= births;
      if (births > HARD_CAP) births = HARD_CAP;

      if (births > 0) {
        const emitJD = simulationTimeJD - (dtSeconds / SECONDS_PER_DAY);
        for (let k = 0; k < births; k++) createTailParticle(emitJD);
      }

      while (tailParticles.length &&
        (simulationTimeJD - tailParticles[0].t0JD) > tailParticles[0].lifetimeDays) {
        tailParticles.shift();
      }

      if (!useCompute) {
        for (let k = 0; k < maxUsed; k++) {
          const alive = (expiryByIndex[k] > simSeconds) && cpuSlots[k];
          const mesh  = particleMeshes[k];
          if (!alive) { if (mesh.isEnabled()) mesh.setEnabled(false); continue; }

          const slot = cpuSlots[k];
          const dt   = (simulationTimeJD - slot.t0JD) * SECONDS_PER_DAY;

          let rScene, v_mps;
          if (dt <= 0) {
            rScene = slot.r0_m.scale(SCALE);
            v_mps  = slot.v0_mps;
          } else if (slot.mu === 0) {
            rScene = slot.r0_m.add(slot.v0_mps.scale(dt)).scale(SCALE);
            v_mps  = slot.v0_mps;
          } else {
            const rv = keplerUniversalPropagate(slot.r0_m, slot.v0_mps, dt, slot.mu);
            rScene   = rv.r.scale(SCALE);
            v_mps    = rv.v;
          }

          mesh.position.copyFrom(rScene);

          const lifeLeft = Math.max(0, expiryByIndex[k] - simSeconds);
          const lifeFrac = Math.max(0, Math.min(1, lifeLeft / slot.lifeSeconds));
          if (mesh.material) mesh.material.alpha = 0.5 * lifeFrac;

          if (mesh.material) {
            switch (visMode) {
              case 'beta': {
                const u = Math.pow(Math.max(0, Math.min(1, slot.beta ?? 0)), 0.6);
                mesh.material.emissiveColor = colorFromUnit(u);
                break;
              }
              case 'age': {
                const age = 1 - lifeFrac;
                mesh.material.emissiveColor = new BABYLON.Color3(1 - age, 0, age);
                break;
              }
              case 'dist': {
                const d = BABYLON.Vector3.Distance(mesh.position, cometMesh.position);
                const u = Math.min(1, Math.max(0, d / Math.max(distVisMaxScene, 1e-6)));
                mesh.material.emissiveColor = new BABYLON.Color3(
                  1.0 + (0.10 - 1.0) * u,
                  0.95 + (0.20 - 0.95) * u,
                  0.20 + (1.00 - 0.20) * u
                );
                break;
              }
              case 'vrel': {
                const dv = v_mps.subtract(cometVel_mps).length();
                const u  = Math.min(1, Math.max(0, dv / (vRelMax_kms * 1000)));
                mesh.material.emissiveColor = colorFromUnit(u);
                break;
              }
              default:
                mesh.material.emissiveColor = new BABYLON.Color3(1, 1, 1);
            }
          }

          if (!mesh.isEnabled()) mesh.setEnabled(true);
        }
      }

      for (const p of planets) {
        p.mesh.position.copyFrom(getPlanetPosition(simulationTimeJD, p.el));
      }
      earthMesh.position.copyFrom(getPlanetPosition(simulationTimeJD, earthEl));
    }

    scene.render();
  });
}
