# AutoCut Drive AI

Aplicación web progresiva (**PWA**) en React + TypeScript que convierte automáticamente vídeos brutos almacenados en **Google Drive** (o en tu móvil) en piezas verticales **9:16** listas para **TikTok, Instagram Reels y YouTube Shorts**, usando **transcripción real con Whisper**, **análisis multimodal de vídeo y audio con Gemini** y **renderizado nativo en la nube con GitHub Actions a coste 0 €** (sin PC encendido y sin tarjeta).

---

## Propuesta de valor

- **Historias con principio, nudo y final (sin inventar subtítulos)**: el análisis multimodal se ejecuta en **GitHub Actions** con **faster-whisper** (transcripción real palabra a palabra en español) + **Gemini viendo el vídeo con audio** en 3 fases (A por clip, B guion global, C revisión de coherencia), con sub-cortes automáticos en pausas y subtítulos sincronizados al milisegundo.
- **Coste 0 € y sin límites de RAM de iOS**: tanto el análisis multimodal como el renderizado pesado con **FFmpeg nativo** (sincronía exacta A/V, HDR→SDR BT.709, `-14 LUFS` en 2 pasadas) corren en **GitHub Actions** directamente desde el móvil (gratis e ilimitado en repositorio público con 4 vCPU / 16 GB RAM, o 2.000 min/mes en repositorio privado).
- **Alternativas siempre disponibles**:
  - **Análisis rápido (sin audio)**: análisis instantáneo en el navegador extrayendo 12–16 fotogramas ligeros (`< 2 MB`, sin subir el vídeo bruto al servidor ni provocar errores 413).
  - **Render secundario**: **worker local de PC Windows** (`h264_nvenc` / `libx264`) y **FFmpeg.wasm en el móvil** para clips cortos.
- **Control creativo total antes de renderizar**: el Estudio muestra el título, gancho, resumen de historia, notas de revisión, función narrativa y texto hablado real de cada corte, con botones **«Ver guion completo»** y **«Rehacer historia»** (reutilizando la transcripción en caché de Drive).

---

## Arquitectura híbrida: Analizar → Revisar → Renderizar (0 €)

```text
                       ┌────────────────────────────────────────────────┐
                       │                  GOOGLE DRIVE                  │
                       │  • Brutos originales (.mp4/.mov/.webm)         │
                       │  • _AutoCut_Jobs/analyze_<id>.json (análisis)  │
                       │  • _AutoCut_Jobs/job_<id>.json     (render)    │
                       │  • _AutoCut_Jobs/_cache/transcript_*.json      │
                       │  • _AutoCut_Jobs/_sources/ (temp locales)      │
                       │  • _AutoCut_Output/ (MP4 terminados)           │
                       └──────────┬───────────────────────▲─────────────┘
                                  │                       │
            Escaneo, lectura,     │                       │  Streaming a disco +
            manifiestos y temp    ▼                       │  caché Whisper + 8 MB
┌───────────────────────────────────────────┐   ┌─────────┴─────────────────────────────┐
│          MÓVIL / NAVEGADOR (PWA)          │   │  GITHUB ACTIONS (Principal · 0 €)     │
│                                           │   │  .github/workflows/cloud-render.yml   │
│ 1. Analizar en la nube (recomendado):     │   │  worker/cloud-worker.mjs              │
│    sube analyze_<id>.json + dispatch      ├──►│                                       │
│    (o «Análisis rápido» local < 2 MB)     │   │ [kind: "analyze"] (~3–7 min / 10 min) │
│                                           │   │  1. Descarga + orden cronológico      │
│ 2. Estudio interactivo de cortes (EDL):   │   │  2. faster-whisper int8 + caché Drive │
│    • Gancho, historia, guion y revisión   │   │  3. Proxy 640p 2fps → Gemini A/B/C    │
│    • «Rehacer historia» sin re-transcribir│   │  4. Sub-cortes en silencios > 0.45 s  │
│    • Activar, reordenar y afinar tiempos  │   │  5. Guarda plan (status: "analyzed")  │
│                                           │   │                                       │
│ 3. Renderizar en la nube (recomendado):   ├──►│ [kind: "render"]                      │
│    sube job_<id>.json + dispatch          │   │  1. FFmpeg nativo 9:16 + HDR→SDR      │
│    • Otras opciones: PC Windows / móvil   │   │  2. Loudnorm 2 pasadas + ASS real     │
└───────────────────────────────────────────┘   │  3. Sube MP4 a _AutoCut_Output/       │
                                                └───────────────────────────────────────┘
```

