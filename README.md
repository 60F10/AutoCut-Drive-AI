# AutoCut Drive AI

Aplicación web progresiva (**PWA**) en React + TypeScript que convierte automáticamente vídeos brutos almacenados en **Google Drive** (o en tu móvil) en piezas verticales **9:16** listas para **TikTok, Instagram Reels y YouTube Shorts**, usando **IA multimodal (Gemini)** y **renderizado nativo en la nube con GitHub Actions a coste 0 €** (sin PC encendido y sin tarjeta).

---

## Propuesta de valor

- **Coste 0 € y sin límites de RAM de iOS**: el renderizado pesado con **FFmpeg nativo** se ejecuta en **GitHub Actions** directamente desde el móvil (gratis e ilimitado en repositorio público con 4 vCPU / 16 GB RAM, o 2.000 min/mes en repositorio privado). También se mantienen como opciones secundarias el **worker local de PC Windows** y el render **FFmpeg.wasm en el móvil** para clips cortos.
- **Sin límites de subida para IA (adiós errores 413)**: el vídeo bruto **nunca se envía al servidor de análisis**. El navegador extrae localmente entre **12 y 16 fotogramas ligeros** (480 px de ancho, JPEG calidad `0.55`), garantizando que el payload enviado a Gemini sea siempre **inferior a 2 MB**, independientemente de si el bruto pesa 15 MB o 600 MB.
- **Control creativo antes de renderizar**: Gemini devuelve un plan estructurado (EDL) con timestamps, motivo de cada corte y puntuación de interés (`1–10`). Puedes activar/desactivar cortes, reordenarlos o ajustar inicio y fin al décimo de segundo antes de lanzar el render.

---

## Arquitectura híbrida (0 €)

```text
                       ┌───────────────────────────────────────────┐
                       │               GOOGLE DRIVE                │
                       │  • Brutos originales (.mp4/.mov/.webm)    │
                       │  • _AutoCut_Jobs/   (job_<id>.json)       │
                       │  • _AutoCut_Jobs/_sources/ (temp locales) │
                       │  • _AutoCut_Output/ (MP4 terminados)      │
                       └──────────┬──────────────────▲─────────────┘
                                  │                  │
            Escaneo, lectura,     │                  │  Streaming a disco +
            manifiestos y temp    ▼                  │  subida resumable 8 MB
┌───────────────────────────────────────────┐   ┌────┴──────────────────────────────────┐
│          MÓVIL / NAVEGADOR (PWA)          │   │  GITHUB ACTIONS (Principal · 0 €)     │
│                                           │   │  .github/workflows/cloud-render.yml   │
│ 1. Extrae 12–16 frames locales (< 2 MB)   │   │  worker/cloud-worker.mjs              │
│    (el vídeo bruto NO sale para IA)       │   │                                       │
│ 2. Proxy Express (/api/gemini/*)          │   │ 1. OAuth refresh token (enmascarado)  │
│    └─► Gemini (gemini-3.8-flash)          │   │ 2. Descarga brutos por streaming      │
│ 3. Estudio interactivo de cortes (EDL)    │   │ 3. Renderiza con FFmpeg nativo        │
│ 4. Tres modos de renderizado:             │   │    (libx264 veryfast 1080p /          │
│    • Nube (recomendado): sube job JSON +  ├──►│     ultrafast 720p, sin límite RAM)   │
│      POST /api/cloud-render/dispatch      │   │ 4. Sube MP4 a _AutoCut_Output/        │
│    • Otras opciones:                      │   │    y actualiza % en job_<id>.json     │
│      – Worker PC Windows (pc-worker.mjs)  │   └───────────────────────────────────────┘
│      – Móvil local (FFmpeg.wasm corto)    │
└───────────────────────────────────────────┘
```

### Cuándo usar cada modo de renderizado
- **Render en la nube — GitHub Actions (Principal y recomendado · 0 €)**: ideal para vídeos largos, >100 MB y proyectos **Multi-Clip** en 1080p o 720p sin encender el PC ni agotar la RAM de iOS. Ver guía de configuración de una sola vez en **[`worker/CLOUD_SETUP.md`](./worker/CLOUD_SETUP.md)**.
- **Worker PC Windows (`Otras opciones → Enviar a PC`)**: alternativa local si prefieres renderizar en tu propio equipo con aceleración GPU NVIDIA (`h264_nvenc`). Ver **[`worker/README.md`](./worker/README.md)**.
- **Móvil / PWA (`Otras opciones → Renderizar en este móvil`)**: útil para clips individuales cortos sin salir del navegador. Usa `@ffmpeg/core@0.12.6` en `dist/esm` single-thread, procesa Multi-Clip de **1 clip en 1 clip** con `concat -c copy` y guarda los resultados en **IndexedDB**.

---

## Funcionalidades clave

