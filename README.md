# AutoCut Drive AI

Aplicación web progresiva (**PWA**) en React + TypeScript que convierte automáticamente vídeos brutos almacenados en **Google Drive** (o en tu móvil) en piezas verticales **9:16** listas para **TikTok, Instagram Reels y YouTube Shorts**, usando **IA multimodal (Gemini)** y una **arquitectura híbrida de coste 0 €**.

---

## Propuesta de valor

- **Coste 0 € en procesamiento de vídeo**: no usa servidores de transcodificación ni instancias GPU de pago en la nube. Los clips cortos se renderizan en tu propio dispositivo con **FFmpeg.wasm**, y los vídeos pesados (>100 MB) o proyectos **Multi-Clip** se pueden delegar con un toque a tu propio PC Windows mediante **Google Drive** y **FFmpeg nativo**.
- **Sin límites de subida (adiós errores 413)**: el vídeo bruto **nunca se envía al servidor**. El navegador extrae localmente entre **12 y 16 fotogramas ligeros** (480 px de ancho, JPEG calidad `0.55`), garantizando que el payload enviado a Gemini sea siempre **inferior a 2 MB**, independientemente de si el bruto pesa 15 MB o 600 MB.
- **Control creativo antes de renderizar**: Gemini devuelve un plan estructurado (EDL) con timestamps, motivo de cada corte y puntuación de interés (`1–10`). Puedes activar/desactivar cortes, reordenarlos o ajustar inicio y fin al décimo de segundo antes de exportar.

---

## Arquitectura híbrida (0 €)

```text
                       ┌───────────────────────────────────────┐
                       │             GOOGLE DRIVE              │
                       │  • Brutos originales (.mp4/.mov/.webm)│
                       │  • _AutoCut_Jobs/   (job_<id>.json)   │
                       │  • _AutoCut_Output/ (MP4 terminados)  │
                       └──────────┬──────────────────▲─────────┘
                                  │                  │
            Escaneo, lectura y    │                  │  Sincronización local
            manifiestos JSON      ▼                  │  (Google Drive Desktop)
┌───────────────────────────────────────────┐   ┌────┴──────────────────────────────────┐
│          MÓVIL / NAVEGADOR (PWA)          │   │   PC WINDOWS (Opcional · >100 MB /    │
│                                           │   │   Multi-Clip · worker/pc-worker.mjs)  │
│ 1. Extrae 12–16 frames locales (< 2 MB)   │   │                                       │
│    (el vídeo bruto NO sale del cliente)   │   │ 1. Vigila _AutoCut_Jobs/ cada 3 s     │
│ 2. Proxy Express (/api/gemini/*) ─────────┼──►│ 2. Lee los brutos locales en disco    │
│    └─► Gemini (gemini-3.8-flash)          │   │ 3. Renderiza con FFmpeg nativo:       │
│ 3. Estudio interactivo de cortes (EDL)    │   │    • Auto-detecta GPU NVIDIA          │
│ 4. Dos modos de renderizado:              │   │      (h264_nvenc)                     │
│    • Local (clips cortos): FFmpeg.wasm    │   │    • Fallback CPU (libx264 fast)      │
│      (ESM single-thread + IndexedDB)      │   │ 4. Guarda el MP4 en _AutoCut_Output/  │
│    • Híbrido PC: sube job_<id>.json a     │   │    y actualiza el % en job_<id>.json  │
│      _AutoCut_Jobs sin bajar el bruto     │   └───────────────────────────────────────┘
└───────────────────────────────────────────┘
```

### Cuándo usar cada modo de renderizado
- **Móvil / PWA (`FFmpeg.wasm`)**: ideal para clips individuales cortos o ligeros. Usa el núcleo `dist/esm` single-thread (compatible con iOS Safari y ES Module Workers sin requerir `SharedArrayBuffer`), procesa Multi-Clip de **1 clip en 1 clip** con `concat -c copy` para minimizar picos de RAM y guarda los últimos resultados en **IndexedDB**.
- **PC Windows (`Enviar render a PC`)**: recomendado para vídeos **>100 MB** o proyectos **Multi-Clip** en 1080p. El móvil solo sube el archivo `job_<id>.json` a `_AutoCut_Jobs/`, evitando descargas pesadas y cierres por falta de memoria (OOM) en iOS.

---

## Funcionalidades clave

- **Modo Multi-Clip**: combina varios brutos (de Drive o locales) en un único vídeo vertical coherente. Gemini analiza cada clip por separado respetando el límite de `< 2 MB` y unifica el guion de cortes.
- **Motor de edición listo para TikTok / Reels**:
  - **Presets de ritmo** (*Gracioso / Jump-cut*, *Vlog ágil*, *Resumen exprés*) + instrucción personalizada opcional para Gemini.
  - **Encuadre 9:16 seleccionable**: *Recorte centrado* (`center_crop`) o *Ajuste con fondo desenfocado* (`blur_pad` / `blur_bg`) para brutos grabados en horizontal.
  - **Recorte automático de silencios** (activado por defecto) mediante filtro `silenceremove`.
  - **Normalización de audio para redes (`-14 LUFS`)** mediante filtro `loudnorm`.
  - **Subtítulos automáticos opcionales**: desactivados por defecto para ahorrar tiempo y memoria; si los activas antes de analizar, se generan bloques sincronizados que pueden quemarse en el MP4 (`.ass`) o descargarse como `.srt`.
