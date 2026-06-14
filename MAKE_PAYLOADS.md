# Contrato de payloads → Make · One2One Pro

Referencia de **todos los datos que la web envía a Make** (webhooks), para configurar los escenarios sin leer el código. Última actualización: cambios de profesión (desplegable), recinto obligatorio y concepto de pro-forma compuesto.

> ⚠️ **Novedades de esta versión** (revísalas si ya tenías escenarios montados):
> - **`concepto_proforma`** (NUEVO, en expediente profesional y empresa): texto ya compuesto para la pro-forma → `Profesión · Recinto (Nº expediente)`. Úsalo directamente como concepto de la pro-forma.
> - **`profesion`** (expediente profesional) / **`profesion_trabajador`** (expediente empresa): profesión del profesional, ahora elegida de un desplegable.
> - **`concepto_actuacion`** (expediente **empresa**): **ha cambiado de significado** — antes era el concepto de actividad de una lista; **ahora lleva la profesión del trabajador**. Si tu plantilla lo usaba como concepto, usa mejor `concepto_proforma`.
> - **`lugar_celebracion`** (= recinto/sala): ahora es **obligatorio** en ambos flujos (siempre llega relleno).

---

## Webhooks (2 URLs)

| Constante | URL | Lo usan |
|---|---|---|
| **AUTH_WEBHOOK** | `https://hook.eu1.make.com/azu072mdlkvxarr98xp9flffxd5gipa3` | Email de verificación, reset de contraseña, envío de perfil del profesional, actualización de perfil |
| **EMPRESA_WEBHOOK** | `https://hook.eu1.make.com/9h9rjffs4t6tl2yw789d0cnihf8mqjku` | Expediente profesional (A/B), expediente empresa (C), confirmación del promotor, contacto |

**Enrutado:** salvo el *envío de perfil* (que no lleva `tipo`), todos los payloads incluyen un campo **`tipo`** (o `flujo`) para ramificar el escenario. Las cuentas (registro/login/verificación) se crean/validan en el **Cloudflare Worker (D1)**; Make solo **envía los emails** con el `token` que le pasa la web.

---

## 1) Email de verificación — `AUTH_WEBHOOK`
Se dispara tras registrar (o al pulsar "reenviar"). El Worker ya creó la cuenta y devolvió el token; Make solo manda el correo.

| Campo | Descripción |
|---|---|
| `tipo` | `"verificacion_email"` |
| `email` | Email del usuario (minúsculas) |
| `nombre` | Nombre del usuario |
| `token` | Token de verificación (64 hex). **El enlace del email debe ser** `https://one2onepro.es/?verify=` + `token` |

## 2) Reset de contraseña — `AUTH_WEBHOOK`
| Campo | Descripción |
|---|---|
| `tipo` | `"recuperar_password"` |
| `email` | Email del usuario |
| `nombre` | Nombre (puede venir vacío) |
| `token` | Token de reset (64 hex, caduca 1 h). **Enlace:** `https://one2onepro.es/?reset=` + `token` |

## 3) Envío de perfil del profesional — `AUTH_WEBHOOK`  *(sin `tipo`)*
Se envía cuando un profesional completa/valida su perfil. **No lleva `tipo`**; se identifica por la presencia de estos campos. Las fotos del DNI ya están subidas a Cloudinary (viajan como URL).

| Campo | Descripción |
|---|---|
| `email` | Email (cuenta del profesional) |
| `nombre`, `apellidos` | Nombre y apellidos |
| `telefono` | Teléfono |
| `fechaNacimiento` | YYYY-MM-DD |
| `sexo` | `M` / `F` / `X` |
| `nacionalidad` | Texto |
| `tipoDocumento` | `DNI` / `NIE` |
| `numeroDocumento` | Nº de documento |
| `fechaCaducidadDocumento` | YYYY-MM-DD |
| `tipoVia`, `calle`, `numero`, `pisoPuerta` | Dirección desglosada |
| `codigoPostal`, `municipio`, `provincia`, `pais` | Resto de dirección |
| `iban` | IBAN |
| `naf` | Nº afiliación SS (opcional) |
| `profesionArtistica` | **Profesión** (elegida del desplegable o escrita a mano) |
| `primera_afiliacion` | Booleano (primera vez cotizando — aviso de la cuota de 30€ de la SS) |
| `primeraAltaHecha` | **NUEVO** — Booleano. `true` cuando el profesional ya ha completado su **primer expediente**; entonces la casilla de "primera vez cotizando" deja de mostrarse y `primera_afiliacion` deja de marcarse. En el **alta inicial** del perfil es siempre `false`/ausente (aún no hay expedientes); el flag se activa después y persiste en D1 (viaja dentro del objeto `profile` en `actualizar_perfil`). |
| `dniAnversoURL`, `dniReversoURL` | URLs de Cloudinary del DNI |
| `validacionIA` | Objeto con el resultado de la validación IA del DNI (o `null`) |
| `submittedAt` | Timestamp ISO |

