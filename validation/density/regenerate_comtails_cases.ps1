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

    The 3 cases use COMTAILS mode 2 with expocos=0: directions are uniform on
    the sunward hemisphere and the speed magnitude is independent of direction.
    This exactly matches the simulator's expcos=0 direction sampler.

        1  run_V   67P hemisphere, gamma=0.1, PERIHELION   (rh 1.24 AU)   [anchor]
        2  g07     67P hemisphere, gamma=0.7, perihelion   (rh 1.24 AU)   [gamma axis]
        3  run_J   67P hemisphere, gamma=0.1, +100d post-peri (rh 1.71 AU)[epoch axis]

.PARAMETER Cases
    Which cases to run: any of 1,2,3 (default: all).
        .\regenerate_comtails_cases.ps1 -Cases 2,3

.PARAMETER ComtailsDir
    Path to py_COMTAILS-main (where main.py lives).

.PARAMETER WorkRoot
    Writable scratch directory. COMTAILS writes several products to ./output
    regardless of --output-dir, so each case is run from an isolated directory
    here. The COMTAILS checkout and paper-run inputs remain untouched.

.PARAMETER RminOverrideM
    Optional replacement for the r_min column of the copied dmdt.dat, in metres.
    The source COMTAILS inputs are never modified.

.PARAMETER ResultSuffix
    Optional suffix appended to the normal result directory. Use this with an
    input override to keep a control run separate from the primary references.

.PARAMETER SmokeTest
    Run tiny 16^3, 4-time-bin, 3-size-bin, 8-direction-event jobs and stage them
    under _smoke_case_<N>. This validates configuration and execution without
    replacing production reference cubes.

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
    [string] $ValidationDir = $PSScriptRoot,   # this script lives in validation/density/
    [string] $WorkRoot = (Join-Path ([System.IO.Path]::GetTempPath()) "comtails_density_validation"),
    [ValidateRange(1, 64)] [int] $Processes = 8,
    [double] $RminOverrideM = [double]::NaN,
    [string] $ResultSuffix = "",
    [switch] $SmokeTest
)

$ErrorActionPreference = "Stop"

