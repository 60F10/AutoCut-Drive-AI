# Guía de configuración — Análisis y render en la nube con GitHub Actions (0 €)

Esta guía configura tanto el **análisis multimodal en la nube (Whisper + Gemini)** como el **renderizado en la nube con FFmpeg nativo** de AutoCut Drive AI usando **GitHub Actions**, sin coste, sin tarjeta de crédito y sin tener que dejar ningún PC encendido. Se configura **una sola vez** (~10 minutos).

---

## Flujo completo: Analizar → Revisar → Renderizar

```text
1. ANALIZAR (Móvil / PWA → GitHub Actions)
   PWA ──► Sube analyze_<id>.json (kind: "analyze") a Google Drive (_AutoCut_Jobs)
       ──► Llama a POST /api/cloud-render/dispatch (tu servidor)
               │
               ▼
        GitHub Actions (ubuntu-latest · Python 3.11 + faster-whisper + Node + FFmpeg)
               ├─ Descarga los brutos por streaming (ordenados cronológicamente)
               ├─ Transcribe audio real palabra a palabra con faster-whisper (int8 CPU)
               │  └─ Guarda/reutiliza caché en _AutoCut_Jobs/_cache/transcript_*.json
               ├─ Genera proxy ligero (640p 2fps + audio 48k) → Gemini Files API (borrado en finally)
               ├─ Fase A (registro por clip) → Fase B (guion global) → sub-cortes en silencios
               ├─ Fase C (revisión de coherencia, máx. 1 reintento automático)
               └─ Escribe el plan (cortes, texto real, words, guion) en analyze_<id>.json (status: "analyzed")

2. REVISAR (Estudio de cortes en PWA)
   PWA ──► Carga el plan automáticamente en el Estudio
       ──► Ves título, gancho, historia, notas de revisión, función y texto hablado de cada corte
       ──► Opcional: «Ver guion completo» o «Rehacer historia» (reutiliza caché Whisper sin re-transcribir)

3. RENDERIZAR (Estudio → GitHub Actions)
   PWA ──► Sube job_<id>.json (kind: "render") a _AutoCut_Jobs → POST /api/cloud-render/dispatch
               │
               ▼
        GitHub Actions (FFmpeg nativo)
               ├─ Sincronía exacta A/V, HDR→SDR BT.709, loudnorm -14 LUFS 2 pasadas
               ├─ Subtítulos ASS generados desde timestamps reales palabra a palabra
               └─ Sube MP4 final a _AutoCut_Output (bloques resumables de 8 MB)
```

### Tiempos estimados (runner público 4 vCPU)
- **~3–7 minutos** para ~10 minutos de bruto total usando Whisper `small` (por defecto) + Gemini `gemini-3.8-flash`.
- **«Rehacer historia»**: ~30–60 segundos (reutiliza la transcripción cacheada en `_AutoCut_Jobs/_cache/` sin volver a ejecutar Whisper).
- Con Whisper `medium` (selectable en **Ajustes → Modelo de transcripción**): más preciso con ruido/acentos, aproximadamente ~6–9 minutos por cada 10 minutos de bruto.
- Si prefieres analizar al instante en el navegador sin esperar al runner (solo fotogramas, sin audio), siempre tienes disponible el botón secundario **«Análisis rápido (sin audio)»**.

---

## Repositorio público vs. repositorio privado

| Aspecto | Repositorio público | Repositorio privado |
| --- | --- | --- |
| **Minutos gratis de GitHub Actions** | **Ilimitados** (0 €) | **2.000 min/mes** (0 €) |
| **Hardware del runner** | 4 vCPU / 16 GB RAM | 2 vCPU / 7 GB RAM |
| **Privacidad de los logs** | Los logs de Actions son visibles públicamente | Solo visibles para ti |
| **Qué hace el worker para proteger tu privacidad** | Enmascara todos los tokens y `GEMINI_API_KEY` (`::add-mask::`) y **nunca** imprime nombres de archivo, transcripciones, tokens, cabeceras ni IDs de carpetas — solo telemetría numérica (`jobId`, clips, cortes, MB, segundos, etapa y código HTTP). | Igual (misma protección de logs). |

