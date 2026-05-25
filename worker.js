/**
 * One2One Pro · Cloudflare Worker
 *
 * Endpoints:
 *   POST /upload-drive  → sube una imagen base64 a la carpeta "DNIs One2One
 *                         Pro" de Google Drive y devuelve la URL pública.
 *   POST /chat          → proxy seguro a la API de Anthropic (Claude) con el
 *                         system prompt del asistente de One2One Pro.
 *   POST /validate-dni  → recibe nombre, apellidos, dni, fechaNacimiento y
 *                         dos imágenes base64 (anverso/reverso) y pide a
 *                         Claude vision que verifique que los datos del
 *                         documento coinciden con los introducidos.
 *
 * Variables de entorno requeridas (NO hardcodeadas):
 *   ANTHROPIC_API_KEY            → secret · sk-ant-...
 *   GOOGLE_SERVICE_ACCOUNT_KEY   → secret · JSON completo de la service
 *                                  account (incluyendo private_key)
 *   GOOGLE_DRIVE_FOLDER_ID       → secret/plain · ID de la carpeta de Drive
 *
 * CORS: permitido para one2onepro.es y www.one2onepro.es.
 */

const ALLOWED_ORIGINS = [
  'https://one2onepro.es',
  'https://www.one2onepro.es'
];

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT_CHAT = `Eres el asistente virtual de One2One Pro, una empresa española especializada en gestión laboral para artistas y técnicos de espectáculos bajo el Régimen Especial de Artistas (Real Decreto 1435/1985).

Responde siempre en español. Sé conciso, claro y profesional. Solo respondes preguntas relacionadas con: altas en la Seguridad Social para artistas, el Régimen Especial de Artistas, cachés, IRPF para artistas, cómo funciona One2One Pro, expedientes, pagos, y dudas legales básicas del sector musical y de espectáculos.

Si alguien pregunta algo fuera de este ámbito, diles amablemente que solo puedes ayudar con temas relacionados con One2One Pro y el sector artístico.

One2One Pro cobra una comisión del 10% sobre el caché acordado. Opera exclusivamente bajo el RD 1435/1985. No gestiona hostelería ni otros sectores. El promotor paga el caché más IVA 21%. Los costes de SS se descuentan del caché junto con la comisión.`;

/* ─── HTTP entry point ──────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsBase = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsBase });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/upload-drive') {
        return await handleUploadDrive(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/chat') {
        return await handleChat(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/validate-dni') {
        return await handleValidateDni(request, env, corsBase);
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return jsonResponse({ ok: true, service: 'one2one-worker' }, 200, corsBase);
      }
      return jsonResponse({ error: 'Not found', path: url.pathname }, 404, corsBase);
    } catch (e) {
      console.error(e);
      return jsonResponse({ error: 'Internal error', detail: String(e && e.message || e) }, 500, corsBase);
    }
  }
};

/* ─── CORS / response helpers ──────────────────────────────────────────── */

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {})
  });
}

/* ─── /upload-drive ────────────────────────────────────────────────────── */

async function handleUploadDrive(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const { filename, mimeType, base64 } = body || {};
  if (!base64 || typeof base64 !== 'string') {
    return jsonResponse({ error: 'Missing or invalid `base64`' }, 400, cors);
  }
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY || !env.GOOGLE_DRIVE_FOLDER_ID) {
    return jsonResponse({ error: 'Worker not configured (missing GOOGLE_* env)' }, 500, cors);
  }

  // Strip data URL prefix if present and detect MIME
  let cleanB64 = base64;
  let detectedMime = mimeType || 'image/jpeg';
  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(base64);
  if (dataUrlMatch) {
    detectedMime = dataUrlMatch[1];
    cleanB64 = dataUrlMatch[2];
  }
  // Strict allowlist of MIME types
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(detectedMime)) {
    return jsonResponse({ error: 'Unsupported mime type: ' + detectedMime }, 400, cors);
  }

  const bytes = base64ToBytes(cleanB64);
  const finalName = sanitizeFilename(filename) || ('dni_' + Date.now() + '.' + extFromMime(detectedMime));

  const token = await getGoogleAccessToken(env);
  const folderId = env.GOOGLE_DRIVE_FOLDER_ID;

  // Multipart upload (single request: metadata + bytes)
  const metadata = { name: finalName, parents: [folderId] };
  const boundary = '----o2o' + Math.random().toString(36).slice(2);

  const head = '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + detectedMime + '\r\n\r\n';
  const tail = '\r\n--' + boundary + '--\r\n';

  const headBytes = new TextEncoder().encode(head);
  const tailBytes = new TextEncoder().encode(tail);
  const multipart = new Uint8Array(headBytes.length + bytes.length + tailBytes.length);
  multipart.set(headBytes, 0);
  multipart.set(bytes, headBytes.length);
  multipart.set(tailBytes, headBytes.length + bytes.length);

  const uploadResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': String(multipart.byteLength)
      },
      body: multipart
    }
  );
  const uploadData = await uploadResp.json();
  if (!uploadResp.ok || !uploadData.id) {
    return jsonResponse({ error: 'Drive upload failed', status: uploadResp.status, detail: uploadData }, 502, cors);
  }
  const fileId = uploadData.id;

  // Make publicly readable (anyone with link can view)
  const permResp = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/permissions?supportsAllDrives=true',
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    }
  );
  if (!permResp.ok) {
    const detail = await permResp.text();
    // The file is uploaded but not public; surface the warning but still return URL
    console.warn('Permission grant failed', permResp.status, detail);
  }

  // Public-friendly URLs for embedding. The "uc" form streams the binary.
  return jsonResponse({
    fileId: fileId,
    url: 'https://drive.google.com/uc?id=' + fileId,
    viewUrl: 'https://drive.google.com/file/d/' + fileId + '/view',
    name: finalName,
    mimeType: detectedMime,
    size: bytes.length
  }, 200, cors);
}