# ── Case table ───────────────────────────────────────────────────────────────
$CASE_TABLE = @{
    1 = @{ label  = "Case 1: run_V  67P hemi gamma=0.1 PERIHELION (rh 1.24)";
           input  = "$PaperRuns\sweep0\run_V_67p_iso_peri\input";
           config = "TAIL_INPUTS.dat";                   # base (500) config; rewritten to -Resolution below
           result = "results_67P_hemi_peri";
           obsjd  = "2457248.5"; gamma = "0.1" }
    2 = @{ label  = "Case 2: g07    67P hemi gamma=0.7 perihelion (rh 1.24)";
           input  = "$PaperRuns\_paper_sweep_iso_controls\g07_canon\input";
           config = "TAIL_INPUTS.dat";
           result = "results_67P_hemi_gamma07";
           obsjd  = "2457248.5"; gamma = "0.7" }
    3 = @{ label  = "Case 3: run_J  67P hemi gamma=0.1 +100d POST-PERI (rh 1.71)";
           input  = "$PaperRuns\sweep0\run_J_tail500\input";
           config = "TAIL_INPUTS.dat";
           result = "results_67P_hemi_postperi";
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

$sourceMainPy = Join-Path $ComtailsDir "main.py"
if (-not (Test-Path $sourceMainPy)) {
    Write-Host "ERROR: cannot find $sourceMainPy — check -ComtailsDir." -ForegroundColor Red
    exit 1
}

$resolvedWorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
New-Item -ItemType Directory -Force -Path $resolvedWorkRoot | Out-Null
# Mirror only executable source into writable scratch space. Numba's cache=True
# decorators create files beside the imported modules, so importing directly
# from a read-only/reference checkout can stall before argument parsing.
$codeRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedWorkRoot "_code"))
if (-not $codeRoot.StartsWith($resolvedWorkRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use code scratch path outside WorkRoot: $codeRoot"
}
if (Test-Path $codeRoot) { Remove-Item -LiteralPath $codeRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $codeRoot | Out-Null
Copy-Item -Path (Join-Path $ComtailsDir "*.py") -Destination $codeRoot -Force
foreach ($sourceDir in @("fits", "horizons", "models", "orbital", "utils", "visualization")) {
    Copy-Item -Path (Join-Path $ComtailsDir $sourceDir) -Destination $codeRoot -Recurse -Force
}
# Correct the multiprocessing-only chunk boundary in the scratch mirror. The
# worker's upper bound is already exclusive; subtracting one per chunk drops a
# time bin from every task (and makes all one-bin smoke-test tasks empty). The
# serial path intentionally excludes only the global observation endpoint.
$scratchDustTail = Join-Path $codeRoot "models\dust_tail.py"
$workerSource = Get-Content $scratchDustTail -Raw
$oldLoop = "for itime in range(itime_start, itime_end - 1):"
$newLoop = "for itime in range(itime_start, min(itime_end, config.ntimes - 1)):"
if (-not $workerSource.Contains($oldLoop)) {
    throw "Expected COMTAILS worker-loop boundary was not found; refusing an unverified run."
}
$workerSource = $workerSource.Replace($oldLoop, $newLoop)
$oldPoolSize = "n_proc = multiprocessing.cpu_count()"
$newPoolSize = "n_proc = min($Processes, multiprocessing.cpu_count())"
if (-not $workerSource.Contains($oldPoolSize)) {
    throw "Expected COMTAILS pool-size assignment was not found; refusing an unverified run."
}
$workerSource = $workerSource.Replace($oldPoolSize, $newPoolSize)
Set-Content -Path $scratchDustTail -Value $workerSource -Encoding UTF8
Write-Host "Scratch-only COMTAILS chunk-boundary correction applied; worker pool capped at $Processes." -ForegroundColor Green
$mainPy = Join-Path $codeRoot "main.py"
$completed = @()
$failed    = @()
$nextSteps = @()

foreach ($c in ($Cases | Sort-Object -Unique)) {
    if (-not $CASE_TABLE.ContainsKey($c)) { Write-Host "Unknown case $c — skipping." -ForegroundColor Yellow; continue }
    $case   = $CASE_TABLE[$c]
    $sourceInput = $case.input
    $cfg    = $case.config
    $resName = if ($SmokeTest) { "_smoke_case_$c" } else { $case.result + $ResultSuffix }
    $resDir = Join-Path $ValidationDir $resName
    if (-not (Test-Path (Join-Path $sourceInput $cfg))) {
        Write-Host "FAILED: config $cfg not found in $sourceInput — skipping." -ForegroundColor Red
        $failed += $c; continue
    }
    $caseWork = [System.IO.Path]::GetFullPath((Join-Path $resolvedWorkRoot "case_$c"))
    if (-not $caseWork.StartsWith($resolvedWorkRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use scratch path outside WorkRoot: $caseWork"
    }
    if (Test-Path $caseWork) { Remove-Item -LiteralPath $caseWork -Recurse -Force }
    $indir = Join-Path $caseWork "input"
    New-Item -ItemType Directory -Force -Path $indir | Out-Null
    Copy-Item -Path (Join-Path $sourceInput "*") -Destination $indir -Recurse -Force

    Write-Host ""
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host $case.label -ForegroundColor Cyan
    Write-Host "  Source: $sourceInput  ($cfg)"
    Write-Host "  Work  : $caseWork"
    Write-Host "  Result: $resDir"
    Write-Host "======================================" -ForegroundColor Cyan

    # Rewrite the base config to the requested cube resolution: set image dims to
    # N,N and rescale arcsec/px = 1500/N so the FOV (physical extent) is unchanged
    # — only the voxel count drops. (Same transform as run_V's TAIL_INPUTS_64cube.)
    $runResolution = if ($SmokeTest) { 16 } else { $Resolution }
    $scale  = [string]([math]::Round(1500.0 / $runResolution, 6))
    $genCfg = "TAIL_INPUTS_$($runResolution)cube_hemi_val.dat"
    # COMTAILS configs are fixed positional format and come in two flavors:
    # annotated ("500,500  ! Image dimensions") and bare ("500,500"). Detect the
    # image-dims line by its VALUE (first line that is two bare integers) — every
    # earlier line carries a decimal/sign — and the scale is the line right after.
    $lines  = Get-Content (Join-Path $indir $cfg)
    if ($lines.Count -lt 10) {
        Write-Host "FAILED case ${c}: COMTAILS config is shorter than the required positional format." -ForegroundColor Red
        $failed += $c; continue
    }
    # Match the browser validation exactly. COMTAILS mode 2 samples a uniform
    # sunward hemisphere; expocos=0 leaves the speed magnitude independent of
    # solar zenith angle. The browser's expcos=0 sampler has the same PDF.
    $lines[3] = "2".PadRight(16) + "! Ejection mode 2: uniform sunward hemisphere"
    $lines[9] = "0.".PadRight(16) + "! expocos=0: angle-independent speed (matched to browser)"
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
    $lines[$dimsIdx]     = ("{0},{1}" -f $runResolution, $runResolution).PadRight(16) + "! Image dimensions NX x NY (validation regen @ $runResolution)"
    $lines[$dimsIdx + 1] = $scale.PadRight(16) + "! Image scale arcsec/px = 1500/$runResolution (FOV preserved)"
    if ($SmokeTest) {
        $lines[$dimsIdx + 2] = "4".PadRight(16) + "! Number of time bins (smoke test)"
        $lines[$dimsIdx + 3] = "3".PadRight(16) + "! Number of size bins (smoke test)"
        $lines[$dimsIdx + 4] = "8".PadRight(16) + "! Number of directional events (smoke test)"
    }
    Set-Content -Path (Join-Path $indir $genCfg) -Value $lines -Encoding ASCII
    Write-Host "  Cube resolution: $($runResolution)^3  (scale $scale arcsec/px, FOV preserved)"

    # Optional controlled grain cutoff. dmdt.dat columns are
    # days, log10(dM/dt), velocity factor, size power, r_min[m], r_max[m].
    # Only r_min is changed; the source paper-run input remains untouched.
    $dustProfile = Join-Path $indir "dmdt.dat"
    if (-not [double]::IsNaN($RminOverrideM)) {
        if ($RminOverrideM -le 0) { throw "-RminOverrideM must be positive." }
        if (-not (Test-Path $dustProfile)) { throw "Cannot apply r_min override: missing $dustProfile" }
        $rminText = [string]::Format([Globalization.CultureInfo]::InvariantCulture, "{0:E8}", $RminOverrideM)
        $profileLines = Get-Content $dustProfile
        for ($j = 0; $j -lt $profileLines.Count; $j++) {
            $trimmed = $profileLines[$j].Trim()
            if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
            $parts = $trimmed -split '\s+'
            if ($parts.Count -lt 6) { throw "Unexpected dmdt.dat row: $($profileLines[$j])" }
            $parts[4] = $rminText
            $profileLines[$j] = " " + ($parts -join "   ")
        }
        Set-Content -Path $dustProfile -Value $profileLines -Encoding ASCII
        Write-Host "  Grain cutoff override: r_min = $rminText m" -ForegroundColor Green
    }

    $t0 = Get-Date
    Push-Location $caseWork
    try {
        python $mainPy --numba --input-dir $indir --config $genCfg --dust-profile dmdt.dat
    } finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: case $c (python exit $LASTEXITCODE)." -ForegroundColor Red
        $failed += $c; continue
    }

    $srcCube = Join-Path $caseWork "output\density_cube.npz"
    if (-not (Test-Path $srcCube)) {
        Write-Host "FAILED: case $c produced no density_cube.npz." -ForegroundColor Red
        $failed += $c; continue
    }

    New-Item -ItemType Directory -Force -Path $resDir | Out-Null
    Copy-Item $srcCube (Join-Path $resDir "comtails_density_cube.npz") -Force
    $srcFits = Join-Path $caseWork "output\density_cube.fits"
    if (Test-Path $srcFits) {
        Copy-Item $srcFits (Join-Path $resDir "comtails_density_cube.fits") -Force
    }
    Copy-Item (Join-Path $indir $genCfg) (Join-Path $resDir "TAIL_INPUTS.used.dat") -Force
    Copy-Item $dustProfile (Join-Path $resDir "dmdt.used.dat") -Force

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

    $cubeRel = "$resName\comtails_density_cube.npz"
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

Write-Host ""
if ($completed.Count -gt 0) { Write-Host "Regenerated cases: $($completed -join ', ')" -ForegroundColor Green }
if ($failed.Count    -gt 0) { Write-Host "Failed cases:      $($failed -join ', ')" -ForegroundColor Red }

if ($nextSteps.Count -gt 0) {
    Write-Host ""
    Write-Host "NEXT — matched sim export + analysis per case:" -ForegroundColor Cyan
    $nextSteps | ForEach-Object { Write-Host $_ }
}