### Cuándo usar cada modo
- **Análisis en la nube — Whisper + Gemini (Principal · ~3–7 min para 10 min de bruto)**: recomendado para vlogs, vídeos hablados y **Multi-Clip** donde importa que el montaje cuente una historia real con subtítulos fieles al audio. Ver guía en **[`worker/CLOUD_SETUP.md`](./worker/CLOUD_SETUP.md)**.
- **Análisis rápido (sin audio)**: útil para clips muy cortos o visuales donde quieres una propuesta instantánea en el navegador sin lanzar GitHub Actions.
- **Render en la nube — GitHub Actions (Principal · 0 €)**: ideal para vídeos largos, >100 MB, HDR de iPhone y Multi-Clip en 1080p/720p sin encender el PC ni agotar la RAM de iOS.
- **Worker PC Windows (`Otras opciones → Enviar a PC`)**: alternativa local con aceleración GPU NVIDIA (`h264_nvenc`). Ignora automáticamente los trabajos de análisis (`kind: "analyze"`). Ver **[`worker/README.md`](./worker/README.md)**.
- **Móvil / PWA (`Otras opciones → Renderizar en este móvil`)**: útil para clips individuales cortos con `@ffmpeg/core@0.12.6` (`dist/esm` single-thread) e IndexedDB.

---

## Funcionalidades clave

- **Análisis multimodal en la nube (Whisper + Gemini)**:
  - Transcripción real palabra a palabra con `faster-whisper` (`small` por defecto o `medium` seleccionable desde **Ajustes → Modelo de transcripción**), cacheada en `_AutoCut_Jobs/_cache/` por `driveFileId + modifiedTime`.
  - Gemini analiza cada clip con vídeo proxy + audio (Fase A), monta un guion global estructurado con `gancho`, `contexto`, `desarrollo`, `climax`, `remate`, `cierre` y `recurso` (Fase B), divide pausas largas `> 0.45 s` de forma determinista y revisa la coherencia del guion resultante (Fase C, hasta 1 reintento automático).
  - Progreso por fases visible en la Cola (*Transcribiendo audio…*, *Gemini viendo el vídeo…*, *Montando la historia…*) con polling cada 15 s solo con pestaña visible y apertura automática en el Estudio al finalizar.
- **Estudio de cortes (EDL) con visión de guion**:
  - Tarjeta superior con **título**, **gancho**, **historia** y **notas de revisión**.
  - Cada corte muestra su **función narrativa** (`Gancho`, `Desarrollo`, `Clímax`, `Remate`, `Recurso`, etc.) y el **texto hablado real**.
  - Botón **«Ver guion completo»** para leer el texto continuo resultante y **«Rehacer historia»** con nueva indicación (reutiliza la transcripción en caché sin repetir Whisper).
- **Render en la nube con calidad de producción**:
  - Sincronía exacta A/V por segmento (`asetpts`, `aresample=48000`, `afade`, `apad=whole_dur` y verificación final con `ffprobe`).
  - Conversión automática **HDR (HLG / PQ de iPhone) → SDR BT.709** (`zscale` + `tonemap=hable`).
  - Normalización de audio `-14 LUFS` en **2 pasadas lineales** y subtítulos ASS generados desde timestamps reales palabra a palabra.
  - Subida automática en bloques resumables de **8 MB** a `_AutoCut_Jobs/_sources/` para clips locales, con limpieza automática tras el render.
- **Modelo de Gemini y Whisper configurables sin tocar código**: `gemini-3.8-flash` y Whisper `small` por defecto, modificables desde **Ajustes** o mediante variables de entorno (`GEMINI_MODEL`, `VITE_GEMINI_MODEL`, `WHISPER_MODEL`).
- **Diagnóstico persistente en 1 clic**: logger interno con buffer circular (200 eventos en memoria y los últimos **120 eventos persistidos en `localStorage`** bajo `autocut_debug_logs_v1`) con saneado automático de claves, tokens OAuth, PATs de GitHub y base64.
- **PWA diseñada para iPhone / iOS**: cabeceras con `safe-area-inset-top` para Dynamic Island en modo `standalone`, barra de navegación inferior y acciones críticas en la zona del pulgar.

---

## Stack tecnológico

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Recharts, Vite 8 + `vite-plugin-pwa`.
- **Análisis y render en la nube (Principal)**: GitHub Actions (`.github/workflows/cloud-render.yml`) + Python 3.11 (`faster-whisper`, `worker/transcribe.py`) + Node.js ESM (`worker/analyze-core.mjs`, `worker/cloud-worker.mjs`, `worker/render-core.mjs`, 0 dependencias npm externas) + FFmpeg nativo (`libx264`).
- **Render secundario en PC**: Node.js ESM (`worker/pc-worker.mjs` + `worker/render-core.mjs`) + FFmpeg nativo (`h264_nvenc` / `libx264`).
- **Motor de vídeo en navegador**: `@ffmpeg/ffmpeg` (`@ffmpeg/core@0.12.6` en formato `dist/esm` single-thread) + IndexedDB.
- **IA y almacenamiento**: Gemini API (`gemini-3.8-flash`), Google Drive API v3, Firebase Auth (OAuth popup en cliente).
- **Servidor Express (`server.ts`)**: proxy seguro para análisis rápido con Gemini (`< 2 MB`), endpoint `POST /api/cloud-render/dispatch` con validación estricta y rate limit (10/min), y entrega del build estático en producción.