/* ─── /chat ─────────────────────────────────────────────────────────────── */

async function handleChat(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const { message, history } = body || {};
  if (!message || typeof message !== 'string') {
    return jsonResponse({ error: 'Missing `message`' }, 400, cors);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Worker not configured (missing ANTHROPIC_API_KEY)' }, 500, cors);
  }

  const safeHistory = Array.isArray(history)
    ? history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-20)
    : [];
  const messages = safeHistory.concat([{ role: 'user', content: message }]);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT_CHAT,
      messages: messages
    })
  });
  const data = await resp.json();
  if (!resp.ok) {
    return jsonResponse({ error: 'Anthropic error', status: resp.status, detail: data }, 502, cors);
  }
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  return jsonResponse({ text: text, usage: data.usage || null }, 200, cors);
}

/* ─── /validate-dni ────────────────────────────────────────────────────── */

async function handleValidateDni(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const { nombre, apellidos, dni, fechaNacimiento, anversoBase64, reversoBase64 } = body || {};
  if (!anversoBase64 || !reversoBase64) {
    return jsonResponse({ error: 'Missing `anversoBase64` and/or `reversoBase64`' }, 400, cors);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Worker not configured (missing ANTHROPIC_API_KEY)' }, 500, cors);
  }

  const anv = extractImage(anversoBase64);
  const rev = extractImage(reversoBase64);

  const userText = 'Eres un sistema de verificación de identidad. Analiza las imágenes del documento de identidad adjuntas y verifica que los datos proporcionados coinciden exactamente con los del documento.\n\n' +
    'Datos proporcionados:\n' +
    '- Nombre: ' + (nombre || '') + '\n' +
    '- Apellidos: ' + (apellidos || '') + '\n' +
    '- Número documento: ' + (dni || '') + '\n' +
    '- Fecha nacimiento: ' + (fechaNacimiento || '') + '\n\n' +
    'Responde ÚNICAMENTE con JSON en este formato:\n' +
    '{\n' +
    '  "valido": true/false,\n' +
    '  "confianza": "alta/media/baja",\n' +
    '  "discrepancias": ["lista de discrepancias si las hay"],\n' +
    '  "mensaje": "explicación breve"\n' +
    '}';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image', source: { type: 'base64', media_type: anv.mime, data: anv.b64 } },
          { type: 'image', source: { type: 'base64', media_type: rev.mime, data: rev.b64 } }
        ]
      }]
    })
  });
  const data = await resp.json();
  if (!resp.ok) {
    return jsonResponse({ error: 'Anthropic error', status: resp.status, detail: data }, 502, cors);
  }
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  let parsed = null;
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {}
  }
  return jsonResponse({ result: parsed, raw: text, usage: data.usage || null }, 200, cors);
}

/* ─── Google service account JWT → access token ────────────────────────── */

async function getGoogleAccessToken(env) {
  const sa = typeof env.GOOGLE_SERVICE_ACCOUNT_KEY === 'string'
    ? JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY)
    : env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!sa || !sa.client_email || !sa.private_key) {
    throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY (missing client_email or private_key)');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const enc = obj => base64UrlEncodeString(JSON.stringify(obj));
  const unsigned = enc(header) + '.' + enc(claims);

  const key = await importRsaPrivateKey(sa.private_key);
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const sig = base64UrlEncodeBytes(new Uint8Array(sigBuf));
  const jwt = unsigned + '.' + sig;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt)
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok || !tokenData.access_token) {
    throw new Error('Token exchange failed: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

async function importRsaPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(b64);
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/* ─── Base64 helpers ───────────────────────────────────────────────────── */

function base64ToBytes(b64) {
  // Workers run V8/JSC; atob is available and produces a binary string.
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlEncodeString(str) {
  // Use TextEncoder to handle non-ASCII safely
  const bytes = new TextEncoder().encode(str);
  return base64UrlEncodeBytes(bytes);
}

function base64UrlEncodeBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ─── Small utils ──────────────────────────────────────────────────────── */

function extractImage(value) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(value);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: 'image/jpeg', b64: value };
}

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.indexOf('png') >= 0) return 'png';
  if (m.indexOf('webp') >= 0) return 'webp';
  if (m.indexOf('heic') >= 0) return 'heic';
  if (m.indexOf('heif') >= 0) return 'heif';
  return 'jpg';
}
