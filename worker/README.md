# AutoCut Drive AI — Worker Principal para PC Windows (GPU NVIDIA · 0 €)

Este worker (`worker/pc-worker.mjs`, **sin dependencias npm externas**) convierte tu PC Windows con GPU NVIDIA (por ejemplo RTX 2080 Super / 32 GB RAM) en el **motor principal de análisis y renderizado** de AutoCut Drive AI, mientras **GitHub Actions** queda como respaldo automático cuando el PC esté apagado.

## Qué hace el PC worker

1. **Heartbeat automático**: escribe `_AutoCut_Jobs/_worker_status.json` cada 60 s con su estado (`lastSeen`, `encoder`, `whisperDevice`, `whisperModel`, `busy`) para que la PWA sepa si el PC está **En línea** o **Apagado**.
2. **Análisis multimodal con GPU (`analyze_<id>.json` con `target: "pc"`)**:
   - Transcribe con `faster-whisper` en **CUDA (`float16`)** (con fallback automático a CPU `int8` si CUDA falla) y guarda la transcripción en caché en `_AutoCut_Jobs/_cache/`.
   - Ejecuta las fases **A / B / C** de Gemini (proxy + vídeo + audio + guion global + revisión) y escribe el plan final con `status: "analyzed"`.
3. **Renderizado nativo (`job_<id>.json` con `target: "pc"`)**:
   - Renderiza en **9:16** con aceleración **NVIDIA NVENC (`h264_nvenc`)** (o `libx264` si se fuerza `--cpu`), HDR→SDR BT.709, `-14 LUFS` en 2 pasadas y subtítulos ASS reales.
   - Guarda el `.mp4` terminado en `_AutoCut_Output/`.
4. **Reclamación atómica y logs seguros**:
   - Evita colisiones entre PC y nube mediante `claimedBy` + verificación doble antes de procesar.
   - Escribe telemetría estructural en `worker/logs/pc-worker.log` con rotación automática (máx. 5 archivos × 5 MB), **sin tokens, claves API, transcripciones ni nombres de archivo**.

---

## Instalación paso a paso (Windows 11)

Ejecuta los pasos en orden en **PowerShell**.

### 1. Instalar herramientas base (Node.js, FFmpeg y Python 3.11)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
winget install Python.Python.3.11
```

Cierra y vuelve a abrir PowerShell para recargar el `PATH`, y comprueba las versiones:

```powershell
node -v
ffmpeg -version
python --version
```

### 2. Instalar `faster-whisper` y librerías CUDA para GPU NVIDIA

Instala el motor de transcripción y las librerías CUDA 12 (no hace falta instalar el CUDA Toolkit completo de varios GB):

```powershell
pip install --upgrade faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12
```

### 3. Verificar que la GPU NVIDIA responde (NVENC + Whisper CUDA)

Comprueba primero el driver NVIDIA y la tarjeta:

```powershell
nvidia-smi
```

Comprueba ahora que `faster-whisper` carga en GPU (`cuda` / `float16`):

```powershell
python -c "from faster_whisper import WhisperModel; m = WhisperModel('small', device='cuda', compute_type='float16'); print('CUDA OK')"
```

- Si imprime `CUDA OK`, la transcripción correrá en tu GPU en segundos.
- Si aparece un error de DLL/CUDA (por ejemplo driver desactualizado), actualiza los drivers **NVIDIA Game Ready / Studio**; mientras tanto, `worker/transcribe.py` caerá automáticamente a CPU `int8` sin abortar el trabajo.

### 4. Instalar Google Drive para ordenadores

1. Instala [Google Drive para ordenadores](https://www.google.com/drive/download/) e inicia sesión con la **misma cuenta** que usas en la PWA.
2. Localiza tu carpeta de vídeos (ej. `G:\Mi unidad\AutoCut_Videos`).
3. Haz clic derecho sobre esa carpeta en el Explorador → **Acceso sin conexión → Disponible sin conexión** para que los brutos estén en el SSD local sin esperas de streaming.

### 5. Configurar `worker/.env.local` (privado, ignorado por Git)

Copia la plantilla sin secretos y edítala:

```powershell
Copy-Item worker\.env.example worker\.env.local
notepad worker\.env.local
```

Rellena las variables:

```ini
GEMINI_API_KEY=tu_clave_de_gemini
AUTOCUT_DRIVE_DIR=G:\Mi unidad\AutoCut_Videos
WHISPER_MODEL=medium
WHISPER_DEVICE=auto
```

> `worker/.env.local` y `worker/logs/` están en `.gitignore` y **nunca** se suben al repositorio.

### 6. Hacer una prueba manual en primer plano

Arranca el worker manualmente desde la raíz del proyecto:

```powershell
npm run worker
```

Verifica en la salida que:
- Detecta `"encoder": "h264_nvenc"` (GPU NVIDIA).
- Publica `_AutoCut_Jobs/_worker_status.json`.
- En la PWA (**Ajustes → Estado del PC**) aparece el badge **`EN LÍNEA`**.

Pulsa `Ctrl + C` cuando confirmes que funciona.

### 7. Activar el arranque automático al iniciar sesión (en segundo plano)

Ejecuta el instalador incluido desde la raíz del proyecto:

```powershell
powershell -ExecutionPolicy Bypass -File worker\install-autostart.ps1
```

Este script:
1. Genera `worker\start-worker.ps1` (en `.gitignore`), que carga `worker\.env.local` y espera hasta 60 s a que `G:\` se monte.
2. Registra la tarea programada **`AutoCut PC Worker`** (`-AtLogOn`, retraso 30 s, `-WindowStyle Hidden`, sin límite de ejecución, 3 reintentos cada 1 min).
3. Arranca la tarea inmediatamente en segundo plano.

Para desinstalar el arranque automático en cualquier momento:

```powershell
powershell -ExecutionPolicy Bypass -File worker\uninstall-autostart.ps1
```

---

## Comandos útiles de operación y logs

```powershell
# Ver el log rotativo en tiempo real (solo telemetría segura, sin secretos ni nombres de archivo)
Get-Content -Path "worker\logs\pc-worker.log" -Tail 50 -Wait

# Ver estado de la tarea programada
Get-ScheduledTask -TaskName "AutoCut PC Worker" | Select-Object TaskName, State

# Detener o reiniciar manualmente
Stop-ScheduledTask -TaskName "AutoCut PC Worker"
Start-ScheduledTask -TaskName "AutoCut PC Worker"
```

## Opciones CLI de `worker/pc-worker.mjs`

| Opción | Descripción |
| --- | --- |
| `--dir <ruta>` / `-d <ruta>` | Carpeta local de Google Drive (anula `AUTOCUT_DRIVE_DIR`). |
| `--interval <ms>` | Intervalo de escaneo de `_AutoCut_Jobs/` en ms (por defecto `3000`). |
| `--cpu` | Fuerza `libx264` en CPU en lugar de NVENC. |
| `--ffmpeg <ruta>` | Ruta explícita a `ffmpeg.exe`. |
| `--once` | Procesa los trabajos `pending` actuales una vez y termina. |
| `--help` | Muestra la ayuda rápida. |
