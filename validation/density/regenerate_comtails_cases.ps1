<#
.SYNOPSIS
    Regenerate the COMTAILS reference density cubes for the 3 validation cases,
    using the CURRENT (intrinsic-frame-patched) COMTAILS code.

.DESCRIPTION
    Validation 3 (3D dust density vs COMTAILS) compares cubes in the intrinsic
    cometocentric (n,m,l) frame. That frame only exists in COMTAILS output AFTER
    the heliorbit.py / dust_tail.py patch (it bins on chita/eta/gita instead of
    the sky-projected npar/mpar/lpar). The cubes sitting in paper_runs were made
    BEFORE that patch, so they are in the wrong frame and must be regenerated.

    This script runs the same proven invocation as run_all.ps1
        python main.py --numba --input-dir <case>/input --config <cfg> --dust-profile dmdt.dat
    for each case, then stages the resulting density_cube.npz into
    validation/density/results_<case>/comtails_density_cube.npz where
    analyze_density.py expects it.

    The 3 cases (two orthogonal axes off a common anchor):
        1  run_V   67P isotropic, gamma=0.1, PERIHELION   (rh 1.24 AU)   [anchor]
        2  g07     67P isotropic, gamma=0.7, perihelion   (rh 1.24 AU)   [gamma axis]
        3  run_J   67P isotropic, gamma=0.1, +100d post-peri (rh 1.71 AU)[epoch axis]

.PARAMETER Cases
    Which cases to run: any of 1,2,3 (default: all).
        .\regenerate_comtails_cases.ps1 -Cases 2,3

.PARAMETER ComtailsDir
    Path to py_COMTAILS-main (where main.py lives and ./output is written).

.NOTES
    Run from a shell that can launch the COMTAILS python environment.
    After this, do the matched sim export + analyze_density.py per case
    (the script prints the ready-to-paste commands at the end).
#>
param(
    [int[]]  $Cases       = @(1, 2, 3),
    [int]    $Resolution  = 256,   # cube N^3. >=64 is plenty (analyze_density resamples to the sim's 64^3); 500 OOMs on pickling.
    # COMTAILS lives outside this repo; default assumes vm_comtails is a sibling of
    # the repo root (override with -ComtailsDir / -PaperRuns if your layout differs).
    [string] $ComtailsDir = (Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot))) "vm_comtails\py_COMTAILS-main"),
    [string] $PaperRuns   = (Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot))) "vm_comtails\paper_runs"),
    [string] $ValidationDir = $PSScriptRoot    # this script lives in validation/density/
)

$ErrorActionPreference = "Stop"

# ── Case table ───────────────────────────────────────────────────────────────
$CASE_TABLE = @{
    1 = @{ label  = "Case 1: run_V  67P iso gamma=0.1 PERIHELION (rh 1.24)";
           input  = "$PaperRuns\sweep0\run_V_67p_iso_peri\input";
           config = "TAIL_INPUTS.dat";                   # base (500) config; rewritten to -Resolution below
           result = "results_67P_iso_peri";
           obsjd  = "2457248.5"; gamma = "0.1" }
    2 = @{ label  = "Case 2: g07    67P iso gamma=0.7 perihelion (rh 1.24)";
           input  = "$PaperRuns\_paper_sweep_iso_controls\g07_canon\input";
           config = "TAIL_INPUTS.dat";
           result = "results_67P_iso_gamma07";
           obsjd  = "2457248.5"; gamma = "0.7" }
    3 = @{ label  = "Case 3: run_J  67P iso gamma=0.1 +100d POST-PERI (rh 1.71)";
           input  = "$PaperRuns\sweep0\run_J_tail500\input";
           config = "TAIL_INPUTS.dat";
           result = "results_67P_iso_postperi";
           obsjd  = "2457348.5"; gamma = "0.1" }
}

