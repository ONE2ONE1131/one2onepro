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
  const allowed = [
    'https://one2onepro.es',
    'https://www.one2onepro.es',
    'http://localhost'
  ];
  const o = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { filename, mimeType, base64 } = body || {};
  if (!base64) return jsonResponse({ error: 'Missing or invalid base64' }, 400);

  // Strip data URL prefix if present
  let cleanB64 = base64;
  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(base64);
  if (dataUrlMatch) cleanB64 = dataUrlMatch[2];

  // Upload to Cloudinary
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'DNIs_One2One_Pro';

  // Generate signature
  const strToSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const msgBuffer = new TextEncoder().encode(strToSign);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const formData = new FormData();
  formData.append('file', `data:${mimeType || 'image/jpeg'};base64,${cleanB64}`);
  formData.append('api_key', apiKey);
  formData.append('timestamp', timestamp.toString());
  formData.append('folder', folder);
  formData.append('signature', signature);

  const uploadResp = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formData }
  );

  const uploadData = await uploadResp.json();

  if (!uploadResp.ok) {
    return jsonResponse({ error: 'Cloudinary upload failed', status: uploadResp.status, detail: uploadData }, 502);
  }

  return jsonResponse({
    fileId: uploadData.public_id,
    url: uploadData.secure_url,
    viewUrl: uploadData.secure_url
  });
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
