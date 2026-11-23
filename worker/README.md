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

Instala el motor de transcripción y las librerías CUDA 12 en un entorno virtual propio (no hace falta instalar el CUDA Toolkit completo de varios GB):

1. Crea el entorno virtual en la raíz del repositorio:

   ```powershell
   python -m venv worker\.venv
   ```

2. Instala las dependencias del PC:

   ```powershell
   worker\.venv\Scripts\python.exe -m pip install -r worker\requirements-pc.txt
   ```

3. Define en `worker\.env.local` la ruta completa del intérprete: `AUTOCUT_PYTHON_BIN=<repo>\worker\.venv\Scripts\python.exe`.

`worker\requirements-pc.txt` fija `av<16`: las versiones posteriores de PyAV (por ejemplo la 19) fallan con faster-whisper 1.x. En Windows, `transcribe.py` registra por sí solo las carpetas `site-packages\nvidia\*\bin` con `os.add_dll_directory()` y las antepone al `PATH`, así que no necesitas modificar el `PATH` del sistema ni usar un lanzador que lo haga.

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
# Opcionales (consulta la sección "Carpetas de trabajo y almacenamiento")
AUTOCUT_WORK_DIR=E:\AutoCut\tmp
HF_HOME=E:\AutoCut\cache\huggingface
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

## Carpetas de trabajo y almacenamiento

### Variables de `worker/.env.local`

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `AUTOCUT_WORK_DIR` | No | Carpeta donde el worker crea las carpetas temporales `autocut_*` de cada job. Si no existe, el worker la crea al arrancar. Sin esta variable usa `os.tmpdir()`. |
| `HF_HOME` | No | Carpeta de caché de modelos de Hugging Face. El worker la pasa a `transcribe.py` y la usa para calcular `hfCacheMB`. Sin esta variable se usa `~/.cache/huggingface`. |
| `AUTOCUT_PYTHON_BIN` | No | Intérprete de Python con las dependencias de `requirements-pc.txt`. |

Usa una carpeta dedicada en `AUTOCUT_WORK_DIR`: el comando `temp_pc` la vacía por completo (salvo el job en curso). Si no la defines, `temp_pc` solo toca las carpetas `autocut_*` de `os.tmpdir()`.

### Limpieza automática

1. Al arrancar y cada 6 horas, el worker borra en la carpeta de trabajo las carpetas `autocut_*` con más de 24 horas.
2. El worker conserva siempre las carpetas de los jobs en curso.

### Dispositivo de Whisper

`transcribe.py` escribe en `stderr` una línea `whisper-device: cuda/float16` o `whisper-device: cpu/int8` con el dispositivo real tras cargar el modelo. El worker la copia a `whisperDevice` del latido. Al arrancar, el worker ejecuta `transcribe.py --probe` (no carga el modelo) para publicar el dispositivo antes del primer análisis. El aviso de Hugging Face sobre peticiones no autenticadas no cuenta como error.

### Latido: campo `storage`

El archivo `_AutoCut_Jobs/_worker_status.json` incluye el objeto `storage`, que el worker recalcula como máximo cada 5 minutos y tras cada comando de limpieza:

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `storage.workDirMB` | número | Tamaño de la carpeta de trabajo en MB (con carpeta no dedicada, solo las carpetas `autocut_*`). |
| `storage.hfCacheMB` | número | Tamaño de la caché de Hugging Face en MB. |
| `storage.freeGB` | número o `null` | Espacio libre en GB de la unidad de la carpeta de trabajo. |

## Comandos de limpieza (contrato para la PWA)

El worker vigila `_AutoCut_Jobs/_commands/` cada 5 segundos. Para lanzar una limpieza, crea un archivo `cleanup_<id>.json` (el `<id>` admite letras, números, `_` y `-`) con este contenido:

```json
{
  "scopes": ["jobs_terminados", "brutos_editados"],
  "createdAt": "2026-11-23T10:00:00.000Z",
  "status": "pending"
}
```

El worker ejecuta el comando y reescribe el mismo archivo conservando los campos originales:

```json
{
  "scopes": ["jobs_terminados", "brutos_editados"],
  "createdAt": "2026-11-23T10:00:00.000Z",
  "status": "done",
  "liberadoMB": 1843.2,
  "detalle": {
    "brutos_editados": { "archivos": 3, "mb": 1840.1 },
    "jobs_terminados": { "archivos": 5, "mb": 0.1 }
  },
  "finishedAt": "2026-11-23T10:00:07.000Z"
}
```

| Campo de resultado | Valores | Descripción |
| --- | --- | --- |
| `status` | `done` / `error` | `error` si falla algún scope, llega un scope desconocido o la lista está vacía. |
| `liberadoMB` | número | MB liberados en total (el preview suma 0). |
| `detalle.<scope>` | `{ archivos, mb }` o `{ error }` | Resultado de cada scope solicitado. |
| `detalle.scopes_desconocidos` | lista de textos | Scopes que el worker no reconoce. |
| `finishedAt` | fecha ISO | Momento en que terminó el comando. |

### Scopes

| Scope | Acción |
| --- | --- |
| `temp_pc` | Vacía la carpeta de trabajo salvo las carpetas de los jobs en curso. Rechaza ejecutarse si la carpeta de trabajo es la raíz de una unidad o se solapa con la carpeta de Drive. |
| `jobs_terminados` | Borra `job_*.json` y `analyze_*.json` en estado `completed`, `analyzed` o `error` con más de 7 días (según `updatedAt`, `finishedAt` o la fecha del archivo). |
| `brutos_editados` | Borra los vídeos brutos de la carpeta raíz (sin subcarpetas) cuyo MP4 final ya existe en `_AutoCut_Output`. En `G:` el borrado va a la papelera de Google Drive (recuperable 30 días). |
| `preview_brutos_editados` | No borra nada: escribe en `detalle.preview_brutos_editados` cuántos archivos y MB borraría `brutos_editados`. |

### Cuándo cuenta un bruto como editado

1. **Fuente principal:** el bruto aparece en `sourceFiles` de un `job_*.json` en estado `completed` cuyo `outputFileName` existe en `_AutoCut_Output`. Cubre Multi-Clip: un MP4 puede salir de varios brutos.
2. **Respaldo:** la regla de la PWA (`detectPendingVideos`): existe en `_AutoCut_Output` un MP4 cuyo nombre empieza por `{nombre del bruto}_EDITADO`. Solo se aplica si el nombre base es único en la carpeta raíz (`clip.mp4` y `clip.mov` juntos se consideran ambiguos).
3. **Protección:** el worker conserva cualquier bruto citado por un job que no ha terminado (`pending`, `processing`, `analyzed` u otro estado distinto de `completed` y `error`).
4. **Sin asociación clara:** el worker no borra el bruto.

### Orden de ejecución

El worker ejecuta los scopes en este orden, con independencia del orden de la lista `scopes`: `preview_brutos_editados`, `brutos_editados`, `jobs_terminados`, `temp_pc`. `brutos_editados` va antes que `jobs_terminados` porque necesita los `job_*.json` para asociar brutos con MP4 finales.

### Flujo recomendado en la PWA

1. Escribe un comando con `scopes: ["preview_brutos_editados"]` y `status: "pending"`.
2. Lee el archivo hasta que `status` sea `done` y muestra `detalle.preview_brutos_editados`.
3. Tras la confirmación del usuario, escribe un comando nuevo con `scopes: ["brutos_editados"]` (y los demás scopes que quiera).
4. Lee `liberadoMB` y `detalle` del resultado y refresca el latido para actualizar `storage`.
