
let canvas, engine, scene;
let hasCompute = false;
let useCompute  = false;
let cometMesh   = null;

async function initEngine() {
  canvas = document.getElementById("renderCanvas");
  const gpuStatusEl = document.getElementById("gpuStatus");

  function setBadge(text, bg, border) {
    gpuStatusEl.textContent    = text;
    gpuStatusEl.style.background   = bg;
    gpuStatusEl.style.borderColor  = border;
  }

  const FORCE_MODE = (new URLSearchParams(location.search).get("force") || "").toLowerCase();

  async function tryInitWebGPU() {
    if (FORCE_MODE === "webgl") {
      console.warn("[CometSim] FORCE=webgl -> skipping WebGPU init.");
      return null;
    }
    if (!window.isSecureContext) {
      console.warn("[CometSim] Not a secure context:", location.protocol, "— WebGPU is disabled.");
      return null;
    }
    if (!("gpu" in navigator)) {
      console.warn("[CometSim] navigator.gpu missing — browser doesn't expose WebGPU.");
      return null;
    }
    try {
      const wgpu = new BABYLON.WebGPUEngine(canvas, { antialiasing: true, preserveDrawingBuffer: true });
      await wgpu.initAsync();
      const caps = wgpu.getCaps?.() || {};
      hasCompute = !!(caps.supportComputeShaders || caps.supportCompute);
      return wgpu;
    } catch (err) {
      console.warn("[CometSim] WebGPU init failed:", err);
      return null;
    }
  }

  const wgpu = await tryInitWebGPU();
  if (wgpu) {
    engine = wgpu;
    if (FORCE_MODE === "cpu") {
      console.warn("[CometSim] FORCE=cpu -> disabling compute on WebGPU engine.");
      hasCompute = false;
    }
    setBadge(
      hasCompute ? "GPU: WebGPU (Compute ON)" : "GPU: WebGPU (Compute OFF)",
      hasCompute ? "#0b3d0b" : "#3d2f0b",
      hasCompute ? "#0f0"   : "#fd0"
    );
  } else {
    console.warn("[CometSim] Using WebGL fallback.");
    engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    hasCompute = false;
    setBadge("GPU: WebGL (Compute OFF)", "#3d0b0b", "#f33");
  }

  window.__engineHasCompute = hasCompute;
  window.__engineIsWebGPU   = (engine && engine.getClassName?.() === "WebGPUEngine");

  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color3(0.02, 0.02, 0.08);
  useCompute = (engine instanceof BABYLON.WebGPUEngine) && hasCompute;
}
