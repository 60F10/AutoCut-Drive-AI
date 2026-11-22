# ==============================================================================
# AutoCut Drive AI — Desinstalador de arranque automático del PC Worker
# ==============================================================================

$ErrorActionPreference = "Stop"

$taskName = "AutoCut PC Worker"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if (-not $existing) {
    Write-Host "La tarea programada '$taskName' no está instalada."
    exit 0
}

try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} catch {
    # Ignore if task is already stopped
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Tarea programada '$taskName' detenida y eliminada correctamente."
