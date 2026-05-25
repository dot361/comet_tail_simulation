// ─── Date / time helpers ─────────────────────────────────────────────────────

function jdToDateString(jd) {
  const JD_UNIX_EPOCH_OFFSET = 2440587.5;
  const date = new Date((jd - JD_UNIX_EPOCH_OFFSET) * 86400000);
  return date.toISOString().split("T")[0];
}

function julianDayToDate(jd) {
  let Z = Math.floor(jd + 0.5);
  let F = (jd + 0.5) - Z;
  let A = Z;

  if (Z >= 2299161) {
    let alpha = Math.floor((Z - 1867216.25) / 36524.25);
    A += 1 + alpha - Math.floor(alpha / 4);
  }

  let B = A + 1524;
  let C = Math.floor((B - 122.1) / 365.25);
  let D = Math.floor(365.25 * C);
  let E = Math.floor((B - D) / 30.6001);

  let day   = B - D - Math.floor(30.6001 * E) + F;
  let month = (E < 14) ? E - 1 : E - 13;
  let year  = (month > 2) ? C - 4716 : C - 4715;

  let dayFraction  = day - Math.floor(day);
  let totalSeconds = Math.round(dayFraction * 86400);

  return {
    year,
    month,
    day:     Math.floor(day),
    hours:   Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60
  };
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function parseNum(v) {
  if (typeof v !== "string") return NaN;
  return Number(v.trim().replace(",", "."));
}

function parseVec3FromText(str) {
  if (typeof str !== "string") return null;
  const parts = str.trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const nums = parts.map(parseNum);
  if (!nums.every(Number.isFinite)) return null;
  return { x: nums[0], y: nums[1], z: nums[2] };
}

function parseNumberList(str) {
  if (!str || typeof str !== "string") return [];
  return str.split(",").map(s => parseFloat(s.trim())).filter(v => Number.isFinite(v));
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

function wrapDeg(deg) {
  deg = deg % 360;
  if (deg < 0) deg += 360;
  return deg;
}

function j2000ToSceneUnits(x, y, z, unit, AU, SCALE) {
  switch (unit) {
    case "AU":
      return new BABYLON.Vector3(x * AU * SCALE, y * AU * SCALE, z * AU * SCALE);
    case "km":
      return new BABYLON.Vector3(x * 1000 * SCALE, y * 1000 * SCALE, z * 1000 * SCALE);
    case "m":
    default:
      return new BABYLON.Vector3(x * SCALE, y * SCALE, z * SCALE);
  }
}

// Ecliptic → equatorial rotation (J2000 obliquity, uses _cE/_sE from Constants.js)
function eclToEq(v) {
  return new BABYLON.Vector3(
    v.x,
    v.y * _cE - v.z * _sE,
    v.y * _sE + v.z * _cE
  );
}


function eqToEcl(v) {
  return new BABYLON.Vector3(
    v.x,
    v.y * _cE + v.z * _sE,
   -v.y * _sE + v.z * _cE
  );
}

function raDecDegToEclipticDirection(raDeg, decDeg) {
  const ra  = raDeg * DEG;
  const dec = decDeg * DEG;
  const cDec = Math.cos(dec);
  const eq = new BABYLON.Vector3(
    cDec * Math.cos(ra),
    cDec * Math.sin(ra),
    Math.sin(dec)
  );
  return eqToEcl(eq).normalize();
}

function formatRaHours(raDeg) {
  let totalSeconds = ((raDeg / 15) % 24 + 24) % 24 * 3600;
  const h = Math.floor(totalSeconds / 3600);
  totalSeconds -= h * 3600;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${s.toFixed(1).padStart(4, "0")}s`;
}

function formatDecDeg(decDeg) {
  const sign = decDeg < 0 ? "-" : "+";
  let x = Math.abs(decDeg);
  const d = Math.floor(x);
  x = (x - d) * 60;
  const m = Math.floor(x);
  const s = (x - m) * 60;
  return `${sign}${String(d).padStart(2, "0")}° ${String(m).padStart(2, "0")}′ ${s.toFixed(1).padStart(4, "0")}″`;
}

function vecEqToRaDecDeg(vEq) {
  const u = vEq.normalize();
  let ra = Math.atan2(u.y, u.x) * 180 / Math.PI;
  if (ra < 0) ra += 360;
  const dec = Math.asin(u.z) * 180 / Math.PI;
  return { raDeg: ra, decDeg: dec };
}

function heliocentricSceneToRaDec(scenePos, earthScenePos) {
  const rhoEcl = scenePos.subtract(earthScenePos);
  return vecEqToRaDecDeg(eclToEq(rhoEcl));
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function csvEscape(v) {
  const s = String(v ?? "");
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function hsvToRgb(h, s, v) {
  let c = v * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if      (h < 1/6) { r=c; g=x; b=0; }
  else if (h < 2/6) { r=x; g=c; b=0; }
  else if (h < 3/6) { r=0; g=c; b=x; }
  else if (h < 4/6) { r=0; g=x; b=c; }
  else if (h < 5/6) { r=x; g=0; b=c; }
  else              { r=c; g=0; b=x; }
  return new BABYLON.Color3(r+m, g+m, b+m);
}

function colorFromUnit(u) {
  u = Math.max(0, Math.min(1, u));
  return hsvToRgb((1.0 - u) * 0.7, 1.0, 1.0);
}
