<#
.SYNOPSIS
    Run the full validation-3 analysis pipeline for all 3 density cases.

.DESCRIPTION
    For each case this:
      1. exports the matched GPU sim cube (run_gpu_density_export.py, launches a
         real-WebGPU browser) at -Gridn, with the case's obs-JD / gamma / bounds,
      2. moves the export (+ its _A/_B halves and _rebuilds stack) into the case
         results dir,
      3. runs analyze_density.py  self / compare / converge,
      4. saves a slices PNG (visualize_density_comparison.py),
    then prints a summary table of compare-cosine vs self-ceiling per case.

    COMTAILS reference cubes must already exist (regenerate_comtails_cases.ps1).
    Use -SkipExport to (re)run only the analysis on sim cubes you already made.

.PARAMETER Gridn
    Sim cube resolution N^3 (default 128). COMTAILS (256^3) is block-averaged down
    to this in analyze_density, so N must divide 256 (64,128,256).

.PARAMETER SkipExport
    Skip the browser export step; analyze the *_<Gridn>_* cubes already in the
    results dirs.

.EXAMPLE
    .\run_validation_analysis.ps1                 # export @128 + analyze all 3
    .\run_validation_analysis.ps1 -Gridn 64       # the original resolution
    .\run_validation_analysis.ps1 -SkipExport     # re-analyze existing exports
#>
param(
    [int[]]  $Cases        = @(1, 2, 3),
    [int]    $Gridn        = 128,
    [int]    $Rebuilds     = 50,
    [double] $SmoothSigma  = 0.5,
    [double] $SizePower    = [double]::NaN,   # set (e.g. -3.9) for a CONTROLLED run: match the grain-size law via the beta curve. NaN = blind.
    [switch] $SkipExport,
    [string] $ValidationDir = $PSScriptRoot    # this script lives in validation/density/
)

$ErrorActionPreference = "Stop"

# Per case: obs-JD, gamma, grid bounds (km), results dir, and the COMTAILS grain
# size law (power, rmin[m]) read from each run's input/dmdt.dat. All three use
# power=-3.9, rho=3000; rmin differs (case 3 = 0.5um -> beta_max~0.40, fully within
# the sim's beta<=1; cases 1-2 = 0.1um -> beta_max~1.99, partly capped).
$CASE_TABLE = @{
    1 = @{ label = "1 peri gamma=0.1 (rh 1.24, anchor)";  obsjd = 2457248.5; gamma = 0.1; nbound = 959606;   lbound = 1439408.9; result = "results_67P_iso_peri";    power = -3.9; rmin = 1e-7 }
    2 = @{ label = "2 peri gamma=0.7 (rh 1.24, g-axis)";  obsjd = 2457248.5; gamma = 0.7; nbound = 959606;   lbound = 1439408.9; result = "results_67P_iso_gamma07"; power = -3.9; rmin = 1e-7 }
    3 = @{ label = "3 +100d gamma=0.1 (rh 1.71, epoch)";  obsjd = 2457348.5; gamma = 0.1; nbound = 960278.5; lbound = 1440417.8; result = "results_67P_iso_postperi"; power = -3.9; rmin = 5e-7 }
}

$controlled = -not [double]::IsNaN($SizePower)

Set-Location $ValidationDir
$summary = @()

