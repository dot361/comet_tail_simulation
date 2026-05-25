// ─── Physical / astronomical constants ───────────────────────────────────────
const AU = 1.495978707e11;
const SECONDS_PER_DAY = 86400;
const DEG = Math.PI / 180;
const SCALE = 1e-10;
const PLANET_SIZE_SCALE = 80;
const GMsun = 1.32712440018e20;
const MU_SCENE  = GMsun * Math.pow(SCALE, 3);

// Obliquity of the ecliptic (J2000.0)
const EPS_J2000 = 23.439291111 * DEG;
const _cE = Math.cos(EPS_J2000);
const _sE = Math.sin(EPS_J2000);

// ─── Simulation / particle system limits ─────────────────────────────────────
const ACTIVE_R_AU = 3.0;
const MAX_PARTICLES_GPU = 1_000_000;
const MAX_PARTICLES_CPU = 5_000;
const HARD_CAP = 4096;
const POINT_PX = 3.0;

// ─── UI timing ───────────────────────────────────────────────────────────────
const UI_PERIOD = 0.15;
const baseJD = 2451544.5;

// ─── Planet orbital elements (J2000.0 mean elements, degrees) ────────────────
// [name, a(AU), e, i(°), Ω(°), ϖ(°), L(°)]
const PLANET_ELTS_DEG = [
  ["Mercury",   0.387098,  0.205630,  7.00487,  48.33167,  77.45645, 252.25084],
  ["Venus",     0.723332,  0.006772,  3.39471,  76.68069, 131.53298, 181.97973],
  ["Earth",     1.000000,  0.016710,  0.00005, -11.26064, 102.94719, 100.46435],
  ["Mars",      1.523679,  0.093400,  1.85000,  49.55809, 286.50200, 355.45332],
  ["Jupiter",   5.20260,   0.048498,  1.30300, 100.55615,  14.75385,  34.40438],
  ["Saturn",    9.55490,   0.055508,  2.48900, 113.71504,  92.43194,  49.94432],
  ["Uranus",   19.21840,   0.046295,  0.77300,  74.00600, 170.96424, 313.23218],
  ["Neptune",  30.11039,   0.008988,  1.77000, 131.78400,  44.97135, 304.88003],
];

const PLANET_RADII_KM = {
  Mercury: 2439.7,
  Venus:   6051.8,
  Earth:   6371.0,
  Mars:    3389.5,
  Jupiter: 69911,
  Saturn:  58232,
  Uranus:  25362,
  Neptune: 24622
};
