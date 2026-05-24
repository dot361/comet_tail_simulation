// ─── UI wiring (speed, vis mode, orbit inputs, pause, shortcuts) ──────────────
// Globals: fpsCounter, particleCounter
// Functions: initUI, updateDiagnosticButtonState
// Call: initUI()

let fpsCounter, particleCounter;

function updateDiagnosticButtonState() {
  for (const btn of [synBtn, syndyneBtn, exportCSVBtn]) {
    if (!btn) continue;
    btn.disabled       = !isPaused;
    btn.style.opacity  = btn.disabled ? "0.5" : "1.0";
    btn.style.cursor   = btn.disabled ? "not-allowed" : "pointer";
  }
}

function initUI() {
  fpsCounter      = document.getElementById("fpsCounter");
  particleCounter = document.getElementById("particleCounter");

  // Speed slider
  const velocitySlider     = document.getElementById("velocitySlider");
  const velocityValueLabel = document.getElementById("velocityValue");
  velocitySlider.addEventListener("input", () => {
    simulationSpeed = 0.8 * Math.pow(2, parseInt(velocitySlider.value) / 4);
    velocityValueLabel.textContent = simulationSpeed.toFixed(2) + "×";
  });

  // Vis-mode dropdown
  visModeSelect?.addEventListener("change", () => { visMode = visModeSelect.value; });

  // Orbit / particle inputs trigger parameter rebuild
  [
    eccentricityInput, perihelionInput, inclinationInput,
    longitudeAscendingNodeInput, argumentPerihelionInput, perihelionDateInput,
    particleLifetimeInput, particleCountInput,
    ejectionSpeedInput, ejectionGammaInput, ejectionKappaInput, ejectionExpcosInput,
    activityExponentInput, activityScaleInput, activityHalfLifeInput
  ].forEach(input => {
    input.addEventListener("input", () => {
      window.switchToUser?.();
      updateOrbitParameters();
    });
  });

  // Pause button
  const pauseBtn = document.getElementById("pauseBtn");
  pauseBtn.addEventListener("click", () => {
    isPaused = !isPaused;
    pauseBtn.textContent = isPaused ? "Resume" : "Pause";
    updateTimelineUIState();
    updateDiagnosticButtonState();
    if (!isPaused && synchroneMeshes.length) {
      clearSynchrones();
      synchroneEpochJD = null;
      clearSyndynes();
      syndyneEpochJD = null;
    }
  });

  updateDiagnosticButtonState();

  // Keyboard shortcuts
  (function setupShortcuts() {
    function isTypingTarget(el) {
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    const velSlider = document.getElementById("velocitySlider");
    function nudgeSpeed(delta) {
      if (!velSlider) return;
      const min  = Number(velSlider.min  ?? -24);
      const max  = Number(velSlider.max  ??  24);
      const next = Math.max(min, Math.min(max, Number(velSlider.value || 0) + delta));
      if (next !== Number(velSlider.value)) {
        velSlider.value = String(next);
        velSlider.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    document.addEventListener("keydown", (ev) => {
      if (isTypingTarget(ev.target)) return;
      switch (ev.key) {
        case " ":
          ev.preventDefault();
          document.getElementById("pauseBtn")?.click();
          return;
        case "a": case "A":
          if (ev.shiftKey) { ev.preventDefault(); nudgeSpeed(-1); }
          return;
        case "d": case "D":
          if (ev.shiftKey) { ev.preventDefault(); nudgeSpeed(+1); }
          return;
        case "u": case "U":
          ev.preventDefault();
          document.getElementById("updateViewBtn")?.click();
          return;
        case "f": case "F":
          ev.preventDefault();
          setFocusOnComet(!isCameraFocused);
          return;
        case "x": case "X": ev.preventDefault(); setViewAxis("X"); return;
        case "y": case "Y": ev.preventDefault(); setViewAxis("Y"); return;
        case "z": case "Z": ev.preventDefault(); setViewAxis("Z"); return;
        case "o": case "O":
          ev.preventDefault();
          if (orbitLine) orbitLine.setEnabled(!orbitLine.isEnabled());
          else document.getElementById("toggleOrbitBtn")?.click();
          return;
        case "l": case "L":
          ev.preventDefault();
          if (isCamPosLocked && lockMode === "j2000") unlockCameraPosition();
          else lockCameraPositionToJ2000();
          return;
        case "e": case "E":
          ev.preventDefault();
          if (isCamPosLocked && lockMode === "earth") unlockCameraPosition();
          else lockCameraToEarth();
          return;
        case "g": case "G":
          ev.preventDefault();
          setAUGridVisible(!isAUGridVisible);
          return;
      }
    });
  })();
}