## 4) Actualización de perfil — `AUTH_WEBHOOK`
Se envía al guardar cambios en el editor de perfil. *(El escenario puede ignorarlo si no hay rama para este tipo.)*

| Campo | Descripción |
|---|---|
| `tipo` | `"actualizar_perfil"` |
| `email` | Email del usuario |
| `accountType` | `artista` (profesional) / `empresa` |
| `avatarUrl` | URL del avatar (Cloudinary) o vacío |
| `profile` | Objeto perfil del profesional o `null`. Incluye, entre otros, `profesion`, `primera_afiliacion` y **`primeraAltaHecha`** (booleano: `true` si el profesional ya hizo su primer expediente → no se vuelve a mostrar/cobrar la primera alta) |
| `companyProfile` | Objeto perfil fiscal de empresa o `null` |
| `updatedAt` | Timestamp ISO |

---

## 5) Expediente PROFESIONAL (flujos A y B) — `EMPRESA_WEBHOOK`
Lo crea el profesional. **Flujo A** = el profesional tiene los datos del promotor (van rellenos). **Flujo B** = solo el email del promotor. Nace en estado **`Pendiente datos promotor`**; pasa a `Promotor confirmado` cuando el promotor acepta (ver payload 7).

| Campo | Descripción |
|---|---|
| `tipo` | `"expediente_profesional"` |
| `flujo` | `"A"` (con datos promotor) / `"B"` (solo email) |
| `expediente` | Nº de expediente (`O2O-XXXXX`, generado en la web) |
| `estado_inicial` | `"Pendiente datos promotor"` |
| `fecha_solicitud` | Fecha (dd/mm/aaaa) |
| `actividad` | Tipo de actividad (etiqueta) |
| `regimen` | Régimen (`artistas`) |
| `ubicacion` | Interior / exterior / mixto |
| `dias` | Nº de días |
| `fecha_inicio`, `fecha_fin` | YYYY-MM-DD |
| `lugar_celebracion` | **Recinto / sala (obligatorio)** |
| `profesion` | **NUEVO** — profesión del profesional (de su perfil) |
| `concepto_proforma` | **NUEVO** — concepto compuesto: `Profesión · Recinto (Nº exp)`. Úsalo como concepto de la pro-forma |
| `cache_acordado` | Caché acordado (€) |
| `seguridad_social` | Cuota SS estimada |
| `comision_one2one` | Comisión 10% |
| `neto_artista` | Neto estimado del profesional |
| `base_imponible` | Base imponible (= caché) |
| `iva` | IVA (21%) |
| `total_factura` | Total que paga el promotor (IVA incl.) |
| `trabajador_usuario_email` | Email de la cuenta del profesional |
| `trabajador_email` | Email del profesional |
| `trabajador_nombre`, `trabajador_apellidos` | Nombre/apellidos |
| `trabajador_dni` | DNI/NIE |
| `trabajador_fecha_nacimiento` | YYYY-MM-DD |
| `trabajador_nacionalidad` | Nacionalidad |
| `trabajador_direccion` | Dirección (texto compuesto desde el perfil) |
| `trabajador_iban` | IBAN (sin espacios, mayúsculas) |
| `trabajador_naf` | Nº afiliación SS (opcional) |
| `trabajador_telefono` | Teléfono |
| `promotor_email` | Email del promotor (siempre) |
| `promotor_razon_social` | Solo flujo A (vacío en B) |
| `promotor_cif` | Solo flujo A |
| `promotor_telefono` | Solo flujo A |
| `promotor_direccion` | Solo flujo A |
| `iban_cobro` | IBAN de cobro de ONE2ONE SOLUTIONS S.L. |
| `enlace_aceptacion` | URL única `promotor.html?token=...` que recibe el promotor |

> En **flujo B** los campos `promotor_*` (salvo email) llegan vacíos: los completa el promotor en la página de aceptación (payload 7).

## 6) Expediente EMPRESA (flujo C) — `EMPRESA_WEBHOOK`
La empresa es el promotor y acepta el compromiso de pago en el propio formulario. Nace directamente en **`Promotor confirmado`** (dispara Docuseal al profesional).

