param(
    [ValidateSet('smoke', 'standard', 'overnight')]
    [string]$Preset = 'overnight',
    [int[]]$Counts = @(100000, 500000, 1000000, 2000000, 3000000),
    [ValidateSet('compute_only', 'update_render')]
    [string[]]$Modes = @('compute_only', 'update_render'),
    [int]$Runs = 0,
    [int]$FramesPerRun = 0,
    [int]$WarmupFrames = -1,
    [int]$MaxInFlightFrames = 240,
    [double]$FixedDtSeconds = 60,
    [int]$Width = 1920,
    [int]$Height = 1080,
    [switch]$SkipRebuild,
    [int]$RebuildRuns = 0,
    [double]$RebuildHistoryDays = 0,
    [double]$RebuildParticlesPerDay = 0,
    [double]$RebuildDtDays = 0,
    [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'run_completed_work_benchmark.py'
$arguments = @(
    $scriptPath,
    '--preset', $Preset,
    '--counts'
) + ($Counts | ForEach-Object { [string]$_ }) + @(
    '--modes'
) + $Modes + @(
    '--max-in-flight-frames', [string]$MaxInFlightFrames,
    '--fixed-dt-seconds', [string]$FixedDtSeconds,
    '--width', [string]$Width,
    '--height', [string]$Height
)

if ($Runs -gt 0) { $arguments += @('--runs', [string]$Runs) }
if ($FramesPerRun -gt 0) { $arguments += @('--frames-per-run', [string]$FramesPerRun) }
if ($WarmupFrames -ge 0) { $arguments += @('--warmup-frames', [string]$WarmupFrames) }
if ($SkipRebuild) { $arguments += '--skip-rebuild' }
if ($RebuildRuns -gt 0) { $arguments += @('--rebuild-runs', [string]$RebuildRuns) }
if ($RebuildHistoryDays -gt 0) { $arguments += @('--rebuild-history-days', [string]$RebuildHistoryDays) }
if ($RebuildParticlesPerDay -gt 0) { $arguments += @('--rebuild-particles-per-day', [string]$RebuildParticlesPerDay) }
if ($RebuildDtDays -gt 0) { $arguments += @('--rebuild-dt-days', [string]$RebuildDtDays) }
if ($OutputDir) { $arguments += @('--output-dir', $OutputDir) }

Write-Host "Starting the $Preset completed-work benchmark."
Write-Host 'Keep the Chrome window open. The runner will prevent system sleep and save partial results after each case.'
& python @arguments
exit $LASTEXITCODE
