# Guía de configuración — Render en la nube con GitHub Actions (0 €)

Esta guía configura el **renderizado en la nube de AutoCut Drive AI** usando **GitHub Actions** y **FFmpeg nativo**, sin coste, sin tarjeta de crédito y sin tener que dejar ningún PC encendido. Se configura **una sola vez** (~10 minutos).

---

## Cómo funciona

```text
Móvil (PWA) ──► Sube job_<id>.json a Google Drive (_AutoCut_Jobs)
            ──► Llama a POST /api/cloud-render/dispatch (tu servidor)
                    │
                    ▼
             GitHub Actions (ubuntu-latest · FFmpeg nativo)
                    ├─ Descarga los brutos por streaming a disco (sin límites de RAM)
                    ├─ Renderiza 9:16 con libx264 (veryfast 1080p / ultrafast 720p)
                    ├─ Sube el MP4 a _AutoCut_Output (bloques resumables de 8 MB)
                    └─ Actualiza el progreso (%) y estado en job_<id>.json
```

---

## Repositorio público vs. repositorio privado

| Aspecto | Repositorio público | Repositorio privado |
| --- | --- | --- |
| **Minutos gratis de GitHub Actions** | **Ilimitados** (0 €) | **2.000 min/mes** (0 €) |
| **Hardware del runner** | 4 vCPU / 16 GB RAM | 2 vCPU / 7 GB RAM |
| **Privacidad de los logs** | Los logs de Actions son visibles públicamente | Solo visibles para ti |
| **Qué hace el worker para proteger tu privacidad** | Enmascara todos los tokens (`::add-mask::`) y **nunca** imprime nombres de archivo, tokens, cabeceras ni IDs de carpetas — solo telemetría numérica (`jobId`, número de clips, MB, segundos, etapa y código HTTP). | Igual (misma protección de logs). |

> **Recomendación**:
> - Si vas a renderizar muchos vídeos al mes o en 1080p rápido, un **repositorio público** te da minutos ilimitados y 4 vCPU, con logs estrictamente saneados.
> - Si prefieres máxima privacidad incluso en los registros de ejecución y renderizas menos de ~30 horas/mes, un **repositorio privado** entra de sobra en los 2.000 minutos gratuitos.

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

El runner de GitHub Actions necesita un `refresh_token` de Google Drive para descargar los brutos de tu carpeta y subir el MP4 final.

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

## Paso 4 — Añadir los 4 secretos en GitHub Actions

1. En tu repositorio de GitHub, ve a **Settings → Secrets and variables → Actions → New repository secret**.
2. Crea exactamente estos **4 secretos**:

| Nombre del secreto | Valor |
| --- | --- |
| `GDRIVE_CLIENT_ID` | El ID de cliente OAuth creado en el Paso 2. |
| `GDRIVE_CLIENT_SECRET` | El Secreto de cliente OAuth creado en el Paso 2. |
| `GDRIVE_REFRESH_TOKEN` | El Refresh token obtenido en OAuth Playground (Paso 3). |
| `AUTOCUT_ROOT_FOLDER_ID` | El ID de tu carpeta raíz de vídeos en Google Drive (el mismo que pegas en **Ajustes** de la PWA, p. ej. `1A2B3C4D5E...`). |

> Asegúrate de que la pestaña **Actions** está habilitada en tu repositorio y que el archivo `.github/workflows/cloud-render.yml` está subido a la rama `main`.

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
2. En la tarjeta **Render en la nube**, el estado debe cambiar a **`CONFIGURADO`**.
3. Entra en **Estudio de cortes** con cualquier vídeo analizado: el botón principal **«Renderizar en la nube (recomendado)»** aparecerá habilitado.

---

## Notas de seguridad recomendadas

1. **Restringir la `apiKey` web de Firebase por dominio (HTTP Referrers)**:
   Aunque `firebase-applet-config.json` solo contiene identificadores públicos de cliente web (es normal y esperado por Firebase), conviene entrar en **Google Cloud Console → APIs y servicios → Credenciales → Browser key (auto created by Firebase)** y restringirla a los dominios exactos donde corre tu PWA (`*.run.app`, `localhost:3000`, etc.) usando **Restricciones de aplicaciones → Sitios web (referentes HTTP)**.
2. **Privacidad de `GITHUB_DISPATCH_TOKEN`**:
   El token de GitHub vive únicamente en `server.ts` y solo acepta llamadas `POST /api/cloud-render/dispatch` validadas con IDs de archivo de Drive (`^[A-Za-z0-9_-]{10,128}$`) y limitadas a 10 peticiones por minuto.
3. **Limpieza automática de clips locales (`_sources/`)**:
   Si renderizas en la nube un vídeo subido desde la galería del móvil (que aún no estaba en Drive), la PWA lo sube primero en bloques de 8 MB a `_AutoCut_Jobs/_sources/` y lo borra automáticamente en cuanto el render termina. Tus vídeos originales en Google Drive **nunca** se modifican ni se eliminan.

---

## Solución rápida de problemas

- **El botón dice «Configura el render en la nube (ver Ajustes)»**: faltan `GITHUB_DISPATCH_TOKEN` o `GITHUB_REPO` en el servidor, o falta pulsar **Republish** tras añadirlos.
- **Error `401 / 403` al pulsar Renderizar en la nube**: el `GITHUB_DISPATCH_TOKEN` caducó o no tiene el permiso `Actions: Read and write` sobre ese repositorio exacto.
- **Error `[Drive] No se pudo renovar el token OAuth (invalid_grant)`**: el `GDRIVE_REFRESH_TOKEN` caducó (comprueba que la pantalla OAuth esté **En producción** en Google Cloud) o fue revocado; repite el Paso 3 y actualiza `GDRIVE_REFRESH_TOKEN` en GitHub Secrets.
- **El trabajo se queda en «En cola nube» más de 3 minutos**: la PWA intenta relanzarlo automáticamente al abrirse, y también puedes pulsar **«Reintentar envío»** en el panel **Renders remotos** o revisar la pestaña **Actions** de GitHub.