- **Modelo de Gemini configurable sin tocar código**: usa `gemini-3.8-flash` por defecto, configurable desde variables de entorno (`GEMINI_MODEL` / `VITE_GEMINI_MODEL`) y modificable al instante desde **Ajustes**.
- **Estudio EDL, Galería y Analíticas**: línea de tiempo visual, ajuste fino de inicio/fin, reordenación de cortes, panel de trabajos PC en Cola y Galería con seguimiento en tiempo real (`En cola PC`, `Renderizando en PC (X%)`, `Completado`), caché circular en **IndexedDB** y gráficas de ahorro de metraje con **Recharts**.
- **Diagnóstico persistente en 1 clic**: logger interno con buffer circular (200 eventos en memoria y los últimos **120 eventos persistidos en `localStorage`** bajo `autocut_debug_logs_v1`). Si iOS reinicia la PWA por RAM, al volver a abrir inserta un separador de nueva sesión conservando los pasos previos y permite copiar un informe saneado (sin API keys, tokens OAuth ni base64) desde **Ajustes** o desde cualquier banner de error.
- **PWA diseñada para iPhone / iOS**: cabeceras con `safe-area-inset-top` para Dynamic Island en modo `standalone`, barra de navegación inferior y acciones críticas en la zona del pulgar.

---

## Stack tecnológico

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Recharts, Vite 8 + `vite-plugin-pwa`.
- **Motor de vídeo en navegador**: `@ffmpeg/ffmpeg` (`@ffmpeg/core@0.12.6` en formato `dist/esm` single-thread) + IndexedDB.
- **Worker nativo de PC**: Node.js ESM (`worker/pc-worker.mjs`, 0 dependencias externas) + FFmpeg nativo (`h264_nvenc` / `libx264`).
- **IA y almacenamiento**: `@google/genai` (análisis por fotogramas con JSON estructurado), Google Drive API v3, Firebase Auth (OAuth popup en cliente).
- **Proxy ligero**: Express (`server.ts`, `express.json({ limit: '15mb' })`) exclusivamente para proteger `GEMINI_API_KEY` en el servidor y servir el build estático en producción.

---

## Guía de inicio rápido y configuración

### Requisitos previos
- **Node.js 22+** (o 18+ para ejecutar únicamente el worker de PC) y `npm`.
- Una clave de API de Google Gemini (`GEMINI_API_KEY`).
- *(Opcional, para render híbrido en PC)*: **FFmpeg** nativo y **Google Drive para ordenadores** en Windows. Ver guía detallada en [`worker/README.md`](./worker/README.md).

### 1. Configurar variables de entorno

Copia `.env.example` a `.env` en la raíz del proyecto y completa tu clave de Gemini:

```bash
cp .env.example .env
```

Variables documentadas en `.env.example`:

| Variable | Obligatoria | Ámbito | Valor por defecto | Descripción |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | Sí | Solo servidor | — | Clave privada de Google Gemini. Nunca se envía al cliente ni se sube al repositorio. |
| `GEMINI_MODEL` | Opcional | Servidor | `gemini-3.8-flash` | Modelo de Gemini usado por defecto en el backend. |
| `VITE_GEMINI_MODEL` | Opcional | Cliente | `gemini-3.8-flash` | Modelo inicial mostrado en la vista **Ajustes** del navegador. |
| `APP_URL` | Opcional | Servidor | `http://localhost:3000` | URL pública donde corre la app (en local `http://localhost:3000`). |
| `PORT` | Opcional | Servidor | `3000` | Puerto HTTP del servidor Express/Vite. |
| `AUTOCUT_DRIVE_DIR` | Opcional | Worker PC | — | Ruta local sincronizada de Google Drive para `npm run worker` (también se puede pasar con `--dir`). |

> **Nota sobre Firebase / Google Drive OAuth**: `firebase-applet-config.json` solo contiene identificadores públicos del cliente web necesarios para el popup OAuth de Google Drive desde el navegador. No almacena claves privadas ni secretos de servidor.

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

# Ejecutar suite de pruebas unitarias (node:test)
npm test

