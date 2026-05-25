
// ─── Comet preset loader ─────────────────────────────────────────────────────

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function loadComet(id) {
  const pack = window.COMETS?.[id];
  if (!pack) {
    console.warn(`[CometSim] Unknown comet preset: ${id}`);
    return;
  }

  window.currentPresetId = id;

  const nowJD = window.simulationTimeJD ?? (pack.solutions[0]?.T ?? 2451544.5);
  const sol = window.pickSolutionForJD(pack.solutions, nowJD);
  if (!sol) return;

  setInputValue("eccentricityInput", sol.e);
  setInputValue("perihelionInput", sol.q);
  setInputValue("inclinationInput", sol.i);
  setInputValue("longitudeAscendingNodeInput", sol.omega);
  setInputValue("argumentPerihelionInput", sol.w);
  setInputValue("perihelionDateInput", sol.T);

  window.updateOrbitParameters?.();

  const daysBeforePerihelion = 400;
  const jdStart = sol.T - daysBeforePerihelion;
  window.setSimTime?.(jdStart, {
    resetParticles: true,
    focus: !window._skipInitialFocus
  });

  window._skipInitialFocus = false;
  window.switchToPreset?.(pack.displayName || id);
}

window.loadComet = loadComet;
