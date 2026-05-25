# Despliegue del worker `one2one-worker`

Este worker (Cloudflare Workers) actúa como **proxy seguro** entre el frontend
(`one2onepro.es`) y dos APIs externas: **Anthropic** (asistente y validación
de DNI con visión) y **Google Drive** (subida de fotos del DNI). Tener este
worker es obligatorio para que la web funcione end-to-end: las claves nunca
viven en el navegador.

```
Navegador (one2onepro.es)
        │
        │ /upload-drive  /chat  /validate-dni
        ▼
 Cloudflare Worker  ──►  Anthropic API · Google Drive API
```

---

## Parte A · Crear la cuenta de servicio de Google

1. **Google Cloud Console** → https://console.cloud.google.com/
2. Selector de proyectos arriba → **Nuevo proyecto** → nómbralo `one2one-pro-worker` → crear.
3. Menú lateral → **APIs y servicios** → **Biblioteca** → busca **Google Drive API** → **Habilitar**.
4. Menú lateral → **APIs y servicios** → **Credenciales** → **Crear credenciales** → **Cuenta de servicio**.
   - Nombre: `one2one-drive-uploader`
   - Descripción: `Sube fotos de DNI desde el worker`
   - **Crear y continuar** → en "Rol" puedes saltar (no se necesita rol del proyecto, los permisos vienen de la carpeta) → **Listo**.
5. En la lista de credenciales, clic sobre la cuenta de servicio recién creada.
6. Pestaña **Claves** → **Agregar clave** → **Crear clave nueva** → tipo **JSON** → **Crear**.
   Se descarga un archivo `one2one-pro-worker-XXXXX.json`. **Guárdalo a buen recaudo: solo se descarga una vez.**
7. Abre ese JSON y copia el valor del campo `client_email` (algo como
   `one2one-drive-uploader@one2one-pro-worker.iam.gserviceaccount.com`).
   Lo necesitas para el siguiente paso.

## Parte B · Crear y compartir la carpeta de Drive

1. Entra a https://drive.google.com con la cuenta de Google de la empresa.
2. Crea una carpeta llamada **`DNIs One2One Pro`** en la raíz (o donde quieras).
3. Clic derecho sobre la carpeta → **Compartir** → en "Añadir personas y
   grupos" pega el `client_email` del paso anterior → permiso **Editor** →
   desactiva "Notificar a la gente" → **Compartir**.
4. Entra dentro de la carpeta y copia el **ID** de la URL del navegador.
   La URL es del tipo:
   ```
   https://drive.google.com/drive/folders/1A2B3C4D5E6F7G8H9I0JKLMNO
                                          ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑
                                          este es el folder ID
   ```

## Parte C · Crear el worker en Cloudflare

1. Si no tienes cuenta: https://dash.cloudflare.com/sign-up — gratis.

2. Instala Wrangler (CLI de Cloudflare):
   ```bash
   npm install -g wrangler
   wrangler --version    # comprueba que está instalado
   ```

3. Login (abre el navegador):
   ```bash
   wrangler login
   ```

4. Crea el proyecto del worker en una carpeta APARTE del repo (Wrangler
   gestiona su propia estructura). Por ejemplo:
   ```bash
   cd ~/Desktop
   mkdir one2one-worker && cd one2one-worker
   wrangler init . --yes
   ```
   Cuando pregunte:
   - "Would you like to use TypeScript?" → **No**
   - "Would you like to use git?" → **No** (o sí, da igual)
   - "Would you like to deploy your application?" → **No, todavía no**

5. Copia el archivo `worker.js` del repo `one2onepro` dentro de `src/index.js`
   (sobrescribe el contenido):
   ```bash
   cp /ruta/al/repo/one2onepro/worker.js ./src/index.js
   ```

6. Edita `wrangler.toml` para fijar nombre y compatibilidad:
   ```toml
   name = "one2one-worker"
   main = "src/index.js"
   compatibility_date = "2025-01-01"
   ```

## Parte D · Configurar las variables de entorno (secrets)

Las claves nunca van en el código. Cloudflare las inyecta en runtime.

### Opción 1 · CLI (recomendado)

