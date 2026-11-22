# ==============================================================================
# AutoCut Drive AI — Plantilla de arranque del Worker nativo en Windows
# ==============================================================================
# INSTRUCCIONES:
#   1. Copia este archivo como: worker\start-worker.ps1
#      (worker\start-worker.ps1 está en .gitignore para no subir tus rutas a GitHub)
#   2. Edita únicamente las DOS rutas de abajo: $projectDir y $driveDir
#   3. Úsalo manualmente o desde el Programador de tareas de Windows (ver worker\README.md)
# ==============================================================================

$ErrorActionPreference = "Continue"

# 1) RUTA A EDITAR: Carpeta raíz donde clonaste el repositorio AutoCut Drive AI
$projectDir = "C:\Users\TU_USUARIO\proyectos\autocut-drive-ai"

# 2) RUTA A EDITAR: Carpeta local sincronizada de Google Drive configurada en la PWA
$driveDir   = "G:\Mi unidad\AutoCut_Videos"

# Archivo de log local (también ignorado en .gitignore)
$logFile    = Join-Path $projectDir "worker\worker.log"

# Asegura que el directorio de log existe
$logParent = Split-Path -Path $logFile -Parent
if (-not (Test-Path -LiteralPath $logParent)) {
    New-Item -ItemType Directory -Path $logParent -Force | Out-Null
}

function Write-WorkerLog([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] [LAUNCHER] $Message" | Out-File -FilePath $logFile -Encoding utf8 -Append
}

Write-WorkerLog "Iniciando launcher de AutoCut PC Worker..."

if (-not (Test-Path -LiteralPath $projectDir)) {
    Write-WorkerLog "ERROR: No existe la carpeta del proyecto: $projectDir"
    exit 1
}

# Espera adicional por si Google Drive para ordenadores tarda unos segundos en montar G:\
$maxWaitSec = 60
$waitedSec  = 0
while (-not (Test-Path -LiteralPath $driveDir) -and $waitedSec -lt $maxWaitSec) {
    Write-WorkerLog "Esperando a que monte la carpeta de Google Drive ($driveDir)... ($waitedSec/$maxWaitSec s)"
    Start-Sleep -Seconds 5
    $waitedSec += 5
}

if (-not (Test-Path -LiteralPath $driveDir)) {
    Write-WorkerLog "ERROR: La carpeta de Google Drive no está disponible tras $maxWaitSec s: $driveDir"
    exit 1
}

Set-Location -LiteralPath $projectDir
$env:AUTOCUT_DRIVE_DIR = $driveDir

Write-WorkerLog "Lanzando node worker/pc-worker.mjs --dir `"$driveDir`""

# Redirige salida estándar y errores (2>&1) al archivo worker\worker.log
& node "worker/pc-worker.mjs" --dir "$driveDir" *>> $logFile
$exitCode = $LASTEXITCODE
Write-WorkerLog "Worker detenido con código de salida $exitCode."
exit $exitCode
