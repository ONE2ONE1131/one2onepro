-- One2One Pro · Esquema de la base de datos D1 (one2one-db)
-- Sistema de autenticación real: cuentas de usuario con contraseña hasheada,
-- verificación de email y recuperación de contraseña.
--
-- Cargar con (NO se ejecuta en este paso):
--   wrangler d1 execute one2one-db --remote --file=./schema.sql
--
-- Nota de seguridad: password_hash guarda SIEMPRE un hash (p. ej. PBKDF2 vía
-- Web Crypto en el Worker), NUNCA la contraseña en claro.

CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Email normalizado a minúsculas (CHECK lo fuerza a nivel de BD).
  email                 TEXT    NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash         TEXT    NOT NULL,
  account_type          TEXT    NOT NULL CHECK (account_type IN ('artista', 'empresa')),
  nombre                TEXT,
  verified              INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  verify_token          TEXT,
  verify_token_expires  INTEGER,
  reset_token           TEXT,
  reset_token_expires   INTEGER,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at           TEXT
);

-- La columna `email UNIQUE` ya crea automáticamente un índice único sobre email
-- (lo usa el login y el alta para evitar cuentas duplicadas).

-- Índices para buscar rápido por token al verificar email / restablecer contraseña.
CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users (verify_token);
CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users (reset_token);