```bash
wrangler secret put ANTHROPIC_API_KEY
# pega la key sk-ant-...  Enter

wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
# pega TODO el JSON de la cuenta de servicio en UNA sola línea  Enter
# (truco: en macOS, `cat archivo.json | pbcopy` y luego cmd+v)

wrangler secret put GOOGLE_DRIVE_FOLDER_ID
# pega el ID de la carpeta  Enter
```

### Opción 2 · Dashboard

1. https://dash.cloudflare.com → Workers & Pages → tu worker → **Settings** → **Variables and Secrets**.
2. Añade los tres como **Secret** (no como Plain text).

## Parte E · Desplegar

```bash
wrangler deploy
```

Salida esperada:
```
Published one2one-worker (X.XX sec)
  https://one2one-worker.<usuario>.workers.dev
```

Guarda esa URL. Es la que pondrás en `WORKER_URL` del `index.html`.

## Parte F · Comprobar que funciona

Test rápido del chat (no necesita Drive):

```bash
curl -i -X POST https://one2one-worker.<usuario>.workers.dev/chat \
  -H "Content-Type: application/json" \
  -H "Origin: https://one2onepro.es" \
  -d '{"message":"Hola, ¿qué es One2One Pro?"}'
```

Debe responder `200` con un JSON `{ "text": "...", "usage": {...} }`.

Test del endpoint de Drive con una imagen mínima:

```bash
# Generamos una imagen 1×1 PNG en base64
B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
curl -i -X POST https://one2one-worker.<usuario>.workers.dev/upload-drive \
  -H "Content-Type: application/json" \
  -H "Origin: https://one2onepro.es" \
  -d "{\"filename\":\"test.png\",\"mimeType\":\"image/png\",\"base64\":\"$B64\"}"
```

Debe responder con `{ "fileId": "...", "url": "https://drive.google.com/uc?id=..." }`
y el archivo `test.png` debe aparecer en la carpeta de Drive.

## Parte G · Apuntar el frontend al worker

En `index.html` del repo `one2onepro` busca:

```javascript
const WORKER_URL = 'https://one2one-worker.USUARIO.workers.dev';
```

Reemplaza `USUARIO` por tu subdominio real, commit y push.

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| `502 Drive upload failed` con `permission denied` | La carpeta de Drive no está compartida con `client_email` de la service account, o no tiene permiso de **Editor**. |
| `Token exchange failed` | El JSON de la service account está corrupto (saltos de línea perdidos en `private_key`). Vuelve a pegarlo asegurándote de que los `\n` están como `\n` literales. |
| `Anthropic error 401` | `ANTHROPIC_API_KEY` mal o revocada. |
| CORS bloqueado en el navegador | El `Origin` desde el que se llama no está en `ALLOWED_ORIGINS` del `worker.js`. Añade el dominio (p. ej. el de Cloudflare Pages preview) y vuelve a desplegar. |
| El archivo subido a Drive sale como `application/octet-stream` y no como imagen | El cliente no mandó `mimeType` ni un `data:image/...` prefix. El worker hace fallback a `image/jpeg`. |

## Costes esperados

- **Cloudflare Workers (Free plan)**: 100 000 requests/día gratis. Suficiente para validación de DNI a baja escala.
- **Google Drive**: gratis hasta 15 GB en la cuenta personal. Cada DNI pesa ~1-2 MB → ~10 000 DNIs en el cupo gratuito.
- **Anthropic**: pago por uso. `claude-sonnet-4` con visión cuesta ~$3/M tokens entrada · ~$15/M salida. Una validación de DNI ≈ 1500-2500 tokens → ~$0,01 por validación. Un chat de 5 turnos ≈ $0,02-0,05.

## Seguridad

- Los secrets de Cloudflare están cifrados at rest y nunca se exponen al navegador.
- El JWT de Google se firma con `crypto.subtle` (Web Crypto API) dentro del worker; la `private_key` jamás sale del entorno de Cloudflare.
- CORS está restringido por allow-list al dominio de producción. Si necesitas probar desde `localhost`, edita `ALLOWED_ORIGINS` en `worker.js`.
- El worker fija un allow-list de MIME types (jpg/png/webp/heic/heif) antes de subir a Drive para evitar abusos.