> **Recomendación**:
> - Si vas a analizar y renderizar muchos vídeos al mes, un **repositorio público** te da minutos ilimitados y 4 vCPU (el doble de rápido con Whisper), con logs estrictamente saneados.
> - Si prefieres máxima privacidad incluso en los registros de ejecución y consumes menos de ~30 horas/mes, un **repositorio privado** entra de sobra en los 2.000 minutos gratuitos.

---

## Paso 1 — Crear un Fine-Grained Personal Access Token (PAT) en GitHub

Este token permite únicamente al backend de la PWA disparar el workflow `.github/workflows/cloud-render.yml`. **Nunca** se expone en el navegador.

1. Abre **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens** (`https://github.com/settings/tokens?type=beta`).
2. Pulsa **Generate new token**.
3. Rellena:
   - **Token name**: `AutoCut Cloud Dispatch`
   - **Expiration**: elige la duración que prefieras (por ejemplo 90 días o 1 año; recuerda renovarlo antes de caducar).
   - **Repository access**: **Only select repositories** → selecciona únicamente tu repo (ej. `60F10/AutoCut-Drive-AI`).
4. En **Repository permissions**, activa **únicamente**:
   - **Actions**: `Read and write`
   - *(Deja el resto en `No access`.)*
5. Pulsa **Generate token** y copia el valor (`github_pat_...`). Lo necesitarás en el **Paso 5**.

---

## Paso 2 — Crear cliente OAuth de Google Cloud para el worker

El runner de GitHub Actions necesita un `refresh_token` de Google Drive para descargar los brutos de tu carpeta, guardar el caché de transcripciones y subir el MP4 final.

