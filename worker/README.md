# AutoCut Drive AI — Guía del Worker Nativo para Windows 11 (0 €)

Este worker en Node.js (`worker/pc-worker.mjs`, **sin dependencias npm externas**) vigila tu carpeta local de **Google Drive** cada 3 segundos, procesa con **FFmpeg nativo** los trabajos pesados (>100 MB o Multi-Clip) que envíes desde el móvil y devuelve los `.mp4` terminados a `_AutoCut_Output/`, actualizando el progreso en tiempo real para la PWA.

---

## Cómo funciona el buzón de Google Drive

1. Desde el móvil (PWA), pulsas **«Enviar render a PC»** en **Estudio de cortes**.
2. La PWA sube un archivo ligero `job_<id>.json` a `_AutoCut_Jobs/` (sin descargar los brutos en el móvil).
3. Este worker detecta el JSON, lee los vídeos brutos desde tu disco local, renderiza en **9:16** con GPU NVIDIA (`h264_nvenc`) o CPU (`libx264 -preset fast`) y guarda el resultado final en `_AutoCut_Output/`.
4. En el móvil pulsas **«Actualizar estado PC»** en **Cola** o **Galería** para ver el estado y descargar el MP4.

---

## Paso 1 — Instalar requisitos en Windows 11

1. **Node.js 18 o superior** (recomendado LTS 22): [https://nodejs.org/](https://nodejs.org/)
2. **FFmpeg nativo** desde PowerShell o Terminal de Windows:

```powershell
winget install Gyan.FFmpeg
```

3. **Cierra y vuelve a abrir PowerShell** para que recargue el `PATH` del sistema, y comprueba que responde correctamente:

```powershell
ffmpeg -version
node -v
```

Si ambos muestran su versión sin error, el entorno de renderizado está listo.

---

## Paso 2 — Instalar y sincronizar Google Drive para ordenadores

1. Descarga e instala [Google Drive para ordenadores](https://www.google.com/drive/download/) e inicia sesión con la **misma cuenta de Google** que usas en la PWA.
2. Localiza la ruta exacta de tu carpeta configurada en **Ajustes** de AutoCut Drive AI, por ejemplo:
   - `G:\Mi unidad\AutoCut_Videos`

### Nota importante: modo *Streaming* vs. *Disponible sin conexión*
- **Modo *Streaming* (por defecto en `G:\`)**: funciona bien porque Google Drive descarga los archivos bajo demanda cuando FFmpeg los abre, pero si subes varios brutos pesados desde el iPhone, FFmpeg tendrá que esperar a que Drive baje cada clip en ese momento (o puede fallar si el archivo aún no terminó de aparecer en `G:\`).
- **Recomendación (*Disponible sin conexión*)**: haz clic derecho sobre tu carpeta de vídeos en el Explorador de Windows → **Acceso sin conexión → Disponible sin conexión** (o usa el modo *Duplicar archivos*). Así tus brutos estarán ya en el SSD local y el renderizado con `h264_nvenc` arrancará al instante.

---

## Paso 3 — Prueba manual en primer plano (y verificación de GPU NVIDIA)

Antes de automatizar el arranque, haz una prueba rápida en PowerShell desde la raíz del repositorio:

```powershell
npm run worker -- --dir "G:\Mi unidad\AutoCut_Videos"
```

*(También puedes usar la variable de entorno `$env:AUTOCUT_DRIVE_DIR = "G:\Mi unidad\AutoCut_Videos"; npm run worker`.)*

Comprueba la línea de arranque en consola:
- Si tienes tarjeta gráfica **NVIDIA** compatible y drivers al día, verás:
  ```text
  "encoder": "h264_nvenc (GPU NVIDIA)"
  ```
- Si tu equipo no tiene GPU NVIDIA o los drivers no soportan NVENC, el worker realiza una prueba real de 0.1 s y cambia automáticamente sin fallar a:
  ```text
  "encoder": "libx264 (CPU)"
  ```

Envía un vídeo de prueba desde el móvil con **«Enviar render a PC»** y verifica que el worker procesa el corte y deja el `.mp4` en `_AutoCut_Output/`. Pulsa `Ctrl + C` cuando confirmes que funciona.

---

## Paso 4 — Arranque automático en segundo plano al iniciar sesión (Windows 11)

Para que el worker funcione solo cada vez que enciendas el PC **sin ventana negra molesta**, usa la plantilla incluida y regístrala en el **Programador de tareas de Windows**:

### 4.1. Crea tu script personal desde la plantilla

En la carpeta del proyecto, copia la plantilla:

```powershell
Copy-Item worker\start-worker.example.ps1 worker\start-worker.ps1
```

> `worker/start-worker.ps1` y `worker/worker.log` están en `.gitignore`, así que tus rutas personales y tus logs **nunca se subirán a GitHub**.

Abre `worker\start-worker.ps1` y edita únicamente las dos variables del inicio:

```powershell
$projectDir = "C:\Users\TU_USUARIO\proyectos\autocut-drive-ai"
$driveDir   = "G:\Mi unidad\AutoCut_Videos"
```

### 4.2. Registra la tarea programada desde PowerShell

Ejecuta este bloque en PowerShell (ajusta `$scriptPath` a la ruta real de tu `worker\start-worker.ps1`). Configura:
- Disparo **al iniciar sesión** con **retraso de 30 segundos (`PT30S`)** para dar tiempo a que Google Drive monte `G:\`.
- Ejecución en segundo plano **sin ventana visible** (`-WindowStyle Hidden`).
- **Sin límite máximo de duración** (`ExecutionTimeLimit` en `0`).
- **Reinicio automático en caso de fallo** (hasta 3 reintentos cada 1 minuto).

```powershell
$taskName   = "AutoCutDriveAI-PCWorker"
$scriptPath = "C:\Users\TU_USUARIO\proyectos\autocut-drive-ai\worker\start-worker.ps1"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

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
  -Description "Worker FFmpeg nativo de AutoCut Drive AI (vigila _AutoCut_Jobs en Google Drive)" `
  -Force
```

Para arrancarla inmediatamente sin reiniciar el PC:

```powershell
Start-ScheduledTask -TaskName "AutoCutDriveAI-PCWorker"
```

---

## Paso 5 — Comandos rápidos de PowerShell (logs y control)

### Ver el log en tiempo real
```powershell
Get-Content -Path "worker\worker.log" -Tail 40 -Wait
```
*(Pulsa `Ctrl + C` para dejar de mirar el log; el worker seguirá corriendo en segundo plano.)*

### Comprobar si la tarea está activa
```powershell
Get-ScheduledTask -TaskName "AutoCutDriveAI-PCWorker" | Select-Object TaskName, State
```

### Detener el worker manualmente
```powershell
Stop-ScheduledTask -TaskName "AutoCutDriveAI-PCWorker"
```

### Desactivar el arranque automático (sin borrar la tarea)
```powershell
Disable-ScheduledTask -TaskName "AutoCutDriveAI-PCWorker"
```

### Volver a activarlo o eliminar la tarea por completo
```powershell
# Volver a activar
Enable-ScheduledTask -TaskName "AutoCutDriveAI-PCWorker"

# Eliminar la tarea del Programador de tareas
Unregister-ScheduledTask -TaskName "AutoCutDriveAI-PCWorker" -Confirm:$false
```

---

## Opciones CLI de `worker/pc-worker.mjs`

| Opción | Descripción |
| --- | --- |
| `--dir <ruta>` / `-d <ruta>` | Carpeta local de Google Drive sincronizada (anula `AUTOCUT_DRIVE_DIR`). |
| `--interval <ms>` | Intervalo de vigilancia de `_AutoCut_Jobs/` en ms (por defecto `3000`). |
| `--cpu` | Fuerza codificación por CPU (`libx264 -preset fast`) aunque exista GPU NVIDIA. |
| `--ffmpeg <ruta>` | Ruta explícita a `ffmpeg.exe` si no está en el `PATH`. |
| `--once` | Procesa los trabajos `pending` actuales una vez y sale. |
| `--help` | Muestra la ayuda rápida en español. |

---

## Solución rápida de problemas

- **«No se encontró FFmpeg»**: ejecuta `winget install Gyan.FFmpeg`, cierra y abre PowerShell, o pasa `--ffmpeg "C:\ruta\a\ffmpeg.exe"`.
- **«La carpeta de Google Drive no está disponible» al arrancar Windows**: aumenta `$trigger.Delay` a `"PT60S"` o sube `$maxWaitSec` en `worker\start-worker.ps1`.
- **«No se encontró el vídeo fuente»**: espera unos segundos a que Google Drive para ordenadores sincronice el bruto en tu carpeta local (o marca la carpeta como *Disponible sin conexión*).
- **El trabajo se queda en «En cola PC» en el móvil**: revisa `worker\worker.log` y verifica que `$driveDir` coincide exactamente con la carpeta configurada en **Ajustes** de la PWA.