# ── Guard: confirm the intrinsic-frame patch is actually present ─────────────
# Without it, main.py would write a sky-projected cube and the whole comparison
# would be frame-mismatched. Refuse to run rather than produce a wrong cube.
$dustTail = Join-Path $ComtailsDir "models\dust_tail.py"
if (-not (Test-Path $dustTail)) {
    Write-Host "ERROR: cannot find $dustTail — check -ComtailsDir." -ForegroundColor Red
    exit 1
}
$patchHits = Select-String -Path $dustTail -Pattern "chita_km", "gita_km" -SimpleMatch
if ($patchHits.Count -lt 2) {
    Write-Host "ERROR: intrinsic-frame patch NOT found in models/dust_tail.py." -ForegroundColor Red
    Write-Host "       The 3D cube block must bin on chita_km/eta_km/gita_km (intrinsic frame)." -ForegroundColor Red
    Write-Host "       Apply the patch before regenerating, or the cubes will be sky-projected." -ForegroundColor Red
    exit 1
}
Write-Host "Intrinsic-frame patch detected in dust_tail.py — OK to regenerate." -ForegroundColor Green

# Optional: locate python for the post-run bounds readout (best-effort).
$python = (Get-Command python -ErrorAction SilentlyContinue).Source

Set-Location $ComtailsDir
$completed = @()
$failed    = @()
$nextSteps = @()