foreach ($c in ($Cases | Sort-Object -Unique)) {
    if (-not $CASE_TABLE.ContainsKey($c)) { Write-Host "Unknown case $c - skipping." -ForegroundColor Yellow; continue }
    $case   = $CASE_TABLE[$c]
    $obsStr = "{0:F2}" -f $case.obsjd            # e.g. 2457248.50, matches the python stem
    # Controlled runs tag the stem _sp<round(|power|*10)> so they never collide with blind.
    $spTag  = if ($controlled) { "_sp" + [int][math]::Round([math]::Abs($SizePower) * 10) } else { "" }
    $stem   = "gpu_density_cube_JD${obsStr}_${Gridn}${spTag}"
    $resDir = Join-Path $ValidationDir $case.result

    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "Case $($case.label)   [grid $($Gridn)^3]" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan

    $comtails = Join-Path $resDir "comtails_density_cube.npz"
    if (-not (Test-Path $comtails)) {
        Write-Host "MISSING $comtails - run regenerate_comtails_cases.ps1 first. Skipping." -ForegroundColor Red
        continue
    }

    if (-not $SkipExport) {
        $runMode = if ($controlled) { "controlled (size-power $SizePower, rmin $($case.rmin) m)" } else { "blind" }
        Write-Host "-> exporting sim cube (WebGPU browser) [$runMode]..." -ForegroundColor Gray
        $expArgs = @(
            "run_gpu_density_export.py",
            "--obs-jd", $case.obsjd, "--gamma", $case.gamma, "--v0-mps", 800,
            "--kappa", -0.5, "--rebuilds", $Rebuilds, "--gridn", $Gridn,
            "--nbound", $case.nbound, "--lbound", $case.lbound
        )
        if ($controlled) { $expArgs += @("--size-power", $SizePower, "--rmin", $case.rmin) }
        python @expArgs
        if ($LASTEXITCODE -ne 0) { Write-Host "export FAILED for case $c - skipping." -ForegroundColor Red; continue }

        $produced = Get-ChildItem "_gpu_downloads\$stem*" -ErrorAction SilentlyContinue
        if (-not $produced) { Write-Host "no export files matched $stem* - skipping." -ForegroundColor Red; continue }
        Move-Item "_gpu_downloads\$stem*" $resDir -Force
    }

    $meta  = Join-Path $resDir "${stem}_meta.json"
    $metaA = Join-Path $resDir "${stem}_A_meta.json"
    $metaB = Join-Path $resDir "${stem}_B_meta.json"
    if (-not (Test-Path $meta)) {
        Write-Host "MISSING $meta (export not present). Skipping analysis for case $c." -ForegroundColor Red
        continue
    }

    Write-Host "-> self (noise floor)..."  -ForegroundColor Gray
    if ((Test-Path $metaA) -and (Test-Path $metaB)) {
        python analyze_density.py self $metaA $metaB --out (Join-Path $resDir "self_agreement.json")
    } else {
        Write-Host "   (no _A/_B halves - skipping self)" -ForegroundColor Yellow
    }

    Write-Host "-> compare (vs COMTAILS)..." -ForegroundColor Gray
    python analyze_density.py compare $comtails $meta --out (Join-Path $resDir "density_comparison.json")

    Write-Host "-> converge..." -ForegroundColor Gray
    python analyze_density.py converge $meta --comtails $comtails `
        --out-json (Join-Path $resDir "convergence.json") --out-plot (Join-Path $resDir "convergence.png")

    Write-Host "-> figures (slices, mip, profiles, scatter)..." -ForegroundColor Gray
    foreach ($mode in @("slices", "mip", "profiles", "scatter")) {
        python visualize_density_comparison.py --comtails $comtails --sim-meta $meta `
            --mode $mode --smooth-sigma $SmoothSigma --save-dir $resDir
    }

    # Collect the headline numbers for the summary table.
    $cmpCos = $selfCos = $ovl = "n/a"
    $cmpPath  = Join-Path $resDir "density_comparison.json"
    $selfPath = Join-Path $resDir "self_agreement.json"
    if (Test-Path $cmpPath)  { $j = Get-Content $cmpPath  -Raw | ConvertFrom-Json; $cmpCos  = "{0:F4}" -f $j.rho_num.shape_cosine; $ovl = "{0:F4}" -f $j.rho_num.shape_overlap }
    if (Test-Path $selfPath) { $j = Get-Content $selfPath -Raw | ConvertFrom-Json; $selfCos = "{0:F4}" -f $j.rho_num.shape_cosine }
    $summary += [pscustomobject]@{ Case = $case.label; CompareCos = $cmpCos; SelfCeiling = $selfCos; Overlap = $ovl }
}

$modeStr = if ($controlled) { "CONTROLLED (size-power $SizePower matched)" } else { "BLIND (sim's own beta curve)" }
Write-Host ""
Write-Host "================ SUMMARY (grid $($Gridn)^3, $modeStr) ================" -ForegroundColor Green
$summary | Format-Table -AutoSize
Write-Host "CompareCos vs COMTAILS, read against SelfCeiling (noise floor)." -ForegroundColor Green
Write-Host "Close to ceiling = at noise floor; well below = real model difference." -ForegroundColor Green
if ($controlled) {
    Write-Host "Controlled: cases 1-2 keep a beta>1 cap residual (rmin 0.1um); case 3 is fully representable (rmin 0.5um)." -ForegroundColor Green
}