- **Render en la nube desde el móvil**:
  - Botón principal **«Renderizar en la nube (recomendado)»** en el Estudio de cortes.
  - Subida automática en bloques resumables de **8 MB** a `_AutoCut_Jobs/_sources/` si algún clip es local de la galería del móvil, con limpieza automática al completarse (sin tocar jamás los archivos originales de Drive).
  - Panel **Renders remotos** en Cola y Galería con badges **`NUBE`** / **`PC`**, barra de progreso en tiempo real (polling cada 15 s solo con pestaña visible y trabajos activos), botón **«Reintentar envío»**, relanzamiento automático si un trabajo queda pendiente > 3 min, y botones **«Ver en Drive»** / **«Descargar»**.
- **Modo Multi-Clip**: combina varios brutos (de Drive o locales) en un único vídeo vertical coherente. Gemini analiza cada clip por separado respetando el límite de `< 2 MB` y unifica el guion de cortes.
- **Motor de edición listo para TikTok / Reels**:
  - **Presets de ritmo** (*Gracioso / Jump-cut*, *Vlog ágil*, *Resumen exprés*) + instrucción personalizada opcional para Gemini.
  - **Encuadre 9:16 seleccionable**: *Recorte centrado* (`center_crop`) o *Ajuste con fondo desenfocado* (`blur_pad` / `blur_bg`) para brutos grabados en horizontal.
  - **Recorte automático de silencios** (activado por defecto) mediante filtro `silenceremove`.
  - **Normalización de audio para redes (`-14 LUFS`)** mediante filtro `loudnorm`.
  - **Subtítulos automáticos opcionales**: desactivados por defecto para ahorrar tiempo y memoria; si los activas antes de analizar, se generan bloques sincronizados que pueden quemarse en el MP4 (`.ass`) o descargarse como `.srt`.
- **Modelo de Gemini configurable sin tocar código**: usa `gemini-3.8-flash` por defecto, configurable desde variables de entorno (`GEMINI_MODEL` / `VITE_GEMINI_MODEL`) y modificable al instante desde **Ajustes**.
- **Diagnóstico persistente en 1 clic**: logger interno con buffer circular (200 eventos en memoria y los últimos **120 eventos persistidos en `localStorage`** bajo `autocut_debug_logs_v1`) con categoría dedicada `Nube` y saneado automático de claves, tokens OAuth, PATs de GitHub y base64.
- **PWA diseñada para iPhone / iOS**: cabeceras con `safe-area-inset-top` para Dynamic Island en modo `standalone`, barra de navegación inferior y acciones críticas en la zona del pulgar.

---

## Stack tecnológico

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Recharts, Vite 8 + `vite-plugin-pwa`.
- **Render en la nube (Principal)**: GitHub Actions (`.github/workflows/cloud-render.yml`) + Node.js ESM (`worker/cloud-worker.mjs` + `worker/render-core.mjs`, 0 dependencias externas) + FFmpeg nativo (`libx264`).
- **Render secundario en PC**: Node.js ESM (`worker/pc-worker.mjs` + `worker/render-core.mjs`) + FFmpeg nativo (`h264_nvenc` / `libx264`).
- **Motor de vídeo en navegador**: `@ffmpeg/ffmpeg` (`@ffmpeg/core@0.12.6` en formato `dist/esm` single-thread) + IndexedDB.
- **IA y almacenamiento**: `@google/genai` (análisis por fotogramas con JSON estructurado), Google Drive API v3, Firebase Auth (OAuth popup en cliente).
- **Servidor Express (`server.ts`)**: proxy seguro para Gemini (`express.json({ limit: '15mb' })`), endpoint `POST /api/cloud-render/dispatch` con validación estricta y rate limit (10/min), y entrega del build estático en producción.

---

## Guía de inicio rápido y configuración

### Requisitos previos
- **Node.js 20+** y `npm`.
- Una clave de API de Google Gemini (`GEMINI_API_KEY`).
- *(Recomendado, render en la nube 0 €)*: cuenta de GitHub y cliente OAuth de Google Cloud. Sigue la guía paso a paso en **[`worker/CLOUD_SETUP.md`](./worker/CLOUD_SETUP.md)**.
- *(Opcional, worker local en PC)*: FFmpeg nativo y Google Drive para ordenadores en Windows. Ver **[`worker/README.md`](./worker/README.md)**.

### 1. Configurar variables de entorno

Copia `.env.example` a `.env` en la raíz del proyecto:

```bash
cp .env.example .env
```

Variables documentadas en `.env.example`:

| Variable | Obligatoria | Ámbito | Valor por defecto | Descripción |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | Sí | Solo servidor | — | Clave privada de Google Gemini. Nunca se envía al cliente. |
| `GEMINI_MODEL` | Opcional | Servidor | `gemini-3.8-flash` | Modelo de Gemini usado por defecto en el backend. |
| `VITE_GEMINI_MODEL` | Opcional | Cliente | `gemini-3.8-flash` | Modelo inicial mostrado en la vista **Ajustes** del navegador. |
| `GITHUB_DISPATCH_TOKEN` | Para Nube | Solo servidor | — | Fine-Grained PAT de GitHub con permiso `Actions: Read and write` en tu repo. |
| `GITHUB_REPO` | Para Nube | Solo servidor | — | Repositorio `owner/repo` donde vive `.github/workflows/cloud-render.yml`. |
| `GITHUB_REF` | Opcional | Solo servidor | `main` | Rama objetivo al disparar el workflow de render en la nube. |
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
3. Pega el **ID o la URL completa** de tu carpeta de vídeos brutos en Drive y pulsa **Guardar ajustes**.
4. Verifica en la tarjeta **Render en la nube** que aparece el estado **`CONFIGURADO`** (o sigue [`worker/CLOUD_SETUP.md`](./worker/CLOUD_SETUP.md) para activarlo en 10 minutos).

---

## Solución de problemas comunes

### Un vídeo o Multi-Clip supera los 200 MB en iPhone / iOS
Safari en iOS impone límites estrictos de memoria RAM a WebAssembly (`FFmpeg.wasm`):
- **Opción principal (0 €, sin PC)**: analiza y revisa los cortes en el móvil, y en **Estudio de cortes** pulsa **«Renderizar en la nube (recomendado)»**. GitHub Actions hará el render con FFmpeg nativo y dejará el MP4 en `_AutoCut_Output`.
- **Alternativas secundarias**: despliega **«Otras opciones (PC / móvil)»** en el Estudio para enviarlo a tu PC o renderizarlo en 720p directamente en el móvil.

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
│   └── cloud-render.yml           # Workflow GitHub Actions (workflow_dispatch, FFmpeg nativo)
├── public/                        # Iconos PWA optimizados, manifest.json y favicon
├── worker/
│   ├── render-core.mjs            # Núcleo compartido FFmpeg (filtros 9:16, ASS, concat, perfiles)
│   ├── cloud-worker.mjs           # Worker GitHub Actions (OAuth refresh, streaming, logs privados)
│   ├── pc-worker.mjs              # Worker nativo PC Windows (NVENC / libx264, ignora target cloud)
│   ├── worker.test.mjs            # Tests unitarios de render-core, pc-worker y cloud-worker
│   ├── CLOUD_SETUP.md             # Guía completa para activar el render en la nube (0 €)
│   ├── start-worker.example.ps1   # Plantilla PowerShell para arranque en Windows
│   └── README.md                  # Guía del worker opcional para Windows 11
├── server.ts                      # Proxy Express seguro (Gemini < 2 MB + /api/cloud-render/dispatch)
├── src/
│   ├── App.tsx                    # Layout principal, navegación y gestión de errores
│   ├── types.ts                   # Contratos TypeScript (cola, EDL, RenderJobManifest cloud/pc)
│   ├── hooks/
│   │   ├── useAppSettings.ts      # Ajustes en localStorage, modelo Gemini y caché IndexedDB
│   │   ├── useGoogleDriveAuth.ts  # Sesión Google Drive OAuth en memoria + /api/health
│   │   ├── useVideoQueue.ts       # Escaneo Drive, análisis por frames, Multi-Clip y analíticas
│   │   ├── useStudioEditor.ts     # Edición EDL y renderizado local FFmpeg.wasm
│   │   ├── usePcRenderJobs.ts     # Envío a Nube (resumable 8 MB) y PC, polling 15 s y limpieza _sources
│   │   └── usePWAInstall.ts       # Estado PWA instalada y detección offline
│   ├── services/
│   │   ├── debugLogger.ts         # Logger circular persistente (localStorage) + sanitizado PAT/OAuth
│   │   ├── driveApi.ts            # Google Drive API v3 + subida resumable 8 MB + dispatch cloud
│   │   ├── ffmpegService.ts       # FFmpeg.wasm (dist/esm) + Multi-Clip 1 clip a la vez
│   │   ├── geminiClient.ts        # Extracción de 12–16 frames (< 2 MB) + cliente Gemini
│   │   ├── googleAuth.ts          # Firebase Auth + Google Drive OAuth popup
│   │   └── videoStorage.ts        # Caché circular local en IndexedDB
│   ├── utils/
│   │   ├── videoPipeline.ts       # Lógica pura: filtros FFmpeg, prompts, EDL, manifiestos
│   │   └── videoPipeline.test.ts  # Suite de pruebas unitarias de la PWA (node:test)
│   └── components/                # Vistas (Queue, Studio, Gallery, Settings, PcJobsPanel)
```

---

## Licencia

Proyecto privado — **All Rights Reserved** por defecto mientras se mantiene en desarrollo personal. Si en el futuro se publica en abierto, se definirá explícitamente una licencia pública (como **MIT** o **AGPL-3.0**) mediante un archivo `LICENSE` en la raíz del repositorio.
