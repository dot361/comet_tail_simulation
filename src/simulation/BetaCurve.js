
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t*t, t3 = t2*t;
  return 0.5*((2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t2 + (-p0+3*p1-3*p2+p3)*t3);
}

function sampleCurve(pts, t) {
  const P  = pts.slice().sort((a,b)=>a.x-b.x);
  const xs = P.map(p=>p.x), ys = P.map(p=>p.y);
  const x  = Math.min(1, Math.max(0, t));

  if (x <= xs[0]) return { x, y: Math.max(0, Math.min(1, ys[0])) };
  if (x >= xs[xs.length-1]) return { x, y: Math.max(0, Math.min(1, ys[ys.length-1])) };

  let i = 1;
  while (i < xs.length-1 && xs[i] < x) i++;
  const i0 = Math.max(0, i-2), i1 = i-1, i2 = i, i3 = Math.min(xs.length-1, i+1);
  const u  = (xs[i2] === xs[i1]) ? 0 : (x - xs[i1]) / (xs[i2] - xs[i1]);
  const y  = catmullRom(ys[i0], ys[i1], ys[i2], ys[i3], Math.min(1, Math.max(0, u)));
  return { x, y: Math.max(0, Math.min(1, y)) };
}

function valueAt(x, pts = betaUI.pts) {
  const P  = pts.slice().sort((a,b)=>a.x-b.x);
  const xs = P.map(p=>p.x), ys = P.map(p=>p.y);

  if (x < xs[0] || x > xs[xs.length-1]) return null;

  let i = 1;
  while (i < xs.length-1 && xs[i] < x) i++;
  const i0 = Math.max(0, i-2), i1 = i-1, i2 = i, i3 = Math.min(xs.length-1, i+1);
  const u  = (xs[i2] === xs[i1]) ? 0 : (x - xs[i1]) / (xs[i2] - xs[i1]);
  return Math.max(0, Math.min(1, catmullRom(ys[i0], ys[i1], ys[i2], ys[i3], Math.min(1, Math.max(0, u)))));
}

function makeExpPts() {
  const k = 2.2;
  const f = (x) => (Math.exp(k * x) - 1) / (Math.exp(k) - 1);
  return [0.00, 0.33, 0.66, 1.00].map(x => ({ x, y: f(x) }));
}

// ─── State ────────────────────────────────────────────────────────────────────

const betaUI = {
  canvas:     document.getElementById('betaCurveCanvas'),
  resetBtn:   document.getElementById('betaCurveReset'),
  gridToggle: document.getElementById('betaCurveGridToggle'),
  tipEl:      document.getElementById('betaCurveTip'),
  ctx:        null,
  pts:        makeExpPts(),
  dragging:   -1,
  R:          9,
  grid:       true,
  pdf:        new Float32Array(512),
  cdf:        new Float32Array(512),
  enabled:    true,
  pad:        { l: 44, r: 14, t: 16, b: 36 },
  dpr:        Math.max(1, Math.min(2.5, window.devicePixelRatio || 1)),
};

betaUI.domain = { x0: 0, xn: 1 };

// ─── Plot coordinate helpers ──────────────────────────────────────────────────

function plotRect() {
  const { l, r, t, b } = betaUI.pad;
  const W = betaUI.canvas.width, H = betaUI.canvas.height;
  return { x0: l, y0: t, x1: W - r, y1: H - b, w: W - l - r, h: H - t - b };
}
function cx(x)  { const pr = plotRect(); return pr.x0 + x * pr.w; }
function cy(y)  { const pr = plotRect(); return pr.y1 - y * pr.h; }
function ix(px) { const pr = plotRect(); return Math.min(1, Math.max(0, (px - pr.x0) / pr.w)); }
function iy(py) { const pr = plotRect(); return Math.min(1, Math.max(0, 1 - (py - pr.y0) / pr.h)); }

// ─── Domain ───────────────────────────────────────────────────────────────────

function recomputeDomain() {
  const P = betaUI.pts.slice().sort((a,b)=>a.x-b.x);
  betaUI.domain.x0 = P[0].x;
  betaUI.domain.xn = P[P.length-1].x;
}

