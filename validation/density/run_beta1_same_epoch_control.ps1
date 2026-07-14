<#
.SYNOPSIS
    Run the same-epoch Case 1 COMTAILS control with beta_max = 1.

.DESCRIPTION
    Regenerates only the 67P perihelion, gamma=0.1 COMTAILS reference after
    raising r_min from 0.1 um to 0.1985 um. For rho=3000 kg/m^3 and Qpr=1,
    COMTAILS uses beta = 1.191e-3/(2*rho*a), so r_min=1.985e-7 m gives
    beta_max=1 exactly. The new reference is compared with the already archived
    matched-size GPU Case 1 cube, whose beta^1.9 distribution is capped at 1.

    Primary result directories are not modified. Outputs go to
    results_67P_hemi_peri_beta1/.
#>
param(
    [int] $Resolution = 256,
    [ValidateRange(1, 64)] [int] $Processes = 8,
    [string] $ValidationDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$env:MPLBACKEND = "Agg"

$rminM = 1.985e-7
$regen = Join-Path $ValidationDir "regenerate_comtails_cases.ps1"
$analyze = Join-Path $ValidationDir "analyze_density.py"
$visualize = Join-Path $ValidationDir "visualize_density_comparison.py"
$controlDir = Join-Path $ValidationDir "results_67P_hemi_peri_beta1"
$comtails = Join-Path $controlDir "comtails_density_cube.npz"
$simMeta = Join-Path $ValidationDir "results_67P_hemi_peri\gpu_density_cube_JD2457248.50_64_sp39_meta.json"
$comparison = Join-Path $controlDir "beta1_control_comparison.json"

if (-not (Test-Path $simMeta)) {
    throw "Missing matched GPU Case 1 cube: $simMeta"
}

Write-Host "Running same-epoch beta_max=1 COMTAILS control..." -ForegroundColor Cyan
& $regen -Cases 1 -Resolution $Resolution -Processes $Processes `
    -RminOverrideM $rminM -ResultSuffix "_beta1"
if ($LASTEXITCODE -ne 0) { throw "COMTAILS control generation failed (exit $LASTEXITCODE)." }
if (-not (Test-Path $comtails)) { throw "Control cube was not produced: $comtails" }

Write-Host "Comparing against the archived matched GPU Case 1 cube..." -ForegroundColor Cyan
python $analyze compare $comtails $simMeta --out $comparison
if ($LASTEXITCODE -ne 0) { throw "Density comparison failed (exit $LASTEXITCODE)." }

python $visualize --comtails $comtails --sim-meta $simMeta `
    --mode profiles --save-dir $controlDir
if ($LASTEXITCODE -ne 0) { throw "Control profile figure failed (exit $LASTEXITCODE)." }

$report = Get-Content $comparison -Raw | ConvertFrom-Json
$rho = $report.rho_num
Write-Host ""
Write-Host "Same-epoch beta_max=1 result" -ForegroundColor Green
Write-Host ("  shape cosine : {0:F6}" -f $rho.shape_cosine)
Write-Host ("  overlap      : {0:F6}" -f $rho.shape_overlap)
Write-Host "  report       : $comparison"
Write-Host "  provenance   : $(Join-Path $controlDir 'dmdt.used.dat')"