foreach ($c in ($Cases | Sort-Object -Unique)) {
    if (-not $CASE_TABLE.ContainsKey($c)) { Write-Host "Unknown case $c — skipping." -ForegroundColor Yellow; continue }
    $case   = $CASE_TABLE[$c]
    $indir  = $case.input
    $cfg    = $case.config
    $resDir = Join-Path $ValidationDir $case.result

    Write-Host ""
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host $case.label -ForegroundColor Cyan
    Write-Host "  Input : $indir  ($cfg)"
    Write-Host "  Result: $resDir"
    Write-Host "======================================" -ForegroundColor Cyan

    if (-not (Test-Path (Join-Path $indir $cfg))) {
        Write-Host "FAILED: config $cfg not found in $indir — skipping." -ForegroundColor Red
        $failed += $c; continue
    }

    # Rewrite the base config to the requested cube resolution: set image dims to
    # N,N and rescale arcsec/px = 1500/N so the FOV (physical extent) is unchanged
    # — only the voxel count drops. (Same transform as run_V's TAIL_INPUTS_64cube.)
    $scale  = [string]([math]::Round(1500.0 / $Resolution, 6))
    $genCfg = "TAIL_INPUTS_$($Resolution)cube_val.dat"
    # COMTAILS configs are fixed positional format and come in two flavors:
    # annotated ("500,500  ! Image dimensions") and bare ("500,500"). Detect the
    # image-dims line by its VALUE (first line that is two bare integers) — every
    # earlier line carries a decimal/sign — and the scale is the line right after.
    $lines  = Get-Content (Join-Path $indir $cfg)
    $dimsIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $val = ($lines[$i] -split '!')[0].Trim()
        if ($val -match '^\d+\s*,\s*\d+$') { $dimsIdx = $i; break }
    }
    if ($dimsIdx -lt 0 -or ($dimsIdx + 1) -ge $lines.Count) {
        Write-Host "FAILED case ${c}: could not locate image dims/scale lines in $cfg." -ForegroundColor Red
        $failed += $c; continue
    }
    $scaleVal = ($lines[$dimsIdx + 1] -split '!')[0].Trim()
    if ($scaleVal -match ',') {
        Write-Host "FAILED case ${c}: line after image dims ('$scaleVal') is not a scalar scale." -ForegroundColor Red
        $failed += $c; continue
    }
    $lines[$dimsIdx]     = ("{0},{1}" -f $Resolution, $Resolution).PadRight(16) + "! Image dimensions NX x NY (validation regen @ $Resolution)"
    $lines[$dimsIdx + 1] = $scale.PadRight(16) + "! Image scale arcsec/px = 1500/$Resolution (FOV preserved)"
    Set-Content -Path (Join-Path $indir $genCfg) -Value $lines -Encoding ASCII
    Write-Host "  Cube resolution: $($Resolution)^3  (scale $scale arcsec/px, FOV preserved)"

    if (Test-Path "output") { Remove-Item -Recurse -Force "output" }

    $t0 = Get-Date
    python main.py --numba --input-dir $indir --config $genCfg --dust-profile dmdt.dat
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: case $c (python exit $LASTEXITCODE)." -ForegroundColor Red
        if (Test-Path "output") { Remove-Item -Recurse -Force "output" }
        $failed += $c; continue
    }

    $srcCube = "output\density_cube.npz"
    if (-not (Test-Path $srcCube)) {
        Write-Host "FAILED: case $c produced no density_cube.npz." -ForegroundColor Red
        $failed += $c; continue
    }

    New-Item -ItemType Directory -Force -Path $resDir | Out-Null
    Copy-Item $srcCube (Join-Path $resDir "comtails_density_cube.npz") -Force
    if (Test-Path "output\density_cube.fits") {
        Copy-Item "output\density_cube.fits" (Join-Path $resDir "comtails_density_cube.fits") -Force
    }
    Copy-Item (Join-Path $indir $genCfg) (Join-Path $resDir "TAIL_INPUTS.used.dat") -Force

    $elapsed = "{0:F1}" -f ((Get-Date) - $t0).TotalMinutes
    Write-Host "Done case $c ($elapsed min) -> $resDir\comtails_density_cube.npz" -ForegroundColor Green
    $completed += $c

    # Best-effort: read the cube's half-extents so the matched sim-export command
    # can be printed with the right --nbound/--lbound.
    $nbound = "<n half-extent km>"; $lbound = "<l half-extent km>"
    if ($python) {
        $cubePath = (Join-Path $resDir "comtails_density_cube.npz") -replace '\\','/'
        $py = "import numpy as np; d=np.load('$cubePath'); " +
              "print(abs(d['n_edges_km'][-1]), abs(d['m_edges_km'][-1]), abs(d['l_edges_km'][-1]))"
        try {
            $vals = (& $python -c $py) -split '\s+'
            if ($vals.Count -ge 3) {
                $nbound = $vals[0]; $lbound = $vals[2]
                if ([math]::Abs([double]$vals[0] - [double]$vals[1]) -gt 1) {
                    Write-Host "  note: n and m half-extents differ ($($vals[0]) vs $($vals[1])); analyze_density resamples, so OK." -ForegroundColor Yellow
                }
            }
        } catch { Write-Host "  (could not read cube bounds via python: $_)" -ForegroundColor Yellow }
    }

    $cubeRel = "$($case.result)\comtails_density_cube.npz"
    $nextSteps += @"
# --- $($case.label) ---
# 1) matched sim export (run in a real-WebGPU browser session):
python run_gpu_density_export.py --obs-jd $($case.obsjd) --gamma $($case.gamma) --v0-mps 800 --kappa -0.5 --rebuilds 50 --nbound $nbound --lbound $lbound
# 2) analyze (point sim_meta at the export written to _gpu_downloads):
python analyze_density.py compare  $cubeRel <sim_meta.json>
python analyze_density.py self      <sim_A_meta.json> <sim_B_meta.json>
python analyze_density.py converge  <sim_meta.json> --comtails $cubeRel
"@
}

Set-Location $ValidationDir
Write-Host ""
if ($completed.Count -gt 0) { Write-Host "Regenerated cases: $($completed -join ', ')" -ForegroundColor Green }
if ($failed.Count    -gt 0) { Write-Host "Failed cases:      $($failed -join ', ')" -ForegroundColor Red }

if ($nextSteps.Count -gt 0) {
    Write-Host ""
    Write-Host "NEXT — matched sim export + analysis per case:" -ForegroundColor Cyan
    $nextSteps | ForEach-Object { Write-Host $_ }
}





