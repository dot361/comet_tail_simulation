// ─── WebGPU compute + render particle system ─────────────────────────────────

async function setupRawParticles(engine, parentCanvas, MAX_PARTICLES) {
  if (!(engine instanceof BABYLON.WebGPUEngine)) return null;

  const device = engine._device;
  const format = navigator.gpu.getPreferredCanvasFormat();

  const overlay = document.createElement('canvas');
  overlay.id = 'particleOverlay';
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;';
  const holder = parentCanvas.parentNode || document.body;
  if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
  holder.appendChild(overlay);

  const ctx = overlay.getContext('webgpu');

  function resize() {
    const rw = engine.getRenderWidth(true);
    const rh = engine.getRenderHeight(true);
    overlay.width  = rw;
    overlay.height = rh;
    overlay.style.width  = parentCanvas.style.width  || `${parentCanvas.clientWidth}px`;
    overlay.style.height = parentCanvas.style.height || `${parentCanvas.clientHeight}px`;
    ctx.configure({ device, format, alphaMode: 'premultiplied' });
  }
  resize();
  engine.onResizeObservable.add(resize);

  // ── Compute shader ──────────────────────────────────────────────────────────
  const WGSL_COMPUTE = `
struct SimParams {
  dtSeconds : f32,
  maxCount  : u32,
  muScene   : f32,
  _pad1     : u32,
};

@group(0) @binding(0) var<storage, read_write> posLife : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> velBeta : array<vec4<f32>>;
@group(0) @binding(2) var<uniform> sim : SimParams;

fn accel(r: vec3<f32>, muScene: f32, beta: f32) -> vec3<f32> {
  let r2    = max(1e-18, dot(r, r));
  let invR  = inverseSqrt(r2);
  let invR3 = invR * invR * invR;
  let muEff = muScene * max(0.0, 1.0 - clamp(beta, 0.0, 1.0));
  return -muEff * r * invR3;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= sim.maxCount) { return; }

  var p  = posLife[i];
  if (p.w <= 0.0) { return; }

  var vb = velBeta[i];
  var r  = p.xyz;
  var v  = vb.xyz;
  let b  = vb.w;

  let dt = sim.dtSeconds;
  if (dt <= 0.0) {
    posLife[i] = vec4<f32>(r, p.w);
    velBeta[i] = vec4<f32>(v, b);
    return;
  }

  let rmag  = max(1e-6, length(r));
  let muEst = sim.muScene * max(1e-6, 1.0 - clamp(b, 0.0, 1.0));
  let tDyn  = sqrt((rmag * rmag * rmag) / muEst);
  var steps = i32(ceil(dt / (0.1 * tDyn)));
  steps = clamp(steps, 1, 8);
  let h = dt / f32(steps);

  var a = accel(r, sim.muScene, b);
  v = v + a * (0.5 * h);
  for (var s = 0; s < steps; s = s + 1) {
    r = r + v * h;
    a = accel(r, sim.muScene, b);
    if (s + 1 < steps) { v = v + a * h; }
  }
  v = v + a * (0.5 * h);

  posLife[i] = vec4<f32>(r, max(p.w - dt, 0.0));
  velBeta[i] = vec4<f32>(v, b);
}
`;

  // ── Render shader ───────────────────────────────────────────────────────────
  const WGSL_RENDER = `
struct Globals {
  viewProj    : mat4x4<f32>,
  lifeFadeInv : f32,
  visMode     : u32,
  pointPx     : f32,
  _pad0       : f32,
  screenSize  : vec2<f32>,
  _pad1       : vec2<f32>,
  cometVel    : vec4<f32>,
  cometPos    : vec4<f32>,
  distMax     : f32,
  vRelMax     : f32,
  _pad2       : vec2<f32>,
};

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var<storage, read> posLife : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> velBeta : array<vec4<f32>>;

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) life : f32,
  @location(1) @interpolate(flat) pid : u32,
  @location(2) corner : vec2<f32>,
};

fn cornerOf(v : u32) -> vec2<f32> {
  let c = v % 6u;
  switch (c) {
    case 0u: { return vec2<f32>(-1.0, -1.0); }
    case 1u: { return vec2<f32>( 1.0, -1.0); }
    case 2u: { return vec2<f32>( 1.0,  1.0); }
    case 3u: { return vec2<f32>(-1.0, -1.0); }
    case 4u: { return vec2<f32>( 1.0,  1.0); }
    default: { return vec2<f32>(-1.0,  1.0); }
  }
}

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var out : VSOut;
  let pid = vid / 6u;
  let c   = cornerOf(vid);
  let p   = posLife[pid];
  if (p.w <= 0.0) {
    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.life = 0.0; out.pid = pid; out.corner = c;
    return out;
  }
  var clip = globals.viewProj * vec4<f32>(p.xyz, 1.0);
  let sx_ndc = (globals.pointPx / globals.screenSize.x) * 2.0;
  let sy_ndc = (globals.pointPx / globals.screenSize.y) * 2.0;
  clip.x += sx_ndc * 0.5 * c.x * clip.w;
  clip.y += sy_ndc * 0.5 * c.y * clip.w;
  out.Position = clip; out.life = p.w; out.pid = pid; out.corner = c;
  return out;
}

fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let c = v * s; let hp = h * 6.0;
  let x = c * (1.0 - abs((hp % 2.0) - 1.0));
  var r = 0.0; var g = 0.0; var b = 0.0;
  if      (hp < 1.0) { r=c; g=x; }
  else if (hp < 2.0) { r=x; g=c; }
  else if (hp < 3.0) { g=c; b=x; }
  else if (hp < 4.0) { g=x; b=c; }
  else if (hp < 5.0) { r=x; b=c; }
  else               { r=c; b=x; }
  let m = v - c;
  return vec3<f32>(r+m, g+m, b+m);
}
fn rainbow(u: f32) -> vec3<f32> { return hsv2rgb((1.0 - clamp(u,0.0,1.0)) * 0.7, 1.0, 1.0); }
fn mix3(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> { let tt=clamp(t,0.0,1.0); return a+(b-a)*tt; }

@fragment
fn fs_main(@location(0) life: f32, @location(1) @interpolate(flat) pid: u32) -> @location(0) vec4<f32> {
  let a = clamp(life * globals.lifeFadeInv, 0.0, 1.0);
  if (a <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let p  = posLife[pid];
  let vb = velBeta[pid];
  var rgb : vec3<f32>;
  switch (globals.visMode) {
    case 2u: { rgb = rainbow(pow(clamp(vb.w, 0.0, 1.0), 0.6)); }
    case 3u: { rgb = mix3(vec3<f32>(1.0,0.0,0.0), vec3<f32>(0.0,0.0,1.0), 1.0-a); }
    case 4u: {
      let u = clamp(distance(p.xyz, globals.cometPos.xyz) / max(globals.distMax,1e-6), 0.0, 1.0);
      rgb = mix3(vec3<f32>(1.0,0.95,0.20), vec3<f32>(0.10,0.20,1.00), u);
    }
    case 5u: {
      let u = clamp(length(vb.xyz - globals.cometVel.xyz) / max(globals.vRelMax,1e-9), 0.0, 1.0);
      rgb = rainbow(u);
    }
    default: { rgb = vec3<f32>(1.0, 1.0, 1.0); }
  }
  return vec4<f32>(rgb, a);
}
`;

  // ── GPU buffers ─────────────────────────────────────────────────────────────
  const posLifeGPU = device.createBuffer({
    size:  MAX_PARTICLES * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const velBetaGPU = device.createBuffer({
    size:  MAX_PARTICLES * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const zeroPL = new Float32Array(MAX_PARTICLES * 4);
  device.queue.writeBuffer(posLifeGPU, 0, zeroPL);
  device.queue.writeBuffer(velBetaGPU, 0, zeroPL);

  function clear() {
    device.queue.writeBuffer(posLifeGPU, 0, zeroPL);
    device.queue.writeBuffer(velBetaGPU, 0, zeroPL);
  }

  const simUBO = device.createBuffer({
    size:  16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const globalsUBO = device.createBuffer({
    size:  160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: WGSL_COMPUTE }), entryPoint: 'main' }
  });

  const renderPipeline = device.createRenderPipeline({
    layout:   'auto',
    vertex:   { module: device.createShaderModule({ code: WGSL_RENDER }), entryPoint: 'vs_main' },
    fragment: {
      module:  device.createShaderModule({ code: WGSL_RENDER }),
      entryPoint: 'fs_main',
      targets: [{ format, blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' }
      }}]
    },
    primitive: { topology: 'triangle-list' }
  });

  const computeBG = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: posLifeGPU } },
      { binding: 1, resource: { buffer: velBetaGPU } },
      { binding: 2, resource: { buffer: simUBO     } },
    ]
  });

  const renderBG = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: globalsUBO } },
      { binding: 1, resource: { buffer: posLifeGPU } },
      { binding: 2, resource: { buffer: velBetaGPU } },
    ]
  });

  // ── Seed a single particle ──────────────────────────────────────────────────
  const seedScratch = new Float32Array(4);
  function seed(index, pos, vel, lifeSeconds, beta) {
    const off = index * 16;
    seedScratch[0]=pos.x; seedScratch[1]=pos.y; seedScratch[2]=pos.z; seedScratch[3]=lifeSeconds;
    device.queue.writeBuffer(posLifeGPU, off, seedScratch.buffer);
    seedScratch[0]=vel.x; seedScratch[1]=vel.y; seedScratch[2]=vel.z; seedScratch[3]=beta;
    device.queue.writeBuffer(velBetaGPU, off, seedScratch.buffer);
  }

  // ── Bulk seed particles for reproducible benchmarks ──────────────────────────
  function seedBulk(count, makeParticle) {
    const n = Math.max(0, Math.min(count >>> 0, MAX_PARTICLES));
    const posLife = new Float32Array(n * 4);
    const velBeta = new Float32Array(n * 4);

    for (let i = 0; i < n; i++) {
      const p = makeParticle(i, n);
      const o = i * 4;
      posLife[o + 0] = p.pos.x;
      posLife[o + 1] = p.pos.y;
      posLife[o + 2] = p.pos.z;
      posLife[o + 3] = p.lifeSeconds;
      velBeta[o + 0] = p.vel.x;
      velBeta[o + 1] = p.vel.y;
      velBeta[o + 2] = p.vel.z;
      velBeta[o + 3] = p.beta;
    }

    clear();
    if (n > 0) {
      device.queue.writeBuffer(posLifeGPU, 0, posLife.buffer, posLife.byteOffset, posLife.byteLength);
      device.queue.writeBuffer(velBetaGPU, 0, velBeta.buffer, velBeta.byteOffset, velBeta.byteLength);
    }
    return n;
  }

  // ── Per-frame update (compute + render pass) ────────────────────────────────
  function update(dtSeconds, maxCount, vpMatrix, cometVel_scene, cometPos_scene, simState) {
    const { baseLifetime, visMode, distVisMaxScene, vRelMax_scene } = simState;

    device.queue.writeBuffer(simUBO, 0, new Float32Array([dtSeconds]));
    device.queue.writeBuffer(simUBO, 4, new Uint32Array([maxCount >>> 0]));
    device.queue.writeBuffer(simUBO, 8, new Float32Array([MU_SCENE]));
    device.queue.writeBuffer(globalsUBO, 0, vpMatrix);

    const lifeFadeInv = 1 / Math.max(1e-6, baseLifetime * SECONDS_PER_DAY);
    const rw = engine.getRenderWidth(true);
    const rh = engine.getRenderHeight(true);
    const modeIndex =
      visMode === 'beta' ? 2 :
      visMode === 'age'  ? 3 :
      visMode === 'dist' ? 4 :
      visMode === 'vrel' ? 5 : 0;

    device.queue.writeBuffer(globalsUBO,  64, new Float32Array([lifeFadeInv]));
    device.queue.writeBuffer(globalsUBO,  68, new Uint32Array([modeIndex]));
    device.queue.writeBuffer(globalsUBO,  72, new Float32Array([POINT_PX]));
    device.queue.writeBuffer(globalsUBO,  80, new Float32Array([rw, rh]));
    device.queue.writeBuffer(globalsUBO,  96, new Float32Array([cometVel_scene.x, cometVel_scene.y, cometVel_scene.z, 0]));
    device.queue.writeBuffer(globalsUBO, 112, new Float32Array([cometPos_scene.x, cometPos_scene.y, cometPos_scene.z, 0]));
    device.queue.writeBuffer(globalsUBO, 128, new Float32Array([distVisMaxScene, vRelMax_scene, 0, 0]));

    const enc = device.createCommandEncoder();

    {
      const pass = enc.beginComputePass();
      pass.setPipeline(computePipeline);
      pass.setBindGroup(0, computeBG);
      pass.dispatchWorkgroups(Math.ceil(maxCount / 64));
      pass.end();
    }

    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view:       ctx.getCurrentTexture().createView(),
          loadOp:     'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp:    'store'
        }]
      });
      pass.setPipeline(renderPipeline);
      pass.setBindGroup(0, renderBG);
      pass.draw(maxCount * 6, 1, 0, 0);
      pass.end();
    }

    device.queue.submit([enc.finish()]);
  }

  // ── Headless compute-only dispatch (no render pass) ────────────────────────
  function computeOnly(dtSeconds, maxCount) {
    device.queue.writeBuffer(simUBO, 0, new Float32Array([dtSeconds]));
    device.queue.writeBuffer(simUBO, 4, new Uint32Array([maxCount >>> 0]));
    device.queue.writeBuffer(simUBO, 8, new Float32Array([MU_SCENE]));
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(computePipeline);
    pass.setBindGroup(0, computeBG);
    pass.dispatchWorkgroups(Math.ceil(maxCount / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  // ── GPU readback (copies posLife buffer to CPU for export) ─────────────────
  async function readback() {
    const byteSize = MAX_PARTICLES * 16;
    const staging  = device.createBuffer({
      size:  byteSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(posLifeGPU, 0, staging, 0, byteSize);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  return { seed, seedBulk, update, computeOnly, resize, clear, readback, max: MAX_PARTICLES };
}