// ─── Drawing ──────────────────────────────────────────────────────────────────

function drawBetaCurve() {
  const { ctx, pts, R } = betaUI;
  if (!ctx) return;

  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;

  const nTicks = 10;
  for (let t = 0; t <= nTicks; t++) {
    const x = t / nTicks, y = t / nTicks;
    ctx.beginPath(); ctx.moveTo(cx(x), cy(0)); ctx.lineTo(cx(x), cy(1)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx(0), cy(y)); ctx.lineTo(cx(1), cy(y)); ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = 0; t <= nTicks; t++) ctx.fillText((t/nTicks).toFixed(1), cx(t/nTicks), H - 12);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let t = 0; t <= nTicks; t++) ctx.fillText((t/nTicks).toFixed(1), 30, cy(t/nTicks));
  ctx.restore();

  const P  = betaUI.pts.slice().sort((a,b)=>a.x-b.x);
  if (P.length >= 2) {
    const x0 = P[0].x, xn = P[P.length - 1].x;
    const s  = 160;
    ctx.beginPath();
    let penDown = false;
    for (let k = 0; k <= s; k++) {
      const x = x0 + (xn - x0) * (k / s);
      const p = sampleCurve(betaUI.pts, x);
      const X = cx(x), Y = cy(p.y);
      if (!penDown) { ctx.moveTo(X, Y); penDown = true; }
      else          { ctx.lineTo(X, Y); }
    }
    ctx.strokeStyle = '#c7c7c7ff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    ctx.beginPath();
    ctx.arc(cx(p.x), cy(p.y), R, 0, Math.PI * 2);
    ctx.fillStyle = '#bebebeff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#474747ff';
    ctx.stroke();
  }
}

// ─── Pointer interaction ──────────────────────────────────────────────────────

function hitTest(px, py) {
  for (let i = 0; i < betaUI.pts.length; i++) {
    const p  = betaUI.pts[i];
    recomputeDomain();
    const dx = cx(p.x) - px, dy = cy(p.y) - py;
    if (dx*dx + dy*dy <= betaUI.R*betaUI.R*2) return i;
  }
  return -1;
}

function onDown(e) {
  const rect = betaUI.canvas.getBoundingClientRect();
  betaUI.dragging = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (betaUI.dragging >= 0) e.preventDefault();
}

function onMove(e) {
  if (betaUI.dragging < 0) return;
  const rect = betaUI.canvas.getBoundingClientRect();
  const x = ix(e.clientX - rect.left);
  const y = iy(e.clientY - rect.top);
  const i = betaUI.dragging;
  const L = (i === 0) ? 0 : betaUI.pts[i-1].x + 0.001;
  const R = (i === betaUI.pts.length-1) ? 1 : betaUI.pts[i+1].x - 0.001;
  betaUI.pts[i].x = Math.min(Math.max(x, L), R);
  betaUI.pts[i].y = Math.min(Math.max(y, 0), 1);
  recomputeDomain();
  drawBetaCurve();
  rebuildBetaTables();
}

function onUp() {
  if (betaUI.dragging >= 0) { betaUI.dragging = -1; rebuildBetaTables(); }
}

// ─── PDF / CDF tables ────────────────────────────────────────────────────────

function rebuildBetaTables() {
  const N = betaUI.pdf.length;
  recomputeDomain();
  const { x0, xn } = betaUI.domain;

  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    const y = valueAt(x);
    const w = (y === null) ? 0 : Math.max(0, y);
    betaUI.pdf[i] = w;
    sum += w;
  }

  if (sum <= 0 && xn > x0) {
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      betaUI.pdf[i] = (x >= x0 && x <= xn) ? 1 : 0;
    }
    sum = (xn - x0) * (N - 1);
  }

  if (sum > 0) for (let i = 0; i < N; i++) betaUI.pdf[i] /= sum;

  let acc = 0;
  for (let i = 0; i < N; i++) { acc += betaUI.pdf[i]; betaUI.cdf[i] = acc; }
  betaUI.cdf[N-1] = 1.0;
}

// ─── Sampling ─────────────────────────────────────────────────────────────────

