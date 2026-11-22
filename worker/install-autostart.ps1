# ==============================================================================
# AutoCut Drive AI — Instalador de arranque automático del PC Worker (Windows)
# ==============================================================================
# Registra la tarea programada "AutoCut PC Worker" al iniciar sesión del usuario,
# sin ventana visible, con reinicio automático ante fallo y cargando worker/.env.local.
# ==============================================================================

$ErrorActionPreference = "Stop"

$taskName   = "AutoCut PC Worker"
$workerDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $workerDir
$envFile    = Join-Path $workerDir ".env.local"
$launcher   = Join-Path $workerDir "start-worker.ps1"

if (-not (Test-Path -LiteralPath $envFile)) {
    Write-Error "No existe worker\.env.local. Copia worker\.env.example a worker\.env.local, rellena GEMINI_API_KEY y AUTOCUT_DRIVE_DIR, y vuelve a ejecutar este script."
    exit 1
}

# Parse minimal check for AUTOCUT_DRIVE_DIR in worker/.env.local
$configuredDriveDir = ""
Get-Content -LiteralPath $envFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#")) {
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -gt 0) {
            $k = $line.Substring(0, $eqIdx).Trim()
            $v = $line.Substring($eqIdx + 1).Trim().Trim('"').Trim("'")
            if ($k -eq "AUTOCUT_DRIVE_DIR") {
                $configuredDriveDir = $v
            }
        }
    }
}

if (-not $configuredDriveDir) {
    Write-Error "Falta AUTOCUT_DRIVE_DIR en worker\.env.local. Añade la ruta sincronizada de Google Drive y reintenta."
    exit 1
}

# Generate personal gitignored launcher script worker/start-worker.ps1
$launcherContent = @"
`$ErrorActionPreference = "Continue"
`$projectDir = "$projectDir"
`$envFile    = Join-Path `$projectDir "worker\.env.local"

if (Test-Path -LiteralPath `$envFile) {
    Get-Content -LiteralPath `$envFile -Encoding UTF8 | ForEach-Object {
        `$line = `$_.Trim()
        if (`$line -and -not `$line.StartsWith("#")) {
            `$eqIdx = `$line.IndexOf("=")
            if (`$eqIdx -gt 0) {
                `$key = `$line.Substring(0, `$eqIdx).Trim()
                `$val = `$line.Substring(`$eqIdx + 1).Trim().Trim('"').Trim("'")
                if (`$key) {
                    [System.Environment]::SetEnvironmentVariable(`$key, `$val, "Process")
                }
            }
        }
    }
}

`$driveDir = [System.Environment]::GetEnvironmentVariable("AUTOCUT_DRIVE_DIR", "Process")
if (-not `$driveDir) {
    exit 1
}

# Espera hasta 60 s por si Google Drive para ordenadores tarda en montar la unidad
`$maxWaitSec = 60
`$waitedSec  = 0
while (-not (Test-Path -LiteralPath `$driveDir) -and `$waitedSec -lt `$maxWaitSec) {
    Start-Sleep -Seconds 5
    `$waitedSec += 5
}

if (-not (Test-Path -LiteralPath `$driveDir)) {
    exit 1
}

Set-Location -LiteralPath `$projectDir
& node "worker/pc-worker.mjs"
exit `$LASTEXITCODE
"@

Set-Content -LiteralPath $launcher -Value $launcherContent -Encoding UTF8

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "AutoCut Drive AI — PC Worker (análisis Whisper GPU + Gemini y render FFmpeg NVENC)" `
    -Force | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Host "Tarea programada '$taskName' instalada e iniciada en segundo plano."
Write-Host "Logs rotativos privados en: worker\logs\pc-worker.log"