1. Abre [Google Cloud Console](https://console.cloud.google.com/) y selecciona el mismo proyecto de Google Cloud que usas con AutoCut (o crea uno nuevo).
2. Ve a **APIs y servicios → Biblioteca**, busca **Google Drive API** y asegúrate de que está **Habilitada**.
3. Ve a **APIs y servicios → Pantalla de consentimiento de OAuth** (o **Google Auth Platform → Público / Audience**):
   - Añade tu correo de Google en **Usuarios de prueba** mientras haces la prueba inicial.
   - **CRÍTICO — Publicar la app en producción**: cuando acabes de generar el token (o antes), cambia el estado de publicación de **Prueba (Testing)** a **En producción (In production)**.
   - **¿Por qué es imprescindible?** En Google Cloud, las apps en modo *Testing* caducan los `refresh_token` automáticamente a los **7 días**. Al pasarla a **En producción** (sin necesidad de verificación pública mientras solo la uses tú mismo), el `refresh_token` **no caduca a los 7 días**.
4. Ve a **APIs y servicios → Credenciales → + Crear credenciales → ID de cliente de OAuth**:
   - **Tipo de aplicación**: `Aplicación web`
   - **Nombre**: `AutoCut Cloud Worker`
   - **URI de redireccionamiento autorizados**: añade exactamente:
     ```text
     https://developers.google.com/oauthplayground
     ```
5. Pulsa **Crear** y guarda:
   - `ID de cliente` → será tu `GDRIVE_CLIENT_ID`
   - `Secreto del cliente` → será tu `GDRIVE_CLIENT_SECRET`

---

## Paso 3 — Obtener el `GDRIVE_REFRESH_TOKEN` con OAuth 2.0 Playground

1. Abre [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Pulsa el icono de **engranaje (⚙ OAuth 2.0 configuration)** arriba a la derecha:
   - Marca la casilla **Use your own OAuth credentials**.
   - Pega tu **OAuth Client ID** (`GDRIVE_CLIENT_ID`) y tu **OAuth Client secret** (`GDRIVE_CLIENT_SECRET`).
   - Cierra el menú del engranaje.
3. En el panel izquierdo (**Step 1: Select & authorize APIs**), abajo en el campo *Input your own scopes*, escribe exactamente:
   ```text
   https://www.googleapis.com/auth/drive
   ```
   y pulsa **Authorize APIs**.
4. Inicia sesión con tu cuenta de Google Drive.
   - Si Google muestra la pantalla *"Google no ha verificado esta aplicación"*, pulsa **Configuración avanzada → Ir a AutoCut Cloud Worker (no seguro)** (es tu propia aplicación privada) y concede acceso.
5. En **Step 2: Exchange authorization code for tokens**, pulsa **Exchange authorization code for tokens**.
6. Copia el valor del campo **`Refresh token`** (empieza habitualmente por `1//0...`). Ese es tu `GDRIVE_REFRESH_TOKEN`.

> **Importante**: si la app aún estaba en modo *Testing*, vuelve a Google Cloud Console y asegúrate de pasar la pantalla de consentimiento a **En producción** para evitar la caducidad de 7 días.

---

## Paso 4 — Añadir los 5 secretos (y variable opcional) en GitHub Actions

1. En tu repositorio de GitHub, ve a **Settings → Secrets and variables → Actions → Secrets → New repository secret**.
2. Crea exactamente estos **5 secretos**:

| Nombre del secreto | Obligatorio | Valor |
| --- | --- | --- |
| `GDRIVE_CLIENT_ID` | Sí | El ID de cliente OAuth creado en el Paso 2. |
| `GDRIVE_CLIENT_SECRET` | Sí | El Secreto de cliente OAuth creado en el Paso 2. |
| `GDRIVE_REFRESH_TOKEN` | Sí | El Refresh token obtenido en OAuth Playground (Paso 3). |
| `AUTOCUT_ROOT_FOLDER_ID` | Sí | El ID de tu carpeta raíz de vídeos en Google Drive (el mismo que pegas en **Ajustes** de la PWA, p. ej. `1A2B3C4D5E...`). |
| `GEMINI_API_KEY` | Sí (para análisis) | Tu clave de API de Google Gemini (la misma que usas en el servidor). El workflow la enmascara automáticamente con `::add-mask::`. |

3. *(Opcional)* En **Settings → Secrets and variables → Actions → Variables → New repository variable**, puedes añadir:

| Nombre de la variable | Valor por defecto | Descripción |
| --- | --- | --- |
| `WHISPER_MODEL` | `small` | Modelo por defecto de `faster-whisper` (`small` o `medium`) para precalentar la caché de Hugging Face. El selector **Modelo de transcripción** en **Ajustes** de la PWA tiene prioridad si eliges otro. |

> Asegúrate de que la pestaña **Actions** está habilitada en tu repositorio y que `.github/workflows/cloud-render.yml`, `worker/transcribe.py` y `worker/analyze-core.mjs` están subidos a la rama `main`.

---

## Paso 5 — Configurar los secretos del servidor en AI Studio (y Republicar)

En el panel de **Settings → Secrets** (variables de entorno de servidor) de Google AI Studio — o en tu archivo `.env` si despliegas por tu cuenta — añade estas variables **solo de servidor** (nunca con prefijo `VITE_`):

| Variable | Obligatoria | Ejemplo | Descripción |
| --- | --- | --- | --- |
| `GITHUB_DISPATCH_TOKEN` | Sí | `github_pat_...` | El Fine-Grained PAT del Paso 1 con permiso `Actions: Read and write`. |
| `GITHUB_REPO` | Sí | `60F10/AutoCut-Drive-AI` | Tu repositorio en formato `usuario/repositorio`. |
| `GITHUB_REF` | Opcional | `main` | Rama donde vive `.github/workflows/cloud-render.yml` (por defecto `main`). |

**Después de guardar los secretos en AI Studio, pulsa «Republish» (Republicar)** para que el servidor reinicie con las nuevas variables.

### Cómo comprobar que está activo
1. Abre la PWA y entra en **Ajustes**.
2. En la tarjeta **Análisis y render en la nube**, el estado debe cambiar a **`CONFIGURADO`**.
3. En la **Cola** (o en el modal **Multi-Clip**), el botón principal **«Analizar en la nube (recomendado)»** aparecerá habilitado.
4. Cuando termine el análisis, el **Estudio de cortes** se abrirá automáticamente con el guion, los cortes y el texto hablado real listo para pulsar **«Renderizar en la nube (recomendado)»**.

---

## Notas de seguridad recomendadas

1. **Restringir la `apiKey` web de Firebase por dominio (HTTP Referrers)**:
   Aunque `firebase-applet-config.json` solo contiene identificadores públicos de cliente web (es normal y esperado por Firebase), conviene entrar en **Google Cloud Console → APIs y servicios → Credenciales → Browser key (auto created by Firebase)** y restringirla a los dominios exactos donde corre tu PWA (`*.run.app`, `localhost:3000`, etc.) usando **Restricciones de aplicaciones → Sitios web (referentes HTTP)**.
2. **Privacidad de `GITHUB_DISPATCH_TOKEN` y `GEMINI_API_KEY`**:
   `GITHUB_DISPATCH_TOKEN` vive únicamente en `server.ts` y solo acepta llamadas `POST /api/cloud-render/dispatch` validadas con IDs de archivo de Drive (`^[A-Za-z0-9_-]{10,128}$`) y limitadas a 10 peticiones por minuto. `GEMINI_API_KEY` en GitHub Actions se enmascara con `::add-mask::`, y los proxies subidos a Gemini Files API se eliminan siempre en `finally`.
3. **Limpieza automática de clips locales (`_sources/`) y caché de transcripciones (`_cache/`)**:
   Si analizas o renderizas un vídeo local de la galería del móvil, la PWA lo sube una sola vez en bloques de 8 MB a `_AutoCut_Jobs/_sources/` y lo limpia al completar el render. Las transcripciones de Whisper se cachean en `_AutoCut_Jobs/_cache/transcript_<driveFileId>_<modifiedTime>.json` para que «Rehacer historia» sea casi instantáneo. Tus vídeos originales en Google Drive **nunca** se modifican ni se eliminan.

---

## Solución rápida de problemas

- **El botón «Analizar en la nube» está deshabilitado**: revisa que Drive esté conectado, el ID de carpeta guardado en **Ajustes** y que `GITHUB_DISPATCH_TOKEN` y `GITHUB_REPO` estén configurados en el servidor (recuerda pulsar **Republish**).
- **Error `[Análisis IA] Falta el secreto GEMINI_API_KEY en GitHub Actions`**: añade el secreto `GEMINI_API_KEY` en **GitHub → Settings → Secrets and variables → Actions**.
- **Error `401 / 403` al pulsar Analizar o Renderizar en la nube**: el `GITHUB_DISPATCH_TOKEN` caducó o no tiene el permiso `Actions: Read and write` sobre ese repositorio exacto.
- **Error `[Drive] No se pudo renovar el token OAuth (invalid_grant)`**: el `GDRIVE_REFRESH_TOKEN` caducó (comprueba que la pantalla OAuth esté **En producción** en Google Cloud) o fue revocado; repite el Paso 3 y actualiza `GDRIVE_REFRESH_TOKEN` en GitHub Secrets.
- **El trabajo se queda en «En cola nube» más de 3 minutos**: la PWA intenta relanzarlo automáticamente al abrirse, y también puedes pulsar **«Reintentar envío»** en la cola o revisar la pestaña **Actions** de GitHub.
