# AutoCut Drive AI

Aplicación web progresiva (**PWA**) en React + TypeScript que automatiza la edición de vídeos brutos en formato vertical **9:16** (TikTok, Reels, YouTube Shorts) combinando **Google Drive**, **Gemini Files API** (`gemini-2.5-flash` / `gemini-2.5-pro`) y **FFmpeg.wasm 100 % en el navegador**.

---

## Qué hace la aplicación

- **Conexión con Google Drive (OAuth 2.0)**: Escanea manualmente o vigila de forma automática una carpeta de Drive detectando vídeos brutos (`.mp4`, `.mov`, `.webm`) sin duplicar archivos ya procesados (`*_EDITADO_*`).
- **Análisis inteligente con Gemini Files API**: Sube los brutos mediante resumable upload, selecciona los mejores momentos según el preset de estilo (**Gracioso / Jump-cut**, **Vlog ágil** o **Resumen exprés**) más una instrucción rápida opcional, y borra los temporales de Gemini al finalizar.
- **Modo Multi-Clip**: Permite seleccionar varios brutos (de Drive o locales del móvil), reordenarlos y combinarlos en una sola pieza vertical con una narrativa coherente.
- **Renderizado local 100 % en el navegador (0 € de servidor de vídeo)**: Ejecuta `FFmpeg.wasm` (single-thread, sin requisitos de `SharedArrayBuffer`) directamente en el dispositivo del usuario con dos perfiles:
  - **Rápido móvil — 720p** (`720×1280`, 30 fps, `ultrafast`, CRF 26, bitrate acotado a `3 Mbps`, AAC 128k).
  - **Máxima calidad — 1080p** (`1080×1920`, 30 fps, `veryfast`, CRF 21, bitrate equilibrado TikTok acotado a `6 Mbps`, AAC 192k).
- **Estudio de cortes, Galería y Analíticas**: Permite activar/desactivar cortes sugeridos, re-renderizar en local, previsualizar resultados guardados en **IndexedDB** (caché circular de los últimos 5 vídeos) y consultar métricas diarias y ahorro de metraje con **Recharts**.
- **PWA optimizada para iPhone / Android**: Soporte de safe areas en modo instalado (`display-mode: standalone`), navegación inferior táctil y controles principales accesibles con el pulgar.

---

## Stack tecnológico

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Recharts, Vite + `vite-plugin-pwa`.
- **Procesamiento de vídeo (Client-Side)**: `@ffmpeg/ffmpeg` (`@ffmpeg/core` single-thread UMD) + IndexedDB.
- **IA & Cloud**: `@google/genai` (Gemini Files API + Structured JSON Output), Google Drive API v3, Firebase Auth (Google OAuth popup en cliente).
- **Servidor ligero**: Express (`server.ts`) únicamente como proxy seguro para proteger `GEMINI_API_KEY` y servir el bundle estático en producción.

---

## Arquitectura 100 % Client-Side (coste 0 € en renderizado)

Todo el trabajo intensivo de decodificación, recorte, escalado 9:16 y recodificación H.264/AAC ocurre **en el navegador del usuario** mediante WebAssembly (`FFmpeg.wasm`):

```text
[Google Drive / Galería local]
            │
            ▼
  [Navegador del usuario (PWA)]
   ├── Descarga/lectura del vídeo bruto en memoria
   ├── Proxy ligero (/api/gemini/*) ──► Gemini Files API (devuelve solo JSON de timestamps)
   ├── FFmpeg.wasm (100 % local)   ──► Recorta, normaliza 9:16 y limpia su FS virtual en `finally`
   ├── IndexedDB local             ──► Caché persistente de resultados en Galería
   └── Subida directa a Drive      ──► Con confirmación explícita del usuario
```

**Ventajas**:
- Sin colas de transcodificación ni instancias GPU/CPU costosas en el servidor.
- Privacidad: el vídeo editado se genera en tu propio dispositivo y solo se sube a tu Google Drive si lo confirmas.
- Gestión estricta de memoria para móviles: cada trabajo de FFmpeg limpia sus archivos virtuales de entrada, salida y residuos previos dentro de bloques `finally`, y avisa de forma amigable si un vídeo bruto supera los 200 MB, es 4K o excede los 6 minutos.

---

## Configuración de variables de entorno

Copia `.env.example` a `.env` en la raíz del proyecto y rellena tus valores:

```bash
cp .env.example .env
```

Variables disponibles en `.env.example`:

| Variable | Obligatoria | Ámbito | Descripción |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Sí | Solo servidor | Clave de la API de Google Gemini. Nunca se envía al navegador ni se commitea. |
| `APP_URL` | Opcional | Servidor | URL pública de despliegue (en local: `http://localhost:3000`). |
| `PORT` | Opcional | Servidor | Puerto HTTP de Express/Vite (por defecto `3000`). |

> **Nota de seguridad**: `firebase-applet-config.json` contiene exclusivamente identificadores públicos del cliente web de Firebase (`projectId`, `appId`, `authDomain`, `oAuthClientId` y `apiKey` pública de cliente) necesarios para iniciar sesión con Google Drive desde el navegador. No almacena secretos privados ni credenciales de servidor.

---

## Ejecución en local

### Requisitos previos
- **Node.js 22+** y `npm` (o `bun`).

### Instalación y arranque

```bash
# 1. Instalar dependencias
npm install

# 2. Arrancar servidor de desarrollo (Express + Vite en http://localhost:3000)
npm run dev
```

### Otros comandos útiles

```bash
# Compilar versión de producción (genera dist/)
npm run build

# Arrancar servidor de producción con Node 22 nativo
NODE_ENV=production npm start

# Comprobación estricta de tipos TypeScript
npm run lint

# Ejecutar suite de pruebas unitarias del pipeline
npx tsx --test src/utils/videoPipeline.test.ts
```

---

## Estructura principal del proyecto

```text
├── public/                      # Iconos PWA optimizados, manifest.json y favicon.ico
├── server.ts                    # Proxy ligero de Gemini Files API + servidor estático SPA
├── src/
│   ├── App.tsx                  # Layout principal, enrutado de vistas y modales
│   ├── types.ts                 # Tipos compartidos de la cola, ajustes y planes Gemini
│   ├── hooks/
│   │   ├── useAppSettings.ts    # Ajustes en localStorage, presets y caché IndexedDB
│   │   ├── useGoogleDriveAuth.ts# Sesión Google Drive OAuth en memoria
│   │   ├── useVideoQueue.ts     # Cola, vigilancia Drive, Multi-Clip, analíticas y subida
│   │   ├── useStudioEditor.ts   # Edición de cortes y re-renderizado en Estudio
│   │   └── usePWAInstall.ts     # Detección de instalación PWA y estado offline
│   ├── services/
│   │   ├── ffmpegService.ts     # Motor FFmpeg.wasm con limpieza estricta de memoria virtual
│   │   ├── driveApi.ts          # Cliente Google Drive API v3
│   │   ├── geminiClient.ts      # Cliente NDJSON para análisis single/multi-clip
│   │   ├── googleAuth.ts        # Firebase Auth + Google Drive OAuth popup
│   │   └── videoStorage.ts      # Caché circular en IndexedDB
│   ├── utils/
│   │   ├── videoPipeline.ts     # Lógica pura: filtros FFmpeg, prompts, analíticas, alertas RAM
│   │   └── videoPipeline.test.ts# Pruebas unitarias con node:test
│   └── components/              # Vistas (Queue, Studio, Gallery, Settings) y navegación
```
