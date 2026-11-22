# AutoCut Drive AI — Worker de Renderizado Nativo en PC (0 €)

Este worker ligero en Node.js (sin dependencias externas) permite delegar el renderizado pesado de vídeos grandes (>100 MB) o proyectos **Multi-Clip** desde el móvil a tu ordenador Windows usando **FFmpeg nativo** y tu carpeta sincronizada de **Google Drive**, manteniendo el coste en **0 €**.

---

## Cómo funciona el flujo híbrido

1. **En tu iPhone / móvil (PWA):** escaneas la carpeta de Google Drive, extraes fotogramas ligeros (< 2 MB), Gemini genera el plan de cortes y revisas/editas el orden y los tiempos en **Estudio de cortes**.
2. En lugar de renderizar con FFmpeg.wasm en la RAM del móvil, pulsas **«Enviar render a PC»**.
   - La PWA sube únicamente un archivo ligero `job_<id>.json` a `_AutoCut_Jobs/` dentro de tu carpeta de Drive (no descarga el vídeo bruto al móvil).
3. **En tu PC Windows (`worker/pc-worker.mjs`):**
   - Vigila `_AutoCut_Jobs/` cada 3 segundos.
   - Localiza los vídeos originales ya sincronizados en tu disco local.
   - Renderiza con **FFmpeg nativo**, detectando automáticamente tu GPU NVIDIA (`h264_nvenc`) o usando CPU (`libx264 -preset fast`) como alternativa segura.
   - Respeta exactamente tus opciones del Estudio: `720p` / `1080p`, encuadre `9:16` (`center_crop` o `blur_bg`), recorte de silencios, normalización `-14 LUFS`, orden Multi-Clip y subtítulos quemados (solo si los activaste).
   - Guarda el MP4 final en `_AutoCut_Output/` y actualiza el progreso (`0–100%`) en el JSON.
4. **De vuelta en el móvil:** pulsas **«Actualizar estado PC»** en **Cola** o **Galería** para ver el progreso en tiempo real y reproducir o descargar el `.mp4` terminado.

---

## 1. Requisitos previos en Windows

1. **Node.js 18 o superior**: [https://nodejs.org/](https://nodejs.org/)
2. **FFmpeg nativo** (se instala en un solo comando desde PowerShell o Terminal):

```powershell
winget install Gyan.FFmpeg
```

> Después de instalar FFmpeg, **cierra y vuelve a abrir la terminal** y comprueba que responde ejecutando:
> ```powershell
> ffmpeg -version
> ```

3. **Google Drive para ordenador (Google Drive for Desktop)**:
   - Instálalo desde [https://www.google.com/drive/download/](https://www.google.com/drive/download/) e inicia sesión con la misma cuenta de Google que usas en la PWA.
   - Localiza la ruta local de tu carpeta configurada en AutoCut Drive AI (por ejemplo: `G:\Mi unidad\AutoCut_Videos`).
   - *Consejo:* haz clic derecho sobre tu carpeta en el Explorador de Windows → **Acceso sin conexión → Disponible sin conexión** para que los brutos ya estén en tu disco cuando llegue un trabajo desde el móvil.

---

## 2. Cómo lanzar el worker

Desde la raíz del repositorio:

### Opción A — Pasando la ruta con `--dir` (PowerShell o CMD)

```powershell
npm run worker -- --dir "G:\Mi unidad\AutoCut_Videos"
```

O ejecutando Node directamente:

```powershell
node worker/pc-worker.mjs --dir "G:\Mi unidad\AutoCut_Videos"
```

### Opción B — Usando la variable de entorno `AUTOCUT_DRIVE_DIR`

**En Windows PowerShell:**
```powershell
$env:AUTOCUT_DRIVE_DIR = "G:\Mi unidad\AutoCut_Videos"
npm run worker
```

**En Símbolo del sistema (CMD):**
```cmd
set AUTOCUT_DRIVE_DIR=G:\Mi unidad\AutoCut_Videos
npm run worker
```

**En macOS / Linux:**
```bash
AUTOCUT_DRIVE_DIR="$HOME/Google Drive/Mi unidad/AutoCut_Videos" npm run worker
```

---

## 3. Opciones adicionales de línea de comandos

| Opción | Descripción |
| :--- | :--- |
| `--dir <ruta>` / `-d <ruta>` | Ruta local de la carpeta de Google Drive sincronizada (anula `AUTOCUT_DRIVE_DIR`). |
| `--interval <ms>` | Frecuencia de escaneo de `_AutoCut_Jobs/` en milisegundos (por defecto `3000`). |
| `--cpu` | Fuerza la codificación por CPU (`libx264 -preset fast`) aunque el PC tenga GPU NVIDIA. |
| `--ffmpeg <ruta>` | Ruta explícita al ejecutable `ffmpeg.exe` si no está en el `PATH` del sistema. |
| `--once` | Procesa los trabajos `pending` actuales y cierra el script al terminar. |
| `--help` | Muestra la ayuda rápida en español. |

---

## 4. Aceleración por GPU (NVENC) vs CPU

Al arrancar, el worker realiza una prueba real de 0.1 s con `h264_nvenc`:
- Si tienes una tarjeta gráfica NVIDIA compatible con drivers actualizados, verás en consola `h264_nvenc (GPU NVIDIA)` y los vídeos Multi-Clip de varios cientos de MB se renderizarán en cuestión de segundos.
- Si el PC no tiene GPU NVIDIA o los drivers no soportan NVENC, el worker cambia automáticamente y sin errores a `libx264 (CPU)` con `-preset fast`.

---

## 5. Solución rápida de problemas

- **«No se encontró FFmpeg»**: ejecuta `winget install Gyan.FFmpeg`, reinicia la terminal o pasa `--ffmpeg "C:\ruta\a\ffmpeg.exe"`.
- **«No se encontró el vídeo fuente»**: espera unos segundos a que Google Drive para ordenador sincronice los brutos en la carpeta local y revisa que el nombre del archivo coincida con el que está en Drive.
- **El trabajo se queda en «En cola PC» en el móvil**: confirma que el worker sigue abierto en el PC y que la carpeta `--dir` coincide exactamente con el **ID de carpeta de Drive** configurado en **Ajustes** de la PWA.
