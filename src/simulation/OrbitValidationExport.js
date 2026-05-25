
// ─── Orbit validation export ─────────────────────────────────────────────────

function sceneVectorToAU(vScene) {
  return {
    x_AU: vScene.x / (SCALE * AU),
    y_AU: vScene.y / (SCALE * AU),
    z_AU: vScene.z / (SCALE * AU)
  };
}

function getCurrentOrbitElementsForValidation() {
  return {
    e,
    q_AU: q / AU,
    i_deg: i / DEG,
    Omega_deg: Omega / DEG,
    omega_deg: omega / DEG,
    t0_JD: t0
  };
}

function exportOrbitValidationSamples({
  caseName = "orbit_case",
  horizonsId = "",
  nPoints = 1000,
  spanDays = 180
} = {}) {
  if (!Number.isFinite(nPoints) || nPoints < 2) {
    console.error("[Orbit validation] nPoints must be at least 2.");
    return;
  }

  if (!Number.isFinite(spanDays) || spanDays <= 0) {
    console.error("[Orbit validation] spanDays must be positive.");
    return;
  }

  const el = getCurrentOrbitElementsForValidation();

  const rows = [];
  rows.push([
    "case",
    "horizons_id",
    "index",
    "n_points",
    "span_days",
    "dt_days",
    "jd_tdb",
    "e",
    "q_AU",
    "i_deg",
    "Omega_deg",
    "omega_deg",
    "t0_JD",
    "sim_x_AU",
    "sim_y_AU",
    "sim_z_AU",
    "sim_rh_AU"
  ]);

  for (let k = 0; k < nPoints; k++) {
    const u = k / (nPoints - 1);
    const dtDays = -spanDays + 2 * spanDays * u;
    const jd = t0 + dtDays;

    const cs = cometStateAtJD(jd);
    const posAU = sceneVectorToAU(cs.r_scene);

    rows.push([
      caseName,
      horizonsId,
      k,
      nPoints,
      spanDays,
      dtDays.toFixed(10),
      jd.toFixed(10),
      el.e.toFixed(15),
      el.q_AU.toFixed(15),
      el.i_deg.toFixed(15),
      el.Omega_deg.toFixed(15),
      el.omega_deg.toFixed(15),
      el.t0_JD.toFixed(10),
      posAU.x_AU.toFixed(15),
      posAU.y_AU.toFixed(15),
      posAU.z_AU.toFixed(15),
      cs.rh_AU.toFixed(15)
    ]);
  }

  const filename = `${caseName}_sim_${nPoints}_positions.csv`;
  downloadCSV(filename, rows);

  console.log(`[Orbit validation] Exported ${nPoints} samples to ${filename}`);
  console.table({ caseName, horizonsId, nPoints, spanDays, t0_JD: el.t0_JD, eccentricity: el.e, q_AU: el.q_AU });
}

function exportCurrentPresetValidationSamples() {
  const presetId = window.currentPresetId;
  const preset = window.COMETS?.[presetId];
  if (!preset?.validation) {
    console.warn("[Orbit validation] No validation metadata for current preset.");
    return;
  }

  exportOrbitValidationSamples({
    caseName: preset.validation.caseName,
    horizonsId: preset.horizonsId || presetId,
    nPoints: preset.validation.nPoints || 1000,
    spanDays: preset.validation.spanDays || 180
  });
}

window.sceneVectorToAU = sceneVectorToAU;
window.exportOrbitValidationSamples = exportOrbitValidationSamples;
window.exportCurrentPresetValidationSamples = exportCurrentPresetValidationSamples;