| Campo | Descripción |
|---|---|
| `tipo` | `"expediente_empresa"` |
| `flujo` | `"C"` |
| `estado_inicial` | `"Promotor confirmado"` |
| `expediente` | Nº de expediente (`O2O-XXXXX`) |
| `fecha_solicitud` | Fecha (dd/mm/aaaa) |
| `actividad`, `regimen`, `ubicacion` | Actividad/régimen/ubicación |
| `dias`, `fecha_inicio`, `fecha_fin` | Días y fechas |
| `lugar_celebracion` | **Recinto / sala (obligatorio)** |
| `descripcion_evento` | Descripción libre (opcional) |
| `profesion_trabajador` | **NUEVO** — profesión del profesional contratado (desplegable) |
| `concepto_actuacion` | **CAMBIADO** — ahora lleva **la profesión** (antes: concepto de la lista). Para el concepto de la pro-forma usa `concepto_proforma` |
| `concepto_proforma` | **NUEVO** — `Profesión · Recinto (Nº exp)` |
| `cache_acordado`, `seguridad_social`, `comision_one2one`, `neto_artista`, `base_imponible`, `iva`, `total_factura` | Importes (igual que en el profesional) |
| `iban_cobro` | IBAN de cobro de ONE2ONE SOLUTIONS S.L. |
| `condiciones_aceptadas` | `true` |
| `compromiso_pago_aceptado` | `true` (paga en ≤ `plazo_pago_dias`) |
| `plazo_pago_dias` | Plazo de pago (días, p. ej. 7) |
| `aceptacion_nombre` | Nombre de quien acepta (contacto de la empresa) |
| `aceptacion_email` | Email de facturación de la empresa |
| `aceptacion_ip` | IP del que acepta |
| `aceptacion_timestamp` | Timestamp ISO de la aceptación |
| `empresa_email` | Email de facturación |
| `empresa_razon_social` | Razón social |
| `empresa_cif` | CIF/DNI/NIE |
| `empresa_direccion` | Dirección fiscal (texto compuesto) |
| `empresa_pais` | País |
| `empresa_telefono` | Teléfono |
| `empresa_contacto` | Persona de contacto |
| `empresa_usuario_email` | Email de la cuenta empresa |
| `modo_datos_trabajador` | `"manual"` |
| `trabajador_email`, `trabajador_nombre`, `trabajador_apellidos` | Datos del profesional contratado |
| `trabajador_dni`, `trabajador_fecha_nacimiento`, `trabajador_nacionalidad` | — |
| `trabajador_calle`, `trabajador_cp`, `trabajador_municipio`, `trabajador_provincia` | Dirección del profesional |
| `trabajador_naf` | Nº afiliación SS (opcional) |
| `trabajador_iban` | IBAN (sin espacios, mayúsculas) |
| `trabajador_telefono` | Teléfono |
| `trabajador_dniAnversoURL`, `trabajador_dniReversoURL` | URLs Cloudinary del DNI del profesional |
| `trabajador_validacionIA` | Resultado de la validación IA del DNI (o `null`) |

## 7) Confirmación del promotor — `EMPRESA_WEBHOOK`  *(desde `promotor.html`)*
Lo envía el promotor al aceptar en la página pública (flujos A y B). Make debe **actualizar el expediente a `Promotor confirmado`**, guardar la aceptación, **disparar Docuseal** al profesional y avisar a administración.

| Campo | Descripción |
|---|---|
| `tipo` | `"promotor_confirma"` |
| `expediente` | Nº de expediente al que pertenece (token de la URL) |
| `flujo` | `"A"` / `"B"` |
| `estado_nuevo` | `"Promotor confirmado"` |
| `promotor_razon_social` | Nombre o razón social del promotor |
| `promotor_cif` | NIF/CIF |
| `promotor_telefono` | Teléfono |
| `promotor_email` | Email |
| `promotor_direccion` | Dirección fiscal |
| `condiciones_aceptadas` | `true` |
| `compromiso_pago_aceptado` | `true` |
| `plazo_pago_dias` | Plazo de pago (días) |
| `iban_cobro` | IBAN de cobro de ONE2ONE SOLUTIONS S.L. |
| `aceptacion_nombre` | Nombre de quien acepta |
| `aceptacion_email` | Email de quien acepta |
| `aceptacion_ip` | IP |
| `aceptacion_timestamp` | Timestamp ISO |
| `importe_total` | Importe total (IVA incl.) si viajaba en el enlace |

## 8) Contacto — `EMPRESA_WEBHOOK`
Formulario de contacto de la web.

| Campo | Descripción |
|---|---|
| `tipo` | `"contacto"` |
| `nombre` | Nombre |
| `email` | Email |
| `asunto` | Asunto seleccionado |
| `mensaje` | Mensaje |

---

## Estados del expediente (Airtable) y colores en la web
`Pendiente datos promotor` (naranja) → `Promotor confirmado` (azul) → `Contrato enviado` (índigo) → `Pendiente de firma` (amarillo) → `Firmado` (verde) → `Alta tramitada` (verde oscuro) → `Pendiente de pago` (naranja) → `Pago recibido` (verde brillante) → `Baja tramitada` (gris).

## Pago
El promotor paga por **transferencia bancaria** al IBAN de ONE2ONE SOLUTIONS S.L. (campo `iban_cobro`). Ya **no hay Stripe**. La pro-forma se genera con los datos del expediente + `concepto_proforma` + el IBAN.
