
import argparse
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlencode

import pandas as pd
import matplotlib.pyplot as plt
from playwright.async_api import async_playwright


DEFAULT_WEBGPU_COUNTS = [5000, 100000, 500000, 1000000, 2000000, 3000000]
DEFAULT_CPU_COUNTS = [5000]


def parse_counts(text: str) -> list[int]:
    if text is None or not str(text).strip():
        return []
    return [int(x.strip().replace("_", "")) for x in str(text).split(",") if x.strip()]


def default_index_path() -> Path:
    # This file lives in comet_tail_simulation/benchmark/.
    return Path(__file__).resolve().parent.parent / "index.html"


def default_output_dir() -> Path:
    return Path(__file__).resolve().parent / "results"


def make_url(index: Path, params: dict[str, str]) -> str:
    index = index.resolve()
    if not index.exists():
        raise FileNotFoundError(f"index.html not found: {index}")
    if params:
        return index.as_uri() + "?" + urlencode(params)
    return index.as_uri()


async def run_mode(playwright, args, mode: str, counts: list[int]) -> dict:
    params = {}
    if mode == "WebGPU":
        params["maxParticles"] = str(max(max(counts), 1000000))
    elif mode == "CPU fallback":
        params["force"] = "cpu"
    else:
        raise ValueError(mode)

    index = Path(args.index) if args.index else default_index_path()
    url = make_url(index, params)
    out_dir = Path(args.out) if args.out else default_output_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n=== {mode} ===")
    print(url)

    browser = await playwright.chromium.launch(
        channel=args.channel,
        headless=args.headless,
        args=[
            "--disable-frame-rate-limit",
            "--disable-gpu-vsync",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--enable-unsafe-webgpu",
            "--ignore-gpu-blocklist",
            f"--window-size={args.width + 140},{args.height + 220}",
        ],
    )

    context = await browser.new_context(
        viewport={"width": args.width, "height": args.height},
        accept_downloads=True,
    )

    page = await context.new_page()
    console_lines = []

    async def save_download(download):
        # Keep the browser's own exported files too, but under normal names.
        target = out_dir / download.suggested_filename
        await download.save_as(target)

    page.on("download", lambda d: asyncio.create_task(save_download(d)))

    def on_console(msg):
        text = msg.text
        console_lines.append(f"{msg.type}: {text}")
        if "Benchmark" in text or "Comet benchmark" in text or "FORCE" in text or "error" in text.lower():
            print(f"[browser {msg.type}] {text}")

    page.on("console", on_console)
    page.on("pageerror", lambda e: (print(f"[pageerror] {e}"), console_lines.append(f"PAGEERROR: {e}")))

    await page.goto(url, wait_until="load", timeout=120_000)

    start = page.locator("#startBtn")
    if await start.count() > 0:
        await start.click(timeout=10_000)
        await page.wait_for_timeout(2000)

    await page.wait_for_function(
        """
        () => typeof runCometBenchmark === 'function'
           && typeof scene !== 'undefined'
           && typeof engine !== 'undefined'
        """,
        timeout=120_000,
    )

    await page.bring_to_front()

    options = {
        "counts": counts,
        "runs": args.repeats,
        "warmupSeconds": args.warmup_seconds,
        "measureSeconds": args.measure_seconds,
        "simulationSpeed": args.simulation_speed,
        "lifeSeconds": args.life_days * 365.25 * 86400,
    }

    print(f"Running particle counts: {counts}")
    print(f"Repeats per particle count: {args.repeats}")
    print("Keep the browser window visible. Do not minimize it.")

    result = await page.evaluate(
        """
        async (options) => {
            return await runCometBenchmark(options);
        }
        """,
        options,
    )

    await page.wait_for_timeout(2500)

    mode_key = "webgpu" if mode == "WebGPU" else "cpu_fallback"
    (out_dir / f"raw_{mode_key}_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    (out_dir / f"console_{mode_key}.log").write_text("\n".join(console_lines), encoding="utf-8")

    await context.close()
    await browser.close()

    return result


def rows_from_result(result: dict, requested_mode: str) -> list[dict]:
    rows = []
    env = result.get("environment", {})
    actual_mode = result.get("mode", requested_mode)

    for r in result.get("results", []):
        runs = r.get("runs", [])
        row = {
            "mode": actual_mode,
            "particles": int(r["particles"]),
            "requested_particles": int(r.get("requestedParticles", r["particles"])),
            "median_fps": float(r["medianFps"]),
            "mean_fps": float(r["meanFps"]),
            "frame_ms": float(r["frameMs"]),
            "note": r.get("note", ""),
            "render_width": env.get("renderWidth"),
            "render_height": env.get("renderHeight"),
            "monitor_width": env.get("monitorWidth"),
            "monitor_height": env.get("monitorHeight"),
            "device_pixel_ratio": env.get("devicePixelRatio"),
            "babylon_version": env.get("babylonVersion"),
            "cpu_threads": env.get("cpuLogicalThreads"),
            "webgpu_enabled": env.get("webgpuComputeEnabled"),
            "raw_particles_max": env.get("rawParticlesMax"),
            "max_particles_gpu": env.get("maxParticlesGpuConstant"),
            "max_particles_cpu": env.get("maxParticlesCpuConstant"),
            "user_agent": env.get("userAgent"),
            "timestamp": env.get("timestamp"),
        }
        for i, value in enumerate(runs, start=1):
            row[f"run_{i}_fps"] = float(value)
        rows.append(row)
    return rows


def make_speedup(df: pd.DataFrame) -> pd.DataFrame:
    gpu = df[df["mode"] == "WebGPU"]
    cpu = df[df["mode"] == "CPU fallback"]

    common = sorted(set(gpu["particles"]).intersection(set(cpu["particles"])))
    rows = []

    for n in common:
        g = gpu[gpu["particles"] == n].iloc[0]
        c = cpu[cpu["particles"] == n].iloc[0]
        rows.append({
            "particles": n,
            "webgpu_median_fps": g["median_fps"],
            "cpu_median_fps": c["median_fps"],
            "webgpu_frame_ms": g["frame_ms"],
            "cpu_frame_ms": c["frame_ms"],
            "frame_time_speedup": c["frame_ms"] / g["frame_ms"] if g["frame_ms"] else None,
            "fps_speedup": g["median_fps"] / c["median_fps"] if c["median_fps"] else None,
        })
    return pd.DataFrame(rows)


def make_graphs(df: pd.DataFrame, out_dir: Path) -> None:
    plt.figure(figsize=(9, 5.2))
    for mode in ["WebGPU", "CPU fallback"]:
        sub = df[df["mode"] == mode].sort_values("particles")
        if sub.empty:
            continue
        plt.plot(sub["particles"], sub["median_fps"], marker="o", linewidth=2, label=mode)
    plt.xscale("log")
    plt.xlabel("Active particles")
    plt.ylabel("Median FPS")
    plt.title("Uncapped benchmark")
    plt.grid(True, which="both", linestyle="--", linewidth=0.5)
    plt.axhline(60, linestyle=":", linewidth=1.2, label="60 FPS reference")
    plt.axhline(30, linestyle=":", linewidth=1.2, label="30 FPS interactive reference")
    plt.axhline(10, linestyle=":", linewidth=1.2, label="10 FPS inspection reference")
    plt.legend()
    plt.tight_layout()
    plt.savefig(out_dir / "fps_comparison.png", dpi=300)
    plt.close()

    plt.figure(figsize=(9, 5.2))
    for mode in ["WebGPU", "CPU fallback"]:
        sub = df[df["mode"] == mode].sort_values("particles")
        if sub.empty:
            continue
        plt.plot(sub["particles"], sub["frame_ms"], marker="o", linewidth=2, label=mode)
    plt.xscale("log")
    plt.yscale("log")
    plt.xlabel("Active particles")
    plt.ylabel("Frame time (ms)")
    plt.title("Uncapped frame time benchmark")
    plt.grid(True, which="both", linestyle="--", linewidth=0.5)
    plt.axhline(16.67, linestyle=":", linewidth=1.2, label="60 FPS frame budget")
    plt.axhline(33.33, linestyle=":", linewidth=1.2, label="30 FPS frame budget")
    plt.axhline(100, linestyle=":", linewidth=1.2, label="10 FPS frame budget")
    plt.legend()
    plt.tight_layout()
    plt.savefig(out_dir / "frame_time_comparison.png", dpi=300)
    plt.close()


def make_tables(df: pd.DataFrame, speedup: pd.DataFrame, out_dir: Path) -> None:
    webgpu_rows = df[df["mode"] == "WebGPU"].sort_values("particles")
    lines = [
        r"\begin{table}[t]",
        r"\centering",
        r"\caption{Uncapped WebGPU benchmark using a deterministic pre-filled particle population.}",
        r"\label{tab:webgpu_uncapped_performance}",
        r"\begin{tabular}{rrr}",
        r"\hline",
        r"Particles & Median FPS & Frame time (ms) \\",
        r"\hline",
    ]
    for _, r in webgpu_rows.iterrows():
        if int(r["particles"]) == 5000:
            continue
        lines.append(f"{int(r['particles']):,} & {r['median_fps']:.2f} & {r['frame_ms']:.2f} \\")
    lines += [r"\hline", r"\end{tabular}", r"\end{table}"]
    (out_dir / "webgpu_performance_table.tex").write_text("\n".join(lines), encoding="utf-8")

    lines = [
        r"\begin{table}[t]",
        r"\centering",
        r"\caption{Uncapped performance comparison between WebGPU mode and CPU fallback at the same particle count.}",
        r"\label{tab:cpu_gpu_uncapped_comparison}",
        r"\begin{tabular}{lrrr}",
        r"\hline",
        r"Mode & Particles & Median FPS & Frame time (ms) \\",
        r"\hline",
    ]
    for mode in ["WebGPU", "CPU fallback"]:
        row = df[(df["mode"] == mode) & (df["particles"] == 5000)]
        if not row.empty:
            r = row.iloc[0]
            lines.append(f"{mode} & 5,000 & {r['median_fps']:.2f} & {r['frame_ms']:.2f} \\")
    lines += [r"\hline", r"\end{tabular}", r"\end{table}"]
    (out_dir / "cpu_webgpu_comparison_table.tex").write_text("\n".join(lines), encoding="utf-8")

    if not speedup.empty:
        r = speedup.iloc[0]
        interp = (
            "Benchmark summary\n"
            "=================\n\n"
            f"At {int(r['particles']):,} particles, WebGPU frame time was "
            f"{r['webgpu_frame_ms']:.2f} ms and CPU fallback frame time was "
            f"{r['cpu_frame_ms']:.2f} ms.\n"
            f"Frame-time speedup: {r['frame_time_speedup']:.2f}x.\n"
            f"FPS speedup: {r['fps_speedup']:.2f}x.\n\n"
            "This benchmark uses a deterministic pre-filled particle population. "
            "It measures interactive propagation and rendering performance for a fixed active particle count.\n"
        )
    else:
        interp = "No shared particle counts were found for speedup calculation.\n"

    (out_dir / "benchmark_summary.txt").write_text(interp, encoding="utf-8")


async def main():
    parser = argparse.ArgumentParser(description="Run the uncapped CPU/WebGPU benchmark.")
    parser.add_argument("--index", default=None, help="Path to index.html. Default: ../index.html")
    parser.add_argument("--out", default=None, help="Output folder. Default: benchmark/results")
    parser.add_argument("--webgpu-counts", default=",".join(str(x) for x in DEFAULT_WEBGPU_COUNTS))
    parser.add_argument("--cpu-counts", default=",".join(str(x) for x in DEFAULT_CPU_COUNTS))
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--warmup-seconds", type=float, default=5)
    parser.add_argument("--measure-seconds", type=float, default=20)
    parser.add_argument("--simulation-speed", type=float, default=3600)
    parser.add_argument("--life-days", type=float, default=50)
    parser.add_argument("--width", type=int, default=2005)
    parser.add_argument("--height", type=int, default=1305)
    parser.add_argument("--channel", default="chrome")
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out) if args.out else default_output_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    webgpu_counts = parse_counts(args.webgpu_counts)
    cpu_counts = parse_counts(args.cpu_counts)

    rows = []
    async with async_playwright() as playwright:
        if webgpu_counts:
            gpu = await run_mode(playwright, args, "WebGPU", webgpu_counts)
            rows.extend(rows_from_result(gpu, "WebGPU"))
        if cpu_counts:
            cpu = await run_mode(playwright, args, "CPU fallback", cpu_counts)
            rows.extend(rows_from_result(cpu, "CPU fallback"))

    df = pd.DataFrame(rows).sort_values(["mode", "particles"])
    speedup = make_speedup(df)

    df.to_csv(out_dir / "benchmark_results.csv", index=False)
    speedup.to_csv(out_dir / "speedup_summary.csv", index=False)

    make_graphs(df, out_dir)
    make_tables(df, speedup, out_dir)

    print("\nDone. Output folder:")
    print(out_dir.resolve())
    print("\nCreated files:")
    for name in [
        "benchmark_results.csv",
        "speedup_summary.csv",
        "fps_comparison.png",
        "frame_time_comparison.png",
        "webgpu_performance_table.tex",
        "cpu_webgpu_comparison_table.tex",
        "benchmark_summary.txt",
        "raw_webgpu_result.json",
        "raw_cpu_fallback_result.json",
        "console_webgpu.log",
        "console_cpu_fallback.log",
    ]:
        p = out_dir / name
        if p.exists():
            print(f"  {p.name}")


if __name__ == "__main__":
    asyncio.run(main())
