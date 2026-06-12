-- One2One Pro · Ampliación de la tabla `users` para guardar el perfil en D1
-- (Fase 2: el perfil del usuario pasa a vivir en el servidor, no en localStorage)
--
-- El perfil es ligero (texto + URLs; las imágenes del DNI/avatar ya viven en
-- Cloudinary), por eso se guarda serializado en columnas JSON dentro de `users`
-- en lugar de crear tablas nuevas.
--
-- Todas las columnas son NULLABLE: las filas de usuarios ya existentes siguen
-- siendo válidas sin migración de datos. SQLite/D1 permite añadir columnas en
-- caliente y sin bloqueo.
--
-- Aplicar (NO se ejecuta hasta luz verde):
--   /opt/homebrew/bin/wrangler d1 execute one2one-db --remote --file=schema_profile.sql

ALTER TABLE users ADD COLUMN profile_json          TEXT;
ALTER TABLE users ADD COLUMN company_profile_json  TEXT;
ALTER TABLE users ADD COLUMN avatar_url            TEXT;
ALTER TABLE users ADD COLUMN profile_status        TEXT;
ALTER TABLE users ADD COLUMN profile_submitted_at  TEXT;
ALTER TABLE users ADD COLUMN profile_validated_at  TEXT;
ALTER TABLE users ADD COLUMN profile_updated_at    TEXT;
