-- One2One Pro · Tabla de sesiones (tokens de sesión server-side)
--
-- La identidad de cada petición autenticada (/save-profile, /get-profile, ...)
-- se deriva del token de sesión, NO del email del body. Así un usuario solo
-- puede leer/escribir SU propio perfil (el token mapea a un user_id concreto).
--
-- token_hash = SHA-256 del token en claro. El token en claro NUNCA se guarda:
-- se entrega una sola vez al frontend en /login y /verify. Si la BD se filtrara,
-- no se expondrían tokens vivos.
--
-- Aplicar:
--   /opt/homebrew/bin/wrangler d1 execute one2one-db --remote --file=schema_sessions.sql

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,   -- SHA-256 (hex) del token de sesión
  created_at  TEXT    NOT NULL,          -- timestamp ISO de creación
  expires_at  INTEGER NOT NULL           -- caducidad en epoch ms (Date.now())
);

-- Búsqueda rápida por token al validar cada petición autenticada.
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);

-- Búsqueda por usuario (p. ej. cerrar todas las sesiones de un usuario).
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
