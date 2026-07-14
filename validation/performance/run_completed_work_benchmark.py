#!/usr/bin/env python3
"""Automate the synchronized WebGPU performance benchmark with Playwright."""

from __future__ import annotations

import argparse
import csv
import ctypes
import datetime as dt
import json
import os
import platform
import subprocess
import sys
import threading
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CHROME_PATHS = [
    Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
    Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
]

PRESETS = {
    "smoke": {
        "runs": 1, "frames_per_run": 30, "warmup_frames": 10,
        "rebuild_runs": 1, "rebuild_history_days": 2, "rebuild_particles_per_day": 1000,
        "rebuild_dt_days": 0.5,
    },
    "standard": {
        "runs": 10, "frames_per_run": 1000, "warmup_frames": 240,
        "rebuild_runs": 3, "rebuild_history_days": 300, "rebuild_particles_per_day": 16_500,
        "rebuild_dt_days": 0.1,
    },
    "overnight": {
        "runs": 20, "frames_per_run": 10000, "warmup_frames": 600,
        "rebuild_runs": 5, "rebuild_history_days": 300, "rebuild_particles_per_day": 16_500,
        "rebuild_dt_days": 0.1,
    },
}

CHROME_ARGS = [
    "--enable-unsafe-webgpu",
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class RunLogger:
    def __init__(self, path: Path) -> None:
        self.path = path

    def write(self, message: str) -> None:
        timestamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        line = f"[{timestamp}] {message}"
        print(line, flush=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def find_chrome(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if path.is_file():
            return path
        raise FileNotFoundError(f"Chrome executable not found: {path}")
    for path in DEFAULT_CHROME_PATHS:
        if path.is_file():
            return path
    raise FileNotFoundError("Google Chrome was not found; pass --chrome-path explicitly.")


def command_output(command: list[str]) -> str | None:
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
        output = (proc.stdout or proc.stderr).strip()
        return output or None
    except (OSError, subprocess.SubprocessError):
        return None


def prevent_windows_sleep(enable: bool) -> None:
    if os.name != "nt":
        return
    es_continuous = 0x80000000
    es_system_required = 0x00000001
    es_display_required = 0x00000002
    flags = es_continuous | (es_system_required | es_display_required if enable else 0)
    ctypes.windll.kernel32.SetThreadExecutionState(flags)


def write_outputs(output_dir: Path, document: dict) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "completed_work_benchmark.json"
    json_path.write_text(json.dumps(document, indent=2), encoding="utf-8")

    summary_path = output_dir / "completed_work_summary.csv"
    with summary_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "mode", "particles", "runs", "frames_per_run", "fixed_dt_seconds",
            "render_width", "render_height", "median_frame_ms", "q25_frame_ms",
            "q75_frame_ms", "iqr_frame_ms", "median_completed_fps",
        ])
        for item in document["results"]:
            options = item["options"]
            summary = item["summary"]
            writer.writerow([
                item["mode"], item["particles"], options["runs"], options["framesPerRun"],
                options["fixedDtSeconds"], options["renderWidth"], options["renderHeight"],
                summary["medianFrameMs"], summary["q25FrameMs"], summary["q75FrameMs"],
                summary["iqrFrameMs"], summary["medianCompletedFps"],
            ])

    runs_path = output_dir / "completed_work_runs.csv"
    with runs_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["mode", "particles", "run", "completed_frames", "elapsed_ms", "frame_ms", "completed_fps"])
        for item in document["results"]:
            for run in item["runs"]:
                writer.writerow([
                    item["mode"], item["particles"], run["run"], run["completedFrames"],
                    run["elapsedMs"], run["frameMs"], run["completedFps"],
                ])

    rebuild_summary_path = output_dir / "tail_rebuild_summary.csv"
    with rebuild_summary_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "scenario", "runs", "history_days", "dt_days", "particles_per_day",
            "median_seconds", "q25_seconds", "q75_seconds", "iqr_seconds",
            "median_final_active_particles", "median_accepted_births",
            "median_particle_step_updates", "all_runs_valid",
        ])
        for item in document.get("rebuildResults", []):
            options = item["options"]
            summary = item["summary"]
            writer.writerow([
                item["scenario"], options["runs"], options["historyDays"], options["dtDays"],
                options["particlesPerDay"], summary["medianSeconds"], summary["q25Seconds"],
                summary["q75Seconds"], summary["iqrSeconds"], summary["medianFinalActiveParticles"],
                summary["medianAcceptedBirths"], summary["medianParticleStepUpdates"],
                summary["allRunsValid"],
            ])

    rebuild_runs_path = output_dir / "tail_rebuild_runs.csv"
    with rebuild_runs_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "scenario", "run", "elapsed_seconds", "history_days", "dt_days", "total_steps",
            "requested_births", "attempted_births", "accepted_births", "hard_cap_clipped_births",
            "capacity_dropped_births", "final_active_particles", "final_max_used", "buffer_capacity",
            "gpu_dispatches", "particle_step_updates", "valid",
        ])
        for item in document.get("rebuildResults", []):
            for run in item["runs"]:
                writer.writerow([
                    item["scenario"], run["run"], run["elapsedSeconds"], run["historyDays"],
                    run["dtDays"], run["totalSteps"], run["requestedBirths"], run["attemptedBirths"],
                    run["acceptedBirths"], run["hardCapClippedBirths"], run["capacityDroppedBirths"],
                    run["finalActiveParticles"], run["finalMaxUsed"], run["bufferCapacity"],
                    run["gpuDispatches"], run["particleStepUpdates"], run["valid"],
                ])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", choices=PRESETS, default="overnight")
    parser.add_argument("--counts", type=int, nargs="+", default=[100_000, 500_000, 1_000_000, 2_000_000, 3_000_000])
    parser.add_argument("--modes", nargs="+", choices=["compute_only", "update_render"], default=["compute_only", "update_render"])
    parser.add_argument("--runs", type=int)
    parser.add_argument("--frames-per-run", type=int)
    parser.add_argument("--warmup-frames", type=int)
    parser.add_argument("--max-in-flight-frames", type=int, default=240)
    parser.add_argument("--fixed-dt-seconds", type=float, default=60.0)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--cooldown-ms", type=int, default=250)
    parser.add_argument("--skip-rebuild", action="store_true")
    parser.add_argument("--rebuild-runs", type=int)
    parser.add_argument("--rebuild-history-days", type=float)
    parser.add_argument("--rebuild-particles-per-day", type=float)
    parser.add_argument("--rebuild-dt-days", type=float)
    parser.add_argument("--chrome-path")
    parser.add_argument("--output-dir")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    preset = PRESETS[args.preset]
    runs = args.runs or preset["runs"]
    frames_per_run = args.frames_per_run or preset["frames_per_run"]
    warmup_frames = args.warmup_frames if args.warmup_frames is not None else preset["warmup_frames"]
    rebuild_runs = args.rebuild_runs or preset["rebuild_runs"]
    rebuild_history_days = args.rebuild_history_days or preset["rebuild_history_days"]
    rebuild_particles_per_day = args.rebuild_particles_per_day or preset["rebuild_particles_per_day"]
    rebuild_dt_days = args.rebuild_dt_days or preset["rebuild_dt_days"]

    for name, value in {
        "runs": runs,
        "frames-per-run": frames_per_run,
        "max-in-flight-frames": args.max_in_flight_frames,
        "width": args.width,
        "height": args.height,
        "rebuild-runs": rebuild_runs,
    }.items():
        if value < 1:
            raise ValueError(f"--{name} must be positive")
    for name, value in {
        "rebuild-history-days": rebuild_history_days,
        "rebuild-particles-per-day": rebuild_particles_per_day,
        "rebuild-dt-days": rebuild_dt_days,
    }.items():
        if value <= 0:
            raise ValueError(f"--{name} must be positive")
    if any(count < 1 for count in args.counts):
        raise ValueError("All particle counts must be positive")

    stamp = dt.datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
    output_dir = Path(args.output_dir).resolve() if args.output_dir else REPO_ROOT / "validation/performance/results" / stamp
    output_dir.mkdir(parents=True, exist_ok=True)
    logger = RunLogger(output_dir / "benchmark.log")
    chrome_path = find_chrome(args.chrome_path)

    nominal_rebuild_particles = int(rebuild_history_days * rebuild_particles_per_day + 0.999999)
    max_particles = max(args.counts)
    if not args.skip_rebuild:
        max_particles = max(max_particles, nominal_rebuild_particles)
    document = {
        "status": "running",
        "startedAt": dt.datetime.now().astimezone().isoformat(),
        "runner": {
            "preset": args.preset,
            "python": sys.version,
            "platform": platform.platform(),
            "chromePath": str(chrome_path),
            "nvidiaSmi": command_output(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"]),
            "chromeArguments": CHROME_ARGS,
            "counts": args.counts,
            "modes": args.modes,
            "rebuildEnabled": not args.skip_rebuild,
            "rebuildRuns": rebuild_runs,
            "rebuildHistoryDays": rebuild_history_days,
            "rebuildParticlesPerDay": rebuild_particles_per_day,
            "rebuildDtDays": rebuild_dt_days,
            "allocatedParticleCapacity": max_particles,
        },
        "results": [],
        "rebuildResults": [],
    }
    write_outputs(output_dir, document)

    handler = partial(QuietHandler, directory=str(REPO_ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    url = f"http://127.0.0.1:{server.server_port}/index.html?maxParticles={max_particles}"

    prevent_windows_sleep(True)
    try:
        logger.write(f"Results directory: {output_dir}")
        logger.write(f"Launching Chrome: {chrome_path}")
        logger.write(f"Loading {url}")

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=False,
                executable_path=str(chrome_path),
                args=CHROME_ARGS + [f"--window-size={args.width},{args.height}"],
            )
            context = browser.new_context(
                viewport={"width": args.width, "height": args.height},
                device_scale_factor=1,
                accept_downloads=False,
            )
            page = context.new_page()
            page.set_default_timeout(24 * 60 * 60 * 1000)
            page.on("console", lambda message: logger.write(f"browser: {message.text}"))
            page.on("pageerror", lambda error: logger.write(f"browser error: {error}"))
            page.goto(url, wait_until="domcontentloaded", timeout=120_000)
            page.click("#startBtn")
            page.wait_for_function(
                "() => window.__engineHasCompute === true && "
                "typeof rawParticles !== 'undefined' && rawParticles !== null && "
                "typeof window.runTailRebuildBenchmark === 'function' && "
                "typeof window.runCompletedWorkBenchmark === 'function'",
                timeout=120_000,
            )

            browser_environment = page.evaluate("""() => ({
                userAgent: navigator.userAgent,
                babylonVersion: BABYLON?.Engine?.Version ?? null,
                devicePixelRatio: window.devicePixelRatio,
                compute: window.__engineHasCompute
            })""")
            document["runner"]["browserEnvironment"] = browser_environment
            document["runner"]["browserVersion"] = browser.version
            write_outputs(output_dir, document)

            # Rebuild must run first because the fixed-frame benchmark takes
            # exclusive control of, and intentionally stops, the normal render loop.
            if not args.skip_rebuild:
                is_appendix_case = (
                    abs(rebuild_history_days - 300) < 1e-12
                    and abs(rebuild_particles_per_day - 16_500) < 1e-12
                    and abs(rebuild_dt_days - 0.1) < 1e-12
                )
                logger.write(
                    f"Starting tail rebuild: {rebuild_history_days:g} days, "
                    f"{rebuild_particles_per_day:g} particles/day, dt={rebuild_dt_days:g} days"
                )
                rebuild_options = {
                    "scenarioName": (
                        "67P_2021-09-06_appendixA_history_and_rate"
                        if is_appendix_case else "custom_67P_tail_rebuild"
                    ),
                    "runs": rebuild_runs,
                    "historyDays": rebuild_history_days,
                    "particlesPerDay": rebuild_particles_per_day,
                    "dtDays": rebuild_dt_days,
                    "renderWidth": args.width,
                    "renderHeight": args.height,
                    "cooldownMs": max(args.cooldown_ms, 1000),
                }
                rebuild_result = page.evaluate(
                    "options => window.runTailRebuildBenchmark(options)", rebuild_options
                )
                document["rebuildResults"].append(rebuild_result)
                write_outputs(output_dir, document)
                logger.write(
                    f"Finished tail rebuild: {rebuild_result['summary']['medianSeconds']:.3f} s median, "
                    f"{rebuild_result['summary']['medianFinalActiveParticles']:,.0f} active particles, "
                    f"valid={rebuild_result['summary']['allRunsValid']}"
                )

            for count in args.counts:
                for mode in args.modes:
                    logger.write(f"Starting mode={mode}, particles={count:,}")
                    options = {
                        "count": count,
                        "mode": mode,
                        "runs": runs,
                        "framesPerRun": frames_per_run,
                        "warmupFrames": warmup_frames,
                        "maxInFlightFrames": args.max_in_flight_frames,
                        "fixedDtSeconds": args.fixed_dt_seconds,
                        "renderWidth": args.width,
                        "renderHeight": args.height,
                        "cooldownMs": args.cooldown_ms,
                    }
                    result = page.evaluate("options => window.runCompletedWorkBenchmark(options)", options)
                    document["results"].append(result)
                    write_outputs(output_dir, document)
                    logger.write(
                        f"Finished mode={mode}, particles={count:,}: "
                        f"{result['summary']['medianFrameMs']:.4f} ms/frame, "
                        f"{result['summary']['medianCompletedFps']:.2f} completed FPS"
                    )

            document["status"] = "complete"
            document["finishedAt"] = dt.datetime.now().astimezone().isoformat()
            write_outputs(output_dir, document)
            logger.write("Benchmark complete. JSON and CSV files have been saved.")
            context.close()
            browser.close()
        return 0
    except Exception as exc:
        document["status"] = "failed"
        document["finishedAt"] = dt.datetime.now().astimezone().isoformat()
        document["error"] = str(exc)
        document["traceback"] = traceback.format_exc()
        write_outputs(output_dir, document)
        logger.write(f"FAILED: {exc}")
        logger.write(f"Partial results remain in {output_dir}")
        return 1
    finally:
        prevent_windows_sleep(False)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