function sampleBetaFromCurve(u) {
  if (!betaUI.enabled || !betaUI.cdf) return Math.min(1, Math.max(0, u));

  const N = betaUI.cdf.length;
  const { x0, xn } = betaUI.domain;

  if (N < 2 || betaUI.cdf[N-1] <= 0 || !(betaUI.cdf[N-1] <= 1)) {
    return x0 + Math.min(1, Math.max(0, u)) * Math.max(0, xn - x0);
  }

  let lo = 0, hi = N - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (betaUI.cdf[mid] >= u) hi = mid; else lo = mid + 1;
  }
  const i   = lo;
  const c0  = (i === 0) ? 0 : betaUI.cdf[i-1];
  const c1  = betaUI.cdf[i];
  const t   = (c1 > c0) ? (u - c0) / (c1 - c0) : 0;
  const x0s = (i === 0) ? 0 : (i-1) / (N - 1);
  const x1s = i / (N - 1);
  return Math.min(xn, Math.max(x0, x0s + t * (x1s - x0s)));
}

// ─── Programmatic preset: match a grain-size power law ────────────────────────
//
// COMTAILS emits a differential size distribution dn/da ∝ a^sizePower. With
// beta ∝ 1/a, that transforms to a beta number-PDF dn/dbeta ∝ beta^(-sizePower-2)
// (Jacobian |da/dbeta| ∝ 1/beta^2). Since the curve y(beta) IS the sampled PDF
// (see rebuildBetaTables), set y(beta) = beta^(-sizePower-2). NOTE: the live
// model clamps beta <= 1, so the highest-beta (smallest, unbound) grains COMTAILS
// includes cannot be represented here — a matched run converges only over the
// bound-grain range.
function setBetaCurveSizePower(sizePower, betaMax = 1) {
  const e    = -sizePower - 2;                          // beta-PDF exponent; e=1.9 for sizePower=-3.9
  const xmax = Math.max(0.05, Math.min(1, betaMax));    // cutoff = beta(rmin), clamped to the sim's beta<=1
  const NP   = 9;
  // Points span [0, xmax] so the curve's DOMAIN enforces the upper cutoff: the
  // PDF/CDF machinery returns 0 outside the point range, so no beta > xmax is
  // ever sampled. Shape is (beta/xmax)^e (== beta^e after normalization).
  betaUI.pts = Array.from({ length: NP }, (_, i) => {
    const x = xmax * (i / (NP - 1));
    return { x, y: Math.max(0, Math.min(1, Math.pow(i / (NP - 1), e))) };
  });
  betaUI.enabled = true;
  recomputeDomain();
  rebuildBetaTables();
  drawBetaCurve();
  return { sizePower, betaExponent: e, betaMax: xmax, points: betaUI.pts };
}
window.setBetaCurveSizePower = setBetaCurveSizePower;

// ─── Initialization (runs at page load — DOM is ready by this point) ──────────

(function initBetaCurve() {
  if (!betaUI.canvas) return;
  betaUI.ctx = betaUI.canvas.getContext('2d');
  recomputeDomain();
  drawBetaCurve();

  betaUI.canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);

  const toggleBtn = document.getElementById('betaCurveToggle');
  const curveBody = document.getElementById('betaCurveBody');
  toggleBtn?.addEventListener('click', () => {
    const collapsed = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    toggleBtn.setAttribute('aria-label', collapsed ? 'Expand β gradation curve' : 'Collapse β gradation curve');
    toggleBtn.title = collapsed ? 'Expand β gradation curve' : 'Collapse β gradation curve';
    toggleBtn.textContent = collapsed ? '+' : '−';
    if (curveBody) curveBody.hidden = collapsed;
  });

  betaUI.resetBtn?.addEventListener('click', () => {
    betaUI.pts = [
      { x: 0.00, y: 0.70 },
      { x: 0.25, y: 0.10 },
      { x: 0.60, y: 0.60 },
      { x: 1.00, y: 0.95 }
    ];
    recomputeDomain();
    drawBetaCurve();
    rebuildBetaTables();
  });

  rebuildBetaTables();
})();