# Arrancar el worker nativo de renderizado en PC (ver worker/README.md)
npm run worker -- --dir "G:\Mi unidad\AutoCut_Videos"
```

### 3. Configurar la carpeta de Google Drive en la app

1. Abre la app y entra en **Ajustes**.
2. Pulsa **Iniciar sesión con Google** para autorizar el acceso a Google Drive.
3. Pega el **ID o la URL completa** de la carpeta de Drive donde guardas tus vídeos brutos y pulsa **Guardar ajustes**.
4. Al enviar tu primer trabajo al PC, la app creará automáticamente dentro de esa carpeta las subcarpetas `_AutoCut_Jobs` y `_AutoCut_Output`.

---

## Solución de problemas comunes

### Un vídeo o Multi-Clip supera los 200 MB en iPhone / iOS
Safari en iOS impone límites estrictos de memoria RAM a los procesos WebAssembly (`FFmpeg.wasm`):
- **Opción recomendada (0 € y máxima velocidad)**: analiza y revisa los cortes en el móvil, y en **Estudio de cortes** pulsa **«Enviar render a PC»**. Tu PC renderizará el vídeo en 1080p sin consumir RAM del móvil y dejará el MP4 en `_AutoCut_Output`.
- **Opción 100 % móvil**: cambia la calidad de salida a **720p móvil** (aviso automático disponible en Cola y Estudio cuando superas 3 clips o 200 MB en 1080p) y mantén los **Subtítulos automáticos** desactivados si no los necesitas.

### Error de modelo Gemini no disponible (404 / modelo retirado)
No hace falta modificar código:
1. Abre **Ajustes** en la app.
2. En **Modelo de IA (Gemini)**, elige otro modelo recomendado o escribe el identificador exacto del nuevo modelo en el campo personalizado y guarda.
3. Si despliegas en servidor propio, también puedes actualizar `GEMINI_MODEL` y `VITE_GEMINI_MODEL` en `.env`.

### Cómo depurar un error desde el móvil («Copiar informe completo»)
1. Si aparece un banner rojo de error, pulsa directamente **«Copiar error / diagnóstico»**, o ve a **Ajustes → Diagnóstico y registro de eventos** y pulsa **«Copiar informe completo»**.
2. El texto copiado incluye modelo activo, calidad, navegador, resumen de cola y la cronología de los últimos eventos (incluso si iOS reinició la PWA antes por memoria), omitiendo automáticamente cualquier API key, token de Drive o cadena base64.
3. Si Safari bloquea el portapapeles automático, la app abre un cuadro de selección rápida para copiarlo en un toque.

---

## Estructura del proyecto

```text
├── public/                        # Iconos PWA optimizados, manifest.json y favicon
├── worker/
│   ├── pc-worker.mjs              # Worker nativo Node.js + FFmpeg (NVENC / libx264)
│   ├── start-worker.example.ps1   # Plantilla PowerShell para arranque con log en Windows
│   └── README.md                  # Guía completa paso a paso para Windows 11
├── server.ts                      # Proxy Express seguro para Gemini (< 2 MB frames) y SPA
├── src/
│   ├── App.tsx                    # Layout principal, navegación y gestión de errores
│   ├── types.ts                   # Contratos TypeScript (cola, EDL, RenderJobManifest)
│   ├── hooks/
│   │   ├── useAppSettings.ts      # Ajustes en localStorage, modelo Gemini y caché IndexedDB
│   │   ├── useGoogleDriveAuth.ts  # Sesión Google Drive OAuth en memoria
│   │   ├── useVideoQueue.ts       # Escaneo Drive, análisis por frames, Multi-Clip y analíticas
│   │   ├── useStudioEditor.ts     # Edición EDL y renderizado local FFmpeg.wasm
│   │   ├── usePcRenderJobs.ts     # Envío de job_*.json y sincronización _AutoCut_Output
│   │   └── usePWAInstall.ts       # Estado PWA instalada y detección offline
│   ├── services/
│   │   ├── debugLogger.ts         # Logger circular persistente (localStorage) + sanitizado
│   │   ├── driveApi.ts            # Cliente Google Drive API v3 + buzón PC
│   │   ├── ffmpegService.ts       # FFmpeg.wasm (dist/esm) + Multi-Clip 1 clip a la vez
│   │   ├── geminiClient.ts        # Extracción de 12–16 frames (< 2 MB) + cliente Gemini
│   │   ├── googleAuth.ts          # Firebase Auth + Google Drive OAuth popup
│   │   └── videoStorage.ts        # Caché circular local en IndexedDB
│   ├── utils/
│   │   ├── videoPipeline.ts       # Lógica pura: filtros FFmpeg, prompts, EDL, manifiestos PC
│   │   └── videoPipeline.test.ts  # Suite de pruebas unitarias (node:test)
│   └── components/                # Vistas (Queue, Studio, Gallery, Settings, PcJobsPanel)
```

---

## Licencia

Proyecto privado — **All Rights Reserved** por defecto mientras se mantiene en desarrollo personal. Si en el futuro se publica en abierto, se definirá explícitamente una licencia pública (como **MIT** o **AGPL-3.0**) mediante un archivo `LICENSE` en la raíz del repositorio.
