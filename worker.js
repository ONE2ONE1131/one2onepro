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

const CLAUDE_MODEL = 'claude-sonnet-4-5';

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
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
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
      if (request.method === 'POST' && url.pathname === '/expedientes') {
        return await handleExpedientes(request, env, corsBase);
      }
      /* ─── Autenticación real (D1) ─────────────────────────────────────── */
      if (request.method === 'POST' && url.pathname === '/register') {
        return await handleRegister(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/login') {
        return await handleLogin(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/verify') {
        return await handleVerify(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/resend-verify') {
        return await handleResendVerify(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/request-reset') {
        return await handleRequestReset(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/reset-password') {
        return await handleResetPassword(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/save-profile') {
        return await handleSaveProfile(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/get-profile') {
        return await handleGetProfile(request, env, corsBase);
      }
      if (request.method === 'POST' && url.pathname === '/logout') {
        return await handleLogout(request, env, corsBase);
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

/* ─── /upload-drive (Cloudinary unsigned upload con preset one2one_unsigned) ─── */

async function handleUploadDrive(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const { filename, mimeType, base64 } = body || {};
  if (!base64 || typeof base64 !== 'string') {
    return jsonResponse({ error: 'Missing or invalid base64' }, 400, cors);
  }
  let cleanB64 = base64;
  let detectedMime = mimeType || 'image/jpeg';
  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(base64);
  if (dataUrlMatch) { detectedMime = dataUrlMatch[1]; cleanB64 = dataUrlMatch[2]; }
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return jsonResponse({ error: 'Missing CLOUDINARY_CLOUD_NAME' }, 500, cors);
  const formData = new FormData();
  formData.append('file', 'data:' + detectedMime + ';base64,' + cleanB64);
  formData.append('upload_preset', 'one2one_unsigned');
  
  const uploadResp = await fetch(
    'https://api.cloudinary.com/v1_1/' + cloudName + '/image/upload',
    { method: 'POST', body: formData }
  );
  const uploadData = await uploadResp.json();
  if (!uploadResp.ok) {
    return jsonResponse({ error: 'Cloudinary upload failed', status: uploadResp.status, detail: uploadData }, 502, cors);
  }
  return jsonResponse({ fileId: uploadData.public_id, url: uploadData.secure_url, viewUrl: uploadData.secure_url }, 200, cors);
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

/* ─── /expedientes ─────────────────────────────────────────────────────── */

async function handleExpedientes(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const { email, tipo } = body || {};
  if (!email) return jsonResponse({ error: 'Missing email' }, 400, cors);

  const campo = tipo === 'empresa' ? 'Empresa Email' : 'Trabajador Email';
  const formula = encodeURIComponent(`LOWER({${campo}})=LOWER("${email}")`);
  const url = `https://api.airtable.com/v0/app0vdAQfCNFz721B/tblN88xyEJuot1ZAu?filterByFormula=${formula}&fields[]=${encodeURIComponent('Nº Expediente')}&fields[]=${encodeURIComponent('Estado')}&fields[]=${encodeURIComponent('Actividad')}&fields[]=${encodeURIComponent('Fecha inicio')}&fields[]=${encodeURIComponent('Fecha fin')}&fields[]=${encodeURIComponent('Importe trabajador')}&fields[]=${encodeURIComponent('Empresa Razón Social')}&fields[]=${encodeURIComponent('Trabajador Nombre')}&fields[]=${encodeURIComponent('Días')}`;

  const resp = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + env.AIRTABLE_TOKEN,
      'Content-Type': 'application/json'
    }
  });

  const data = await resp.json();
  if (!resp.ok) return jsonResponse({ error: 'Airtable error', detail: data }, 502, cors);

  return jsonResponse({ expedientes: data.records || [] }, 200, cors);
}


/* ═══════════════════════════════════════════════════════════════════════════
   AUTENTICACIÓN REAL (Cloudflare D1 · binding env.one2one_db)

   Endpoints: /register · /login · /verify · /request-reset · /reset-password

   Seguridad:
   - Contraseñas hasheadas con PBKDF2-SHA256 (100.000 iteraciones, sal aleatoria
     de 16 bytes). Se guarda "saltHex:hashHex". NUNCA contraseña en claro.
   - SIEMPRE consultas preparadas con .bind() (sin concatenar SQL → sin inyección).
   - El Worker NO envía emails: devuelve los tokens para que los envíe Make.
   ═══════════════════════════════════════════════════════════════════════════ */

const PBKDF2_ITERATIONS = 100000;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;     // 24 horas
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;           // 1 hora
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // 30 días
const MAX_PROFILE_BYTES = 32 * 1024;                 // límite del JSON de perfil

function bufToHex(buf) {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(hex) {
  const clean = String(hex || '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* Token aleatorio de 32 bytes en hex (64 chars) — para verify/reset/sesión. */
function randomToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/* SHA-256 en hex de un string (para guardar el token de sesión hasheado). */
async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(digest);
}

/* Crea una sesión para userId: genera token, guarda su hash, limpia las
   sesiones caducadas de ese usuario y devuelve { sessionToken, expiresAt }. */
async function issueSession(env, userId) {
  const sessionToken = randomToken();
  const tokenHash = await sha256Hex(sessionToken);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  // Limpieza oportunista de sesiones caducadas de este usuario.
  await env.one2one_db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, now).run();
  await env.one2one_db.prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(userId, tokenHash, new Date(now).toISOString(), expiresAt).run();
  return { sessionToken, expiresAt };
}

/* Valida el token de sesión de una petición. Lee `token` del body (ya parseado)
   o de la cabecera Authorization: Bearer. Devuelve { userId } si la sesión es
   válida y no ha caducado; en otro caso null (el endpoint responde 401).
   Borra la sesión si está caducada. */
async function requireSession(request, env, body) {
  let token = body && typeof body.token === 'string' ? body.token : '';
  if (!token) {
    const auth = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) token = m[1].trim();
  }
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.one2one_db.prepare(
    'SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?'
  ).bind(tokenHash).first();
  if (!row) return null;
  if (!row.expires_at || row.expires_at < Date.now()) {
    await env.one2one_db.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run();
    return null;
  }
  return { userId: row.user_id };
}

/* Deriva el hash PBKDF2. Si se pasa saltHex se reutiliza esa sal (para verificar);
   si no, genera una sal aleatoria nueva. Devuelve "saltHex:hashHex". */
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return (saltHex || bufToHex(salt)) + ':' + bufToHex(bits);
}

/* Comparación en tiempo constante (evita timing attacks sobre el hash). */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Re-hashea `password` con la sal almacenada y compara contra el hash guardado. */
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || stored.indexOf(':') < 0) return false;
  const idx = stored.indexOf(':');
  const saltHex = stored.slice(0, idx);
  const hashHex = stored.slice(idx + 1);
  const recomputed = await hashPassword(password, saltHex);
  return timingSafeEqual(recomputed.slice(recomputed.indexOf(':') + 1), hashHex);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

/* ─── POST /register ───────────────────────────────────────────────────────
   {email, password, accountType, nombre} → {ok, verifyToken, email, nombre} */
async function handleRegister(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = typeof (body && body.password) === 'string' ? body.password : '';
  const accountType = String((body && body.accountType) || '').trim();
  const nombre = String((body && body.nombre) || '').trim();

  if (!email || !isValidEmail(email)) return jsonResponse({ error: 'Email inválido' }, 400, cors);
  if (!password || password.length < 8) return jsonResponse({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400, cors);
  if (accountType !== 'artista' && accountType !== 'empresa') return jsonResponse({ error: 'Tipo de cuenta inválido' }, 400, cors);

  const existing = await env.one2one_db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return jsonResponse({ error: 'Ya existe una cuenta con ese email. Inicia sesión.' }, 409, cors);

  const passwordHash = await hashPassword(password);
  const verifyToken = randomToken();
  const verifyExpires = Date.now() + VERIFY_TOKEN_TTL_MS;
  const createdAt = new Date().toISOString();

  await env.one2one_db.prepare(
    'INSERT INTO users (email, password_hash, account_type, nombre, verified, verify_token, verify_token_expires, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
  ).bind(email, passwordHash, accountType, nombre || null, verifyToken, verifyExpires, createdAt).run();

  return jsonResponse({ ok: true, verifyToken, email, nombre }, 200, cors);
}

/* ─── POST /login ──────────────────────────────────────────────────────────
   {email, password} → {ok, email, nombre, accountType, verified} */
async function handleLogin(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = typeof (body && body.password) === 'string' ? body.password : '';

  const fail = () => jsonResponse({ error: 'Email o contraseña incorrectos' }, 401, cors);
  if (!email || !password) return fail();

  const user = await env.one2one_db.prepare(
    'SELECT id, email, password_hash, account_type, nombre, verified FROM users WHERE email = ?'
  ).bind(email).first();

  /* Usuario inexistente: hasheamos igualmente para no filtrar por tiempo de
     respuesta qué emails están registrados, y devolvemos el mismo error. */
  if (!user) { await hashPassword(password); return fail(); }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return fail();

  if (!user.verified) {
    return jsonResponse(
      { error: 'Debes verificar tu email antes de iniciar sesión.', code: 'EMAIL_NOT_VERIFIED', email: user.email },
      403, cors
    );
  }

  const session = await issueSession(env, user.id);
  return jsonResponse(
    {
      ok: true, email: user.email, nombre: user.nombre || '', accountType: user.account_type, verified: true,
      sessionToken: session.sessionToken, expiresAt: session.expiresAt
    },
    200, cors
  );
}

/* ─── POST /verify ─────────────────────────────────────────────────────────
   {token} → {ok, email} */
async function handleVerify(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const token = String((body && body.token) || '').trim();
  if (!token) return jsonResponse({ error: 'Token requerido' }, 400, cors);

  const user = await env.one2one_db.prepare(
    'SELECT id, email, nombre, account_type, verify_token_expires FROM users WHERE verify_token = ?'
  ).bind(token).first();
  if (!user) return jsonResponse({ error: 'El enlace de verificación no es válido.' }, 400, cors);
  if (!user.verify_token_expires || user.verify_token_expires < Date.now()) {
    return jsonResponse({ error: 'El enlace de verificación ha caducado.' }, 400, cors);
  }

  const verifiedAt = new Date().toISOString();
  await env.one2one_db.prepare(
    'UPDATE users SET verified = 1, verified_at = ?, verify_token = NULL, verify_token_expires = NULL WHERE id = ?'
  ).bind(verifiedAt, user.id).run();

  /* Tras verificar, dejamos al usuario con sesión iniciada directamente. */
  const session = await issueSession(env, user.id);
  return jsonResponse(
    {
      ok: true, email: user.email, nombre: user.nombre || '', accountType: user.account_type, verified: true,
      sessionToken: session.sessionToken, expiresAt: session.expiresAt
    },
    200, cors
  );
}

/* ─── POST /resend-verify ──────────────────────────────────────────────────
   {email} → reenvía la verificación. Si el email existe y NO está verificado,
   regenera el verify_token (caducidad 24h) y lo devuelve para que Make envíe
   el email. Si no existe o ya está verificado, responde {ok:true} sin token
   (anti-enumeración, misma filosofía que /request-reset). */
async function handleResendVerify(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) return jsonResponse({ ok: true }, 200, cors);

  const user = await env.one2one_db.prepare(
    'SELECT id, email, nombre, verified FROM users WHERE email = ?'
  ).bind(email).first();
  if (!user || user.verified) return jsonResponse({ ok: true }, 200, cors);

  const verifyToken = randomToken();
  const verifyExpires = Date.now() + VERIFY_TOKEN_TTL_MS;
  await env.one2one_db.prepare(
    'UPDATE users SET verify_token = ?, verify_token_expires = ? WHERE id = ?'
  ).bind(verifyToken, verifyExpires, user.id).run();

  return jsonResponse({ ok: true, verifyToken, email: user.email, nombre: user.nombre || '' }, 200, cors);
}

/* ─── POST /request-reset ──────────────────────────────────────────────────
   {email} → siempre {ok:true} (+ {resetToken, email, nombre} si existe) */
async function handleRequestReset(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const email = String((body && body.email) || '').trim().toLowerCase();

  /* Respuesta uniforme: no revelamos si el email existe (anti-enumeración). */
  if (!email || !isValidEmail(email)) return jsonResponse({ ok: true }, 200, cors);

  const user = await env.one2one_db.prepare('SELECT id, email, nombre FROM users WHERE email = ?').bind(email).first();
  if (!user) return jsonResponse({ ok: true }, 200, cors);

  const resetToken = randomToken();
  const resetExpires = Date.now() + RESET_TOKEN_TTL_MS;
  await env.one2one_db.prepare(
    'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?'
  ).bind(resetToken, resetExpires, user.id).run();

  return jsonResponse({ ok: true, resetToken, email: user.email, nombre: user.nombre || '' }, 200, cors);
}

/* ─── POST /reset-password ─────────────────────────────────────────────────
   {token, newPassword} → {ok} */
async function handleResetPassword(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const token = String((body && body.token) || '').trim();
  const newPassword = typeof (body && body.newPassword) === 'string' ? body.newPassword : '';

  if (!token) return jsonResponse({ error: 'Token requerido' }, 400, cors);
  if (!newPassword || newPassword.length < 8) return jsonResponse({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400, cors);

  const user = await env.one2one_db.prepare(
    'SELECT id, reset_token_expires FROM users WHERE reset_token = ?'
  ).bind(token).first();
  if (!user) return jsonResponse({ error: 'El enlace de recuperación no es válido.' }, 400, cors);
  if (!user.reset_token_expires || user.reset_token_expires < Date.now()) {
    return jsonResponse({ error: 'El enlace de recuperación ha caducado.' }, 400, cors);
  }

  const passwordHash = await hashPassword(newPassword);
  await env.one2one_db.prepare(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?'
  ).bind(passwordHash, user.id).run();

  return jsonResponse({ ok: true }, 200, cors);
}

/* ─── POST /save-profile ───────────────────────────────────────────────────
   {token, profile, avatarUrl, profileStatus, profileSubmittedAt, profileValidatedAt}
   La identidad la fija el token (no el body). Guarda en profile_json o
   company_profile_json según el account_type DEL USUARIO en BD. → {ok} */
async function handleSaveProfile(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const session = await requireSession(request, env, body);
  if (!session) return jsonResponse({ error: 'No autorizado' }, 401, cors);

  /* account_type real del usuario (no se confía en el del body). */
  const user = await env.one2one_db.prepare('SELECT id, account_type FROM users WHERE id = ?').bind(session.userId).first();
  if (!user) return jsonResponse({ error: 'Usuario no encontrado' }, 404, cors);

  const profileObj = (body && body.profile && typeof body.profile === 'object') ? body.profile : null;
  if (!profileObj) return jsonResponse({ error: 'Perfil ausente o inválido' }, 400, cors);
  const profileJson = JSON.stringify(profileObj);
  if (profileJson.length > MAX_PROFILE_BYTES) {
    return jsonResponse({ error: 'El perfil supera el tamaño máximo permitido' }, 413, cors);
  }

  const avatarUrl = typeof (body && body.avatarUrl) === 'string' ? body.avatarUrl : null;
  const profileStatus = typeof (body && body.profileStatus) === 'string' ? body.profileStatus : null;
  const submittedAt = typeof (body && body.profileSubmittedAt) === 'string' ? body.profileSubmittedAt : null;
  const validatedAt = typeof (body && body.profileValidatedAt) === 'string' ? body.profileValidatedAt : null;
  const updatedAt = new Date().toISOString();

  const column = user.account_type === 'empresa' ? 'company_profile_json' : 'profile_json';
  await env.one2one_db.prepare(
    'UPDATE users SET ' + column + ' = ?, avatar_url = COALESCE(?, avatar_url), profile_status = COALESCE(?, profile_status), ' +
    'profile_submitted_at = COALESCE(?, profile_submitted_at), profile_validated_at = COALESCE(?, profile_validated_at), ' +
    'profile_updated_at = ? WHERE id = ?'
  ).bind(profileJson, avatarUrl, profileStatus, submittedAt, validatedAt, updatedAt, user.id).run();

  return jsonResponse({ ok: true }, 200, cors);
}

/* ─── POST /get-profile ────────────────────────────────────────────────────
   {token} → datos completos del usuario con su perfil parseado. */
async function handleGetProfile(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const session = await requireSession(request, env, body);
  if (!session) return jsonResponse({ error: 'No autorizado' }, 401, cors);

  const u = await env.one2one_db.prepare(
    'SELECT email, nombre, account_type, verified, verified_at, profile_json, company_profile_json, ' +
    'avatar_url, profile_status, profile_submitted_at, profile_validated_at, profile_updated_at ' +
    'FROM users WHERE id = ?'
  ).bind(session.userId).first();
  if (!u) return jsonResponse({ error: 'Usuario no encontrado' }, 404, cors);

  const safeParse = (s) => { if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } };

  return jsonResponse({
    ok: true,
    email: u.email,
    nombre: u.nombre || '',
    accountType: u.account_type,
    verified: u.verified === 1,
    verifiedAt: u.verified_at || null,
    profile: safeParse(u.profile_json),
    companyProfile: safeParse(u.company_profile_json),
    avatarUrl: u.avatar_url || '',
    profileStatus: u.profile_status || null,
    profileSubmittedAt: u.profile_submitted_at || null,
    profileValidatedAt: u.profile_validated_at || null,
    profileUpdatedAt: u.profile_updated_at || null
  }, 200, cors);
}

/* ─── POST /logout ─────────────────────────────────────────────────────────
   {token} → borra la sesión. Idempotente: siempre {ok:true}. */
async function handleLogout(request, env, cors) {
  if (!env.one2one_db) return jsonResponse({ error: 'Base de datos no configurada' }, 500, cors);
  const body = await request.json().catch(() => ({}));
  let token = body && typeof body.token === 'string' ? body.token : '';
  if (!token) {
    const auth = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) token = m[1].trim();
  }
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.one2one_db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
  return jsonResponse({ ok: true }, 200, cors);
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