---

## Guía de inicio rápido y configuración

### Requisitos previos
- **Node.js 20+** y `npm`.
- Una clave de API de Google Gemini (`GEMINI_API_KEY`).
- *(Recomendado, análisis + render en la nube 0 €)*: cuenta de GitHub y cliente OAuth de Google Cloud. Sigue la guía paso a paso en **[`worker/CLOUD_SETUP.md`](./worker/CLOUD_SETUP.md)**.
- *(Opcional, worker local en PC)*: FFmpeg nativo y Google Drive para ordenadores en Windows. Ver **[`worker/README.md`](./worker/README.md)**.

### 1. Configurar variables de entorno

Copia `.env.example` a `.env` en la raíz del proyecto:

```bash
cp .env.example .env
```

Variables principales:

| Variable | Obligatoria | Ámbito | Valor por defecto | Descripción |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | Sí | Servidor + GitHub Secret | — | Clave privada de Google Gemini. Nunca se envía al navegador. |
| `GEMINI_MODEL` | Opcional | Servidor | `gemini-3.8-flash` | Modelo de Gemini usado por defecto en el backend. |
| `VITE_GEMINI_MODEL` | Opcional | Cliente | `gemini-3.8-flash` | Modelo inicial mostrado en la vista **Ajustes** del navegador. |
| `WHISPER_MODEL` | Opcional | GitHub Variable | `small` | Modelo por defecto de `faster-whisper` en Actions (`small` o `medium`). |
| `GITHUB_DISPATCH_TOKEN` | Para Nube | Solo servidor | — | Fine-Grained PAT de GitHub con permiso `Actions: Read and write` en tu repo. |
| `GITHUB_REPO` | Para Nube | Solo servidor | — | Repositorio `owner/repo` donde vive `.github/workflows/cloud-render.yml`. |
| `GITHUB_REF` | Opcional | Solo servidor | `main` | Rama objetivo al disparar el workflow en la nube. |
| `APP_URL` | Opcional | Servidor | `http://localhost:3000` | URL pública donde corre la app. |
| `PORT` | Opcional | Servidor | `3000` | Puerto HTTP del servidor Express/Vite. |
| `AUTOCUT_DRIVE_DIR` | Opcional | Worker PC | — | Ruta local sincronizada de Google Drive para `npm run worker`. |

> **Nota sobre Firebase / Google Drive OAuth**: `firebase-applet-config.json` solo contiene identificadores públicos del cliente web necesarios para el popup OAuth de Google Drive desde el navegador. Consulta las recomendaciones de restricción por dominio en [`worker/CLOUD_SETUP.md`](./worker/CLOUD_SETUP.md).

### 2. Comandos principales

```bash
# Instalar dependencias
npm install

# Ejecutar en desarrollo (Express + Vite en http://localhost:3000)
npm run dev

# Compilar build de producción (genera dist/)
npm run build

# Comprobación estricta de tipos TypeScript
npm run lint

# Ejecutar suite completa de pruebas unitarias (PWA + workers)
npm test

# Arrancar el worker nativo de renderizado en PC (opcional, ver worker/README.md)
npm run worker -- --dir "G:\Mi unidad\AutoCut_Videos"
```

### 3. Configurar Google Drive y la nube en la app

1. Abre la app y entra en **Ajustes**.
2. Pulsa **Iniciar sesión con Google** para autorizar el acceso a Google Drive.
3. Pega el **ID o la URL completa** de tu carpeta de vídeos brutos en Drive, elige tu **Modelo de transcripción** (`small` o `medium`) y pulsa **Guardar ajustes**.
4. Verifica en la tarjeta **Análisis y render en la nube** que aparece el estado **`CONFIGURADO`** (o sigue [`worker/CLOUD_SETUP.md`](./worker/CLOUD_SETUP.md) para activarlo en 10 minutos).

---

## Solución de problemas comunes

### Un vídeo o Multi-Clip supera los 200 MB en iPhone / iOS
Safari en iOS impone límites estrictos de memoria RAM a WebAssembly (`FFmpeg.wasm`):
- **Opción principal (0 €, sin PC)**: usa **«Analizar en la nube (recomendado)»** en la Cola/Multi-Clip y **«Renderizar en la nube (recomendado)»** en el Estudio. Todo el trabajo pesado (Whisper, Gemini multimodal y FFmpeg nativo) corre en GitHub Actions y deja el MP4 en `_AutoCut_Output`.
- **Alternativas secundarias**: usa **«Análisis rápido (sin audio)»** o despliega **«Otras opciones (PC / móvil)»** en el Estudio para enviarlo a tu PC o renderizarlo en 720p en el móvil.

### Error de modelo Gemini no disponible (404 / modelo retirado)
No hace falta modificar código:
1. Abre **Ajustes** en la app.
2. En **Modelo de análisis Gemini**, elige otro modelo recomendado o escribe el identificador exacto del nuevo modelo y guarda.

### Cómo depurar un error desde el móvil («Copiar informe completo»)
1. Si aparece un banner rojo de error, pulsa directamente **«Copiar error / diagnóstico»**, o ve a **Ajustes → Diagnóstico y soporte** y pulsa **«Copiar informe completo»**.
2. El texto copiado incluye modelo activo, calidad, navegador, resumen de cola y la cronología de eventos (incluyendo eventos de la categoría `Nube`), omitiendo automáticamente claves, tokens y base64.

---

## Estructura del proyecto

```text
├── .github/workflows/
│   └── cloud-render.yml           # Workflow GitHub Actions (Python + faster-whisper + FFmpeg + Node)
├── public/                        # Iconos PWA optimizados, manifest.json y favicon
├── worker/
│   ├── transcribe.py              # CLI faster-whisper (int8 CPU, word timestamps + VAD)
│   ├── analyze-core.mjs           # Motor multimodal (proxy 640p, Gemini Files API, Fases A/B/C, sub-cortes)
│   ├── render-core.mjs            # Núcleo compartido FFmpeg (sincronía A/V, HDR→SDR, ASS, loudnorm 2p)
│   ├── cloud-worker.mjs           # Dispatcher GitHub Actions (kind: "analyze" vs "render", caché Drive, logs privados)
│   ├── pc-worker.mjs              # Worker nativo PC Windows (NVENC / libx264, ignora cloud y analyze)
│   ├── worker.test.mjs            # Tests unitarios offline de render-core, analyze-core, pc-worker y cloud-worker
│   ├── CLOUD_SETUP.md             # Guía completa para activar análisis y render en la nube (0 €)
│   ├── start-worker.example.ps1   # Plantilla PowerShell para arranque en Windows
│   └── README.md                  # Guía del worker opcional para Windows 11
├── server.ts                      # Proxy Express seguro (Gemini rápido < 2 MB + /api/cloud-render/dispatch)
├── src/
│   ├── App.tsx                    # Layout principal, navegación y gestión de errores
│   ├── types.ts                   # Contratos TypeScript (cola, EDL, AnalyzeJobManifest, RenderJobManifest)
│   ├── hooks/
│   │   ├── useAppSettings.ts      # Ajustes en localStorage (Gemini, Whisper, calidad y caché IndexedDB)
│   │   ├── useGoogleDriveAuth.ts  # Sesión Google Drive OAuth en memoria + /api/health
│   │   ├── useVideoQueue.ts       # Escaneo Drive, análisis rápido por frames, Multi-Clip y analíticas
│   │   ├── useStudioEditor.ts     # Edición EDL y renderizado local FFmpeg.wasm
│   │   ├── usePcRenderJobs.ts     # Análisis y render en la nube (resumable 8 MB), polling 15 s y auto-Estudio
│   │   └── usePWAInstall.ts       # Estado PWA instalada y detección offline
│   ├── services/
│   │   ├── debugLogger.ts         # Logger circular persistente (localStorage) + sanitizado PAT/OAuth
│   │   ├── driveApi.ts            # Google Drive API v3 + subida resumable 8 MB + manifiestos analyze/render
│   │   ├── ffmpegService.ts       # FFmpeg.wasm (dist/esm) + Multi-Clip 1 clip a la vez
│   │   ├── geminiClient.ts        # Extracción local de 12–16 frames (< 2 MB) para análisis rápido
│   │   ├── googleAuth.ts          # Firebase Auth + Google Drive OAuth popup
│   │   └── videoStorage.ts        # Caché circular local en IndexedDB
│   ├── utils/
│   │   ├── videoPipeline.ts       # Lógica pura: filtros FFmpeg, prompts, EDL, manifiestos analyze/render
│   │   └── videoPipeline.test.ts  # Suite de pruebas unitarias de la PWA (node:test)
│   └── components/                # Vistas (Queue, Studio, Gallery, Settings, MultiClipComposerModal, PcJobsPanel)
```

---

## Licencia

Proyecto privado — **All Rights Reserved** por defecto mientras se mantiene en desarrollo personal. Si en el futuro se publica en abierto, se definirá explícitamente una licencia pública (como **MIT** o **AGPL-3.0**) mediante un archivo `LICENSE` en la raíz del repositorio.
