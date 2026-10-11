# latamacc.si

Sitio de **Latam Accelerationism (Latam/acc)**, en inglés: directorio de empresas y personas de IA que construyen la golden era de la región. El mapa de Latam se enciende en dorado y cada registro se ilumina en vivo en el mapa de todos (WebSocket).

- `server.mjs`: Node 24, sin framework. Estáticos de `public/`, `POST /api/register` (persona o empresa), `GET /api/state`, `GET /api/directory?q=&kind=&country=`, `GET /api/jobs`, `/api/me*` (miembros, ver abajo), WebSocket en `/ws` (joins, personas en línea y chispas por clic). Guarda en SQLite (`data/latamacc.db`, fuera de Git). El directorio es público (el formulario lo avisa); el correo no se expone públicamente y se transmite a Brevo para confirmaciones transaccionales cuando está configurado. `DATA_DIR` permite usar otra carpeta de datos para pruebas.
- `public/app.js`: canvas del mapa (oro, faros por registro, arcos, hover/clic), formulario y directorio con búsqueda y filtros.
- `scripts/build-map.mjs`: genera `public/assets/latam.json` desde world-atlas (`npm i` y luego `node scripts/build-map.mjs countries-50m.json`).

## Miembros: editar perfil, foto/logo y empleos

- **Acceso sin contraseña.** "Edit profile" pide el correo del registro; `POST /api/signin/link` responde igual exista o no (no revela miembros) y, si existe, encola por Brevo un enlace `https://latamacc.si/#signin=TOKEN` (un solo uso, 24 h). `POST /api/signin` lo canjea por una sesión de 30 días que el navegador guarda en `localStorage` y envía como `Authorization: Bearer`. En `member_tokens` solo se guarda el SHA-256 de cada token; el payload del correo en `email_outbox` se vacía en cuanto se envía, falla o vence. Límite: 5 pedidos de enlace por IP cada 15 min, más los límites de Brevo (3 correos por destinatario al día). Sin Brevo configurado, el panel avisa que el acceso por correo abre pronto.
- **Editar perfil** (`GET/POST /api/me`): mismos campos y validación que el registro, incluido pasar de persona a empresa (o al revés) y los países nómadas. `DELETE /api/me` elimina el perfil, sus empleos y sesiones. Los cambios se transmiten en vivo (`update`/`remove` por WebSocket).
- **Foto o logo** (`POST/DELETE /api/me/avatar`): PNG, JPG o WebP de hasta 1,5 MB (el navegador la reduce a 512 px WebP antes de subirla), validada por su firma binaria y guardada en S3 como `avatars/<id-miembro>/<uuid>.<ext>`. Se sirve por `/media/avatars/...` solo mientras esté en uso en un perfil, así que una foto quitada deja de verse aunque el usuario IAM no tenga `s3:DeleteObject` (hoy no lo tiene: los objetos reemplazados quedan huérfanos en el bucket).
- **Empleos** (`GET /api/jobs?q=&country=&workplace=&type=`, `POST /api/me/jobs`, `POST /api/me/jobs/:id/close`): los publica un miembro con sesión; título, remoto/híbrido/presencial, tipo, país (opcional si es remoto), ciudad, salario, descripción (600) y cómo aplicar (enlace o correo → `mailto:`). Máximo 10 abiertos por miembro, vencen a los 60 días. El directorio marca "Hiring · n" en los perfiles con empleos abiertos.

## Base de datos

- SQLite en `data/latamacc.db` (modo WAL, permisos 600, carpeta 700, fuera de Git).
- Respaldo automático en `data/backups/` al arrancar y cada hora si hubo registros nuevos; se guardan los últimos 72. Al apagar con Ctrl-C también respalda.
- Estado: `curl https://latamacc.si/api/health` (solo conteos).
- Exportar con correos (solo en local): `node scripts/export.mjs > builders.csv`.

## Anti-bots y merch

- Cada formulario lleva un token firmado (`ft`) que entrega `/api/state`; se rechazan envíos sin token o hechos en menos de 3 s. Además: campo trampa y límite de 20 envíos/min por IP. La clave de firma vive en `data/form-secret`.
- Turnstile queda listo: crear el widget para `latamacc.si` en Cloudflare y guardar `{"sitekey":"…","secret":"…"}` en `~/.config/latamacc/turnstile.json` (permisos 600, fuera de Git). Al reiniciar el servidor se activa solo en ambos formularios; `/api/health` muestra `turnstile: true`.
- Merch (`POST /api/merch/preorder`): Golden Era Tee ($49) y Signal Cap (precio por confirmar). Con MoonPay configurado, la camiseta abre un checkout individual; sin configuración ambos productos guardan una reserva. La gorra siempre sigue como reserva. Exportar estados y pagos con `node scripts/export-merch.mjs`.

## MoonPay Commerce

Las claves de esta integración corresponden a **MoonPay Commerce / Helio**, desde `moonpay.hel.io` → Developer → API. Habilitar API muestra Public API Key y Secret API Key una sola vez; guardarlas en `~/.config/latamacc/moonpay.json` con permisos **600**, fuera de Git:

```json
{"enabled":false,"environment":"mainnet","apiKey":"PUBLIC_KEY","apiSecret":"SECRET_KEY"}
```

`MOONPAY_FILE` permite una ruta externa distinta. El secreto nunca llega al navegador, a exports ni a respuestas de salud. La configuración sólo activa checkout cuando incluye paylink, moneda, destinatario y credencial de webhook válidos.

1. Consultar la wallet principal soportada en Settings → Wallets. Usar su **Helio wallet ID** y dirección pública completa; evitar la wallet legacy que aparece como no soportada.
2. Validar y preparar sin mutaciones: `node scripts/configure-moonpay.mjs --wallet-id ID --wallet-public-key ADDRESS`. Guarda el plan sin secretos junto al archivo privado.
3. Revisar `moonpay-plan.json` y repetir con `--apply` para crear un paylink dinámico y su webhook, guardar sus IDs/credencial y activar configuración después de verificar ambos recursos. No ejecuta pagos. Ante un resultado de creación desconocido, el script conserva `pendingOperation` y exige conciliarlo en el dashboard antes de repetir, para evitar duplicados.
4. Reiniciar el servidor. `/api/health` indica `moonpay: true`; `/api/state` indica `merchPayments.tee: true`. Las tarjetas permanecen deshabilitadas salvo `canPayWithCard:true` y ramps habilitadas en la cuenta.

El servidor calcula $49 × cantidad entera de 1 a 10 y guarda el total en unidades mínimas: **USD tiene 6 decimales en Helio**, $49 = `49000000`. La creación del paylink usa esas unidades mínimas en `price`; **la creación del charge usa unidades mayores en `requestAmount`**, por ejemplo `"98"` para dos camisetas. El proveedor devuelve `pricingCurrencyRequestAmount` en unidades mínimas (`"98000000"`), que se compara con el importe original guardado. La conversión usa enteros y texto, sin redondeos de coma flotante. Cada charge vence en 30 minutos y usa cantidad 1 porque su importe ya representa el total del pedido. La wallet recibe USDC en Solana, elegida explícitamente en configuración.

Antes de entregar la URL al comprador, el servidor consulta el charge recién creado y verifica importe, moneda, IDs, estado sin pagar y destinatario exacto. También exige paylink activo y dinámico, con precio y cantidad bloqueados. Un cambio de wallet o una respuesta inesperada bloquea el checkout e intenta expirar el charge; nunca entrega una URL sin verificar.

`GET /api/merch/status?token=CAPABILITY` devuelve estado/producto/talla/cantidad/total sin datos personales. Se comprueban token, ID de charge, paylink, importe bruto original (`pricingCurrencyRequestAmount`), moneda y destinatario en una consulta directa al proveedor. El importe neto de la transacción puede excluir comisiones. `POST /api/moonpay/webhook` verifica Bearer y HMAC-SHA256 sobre el cuerpo original y dispara la misma conciliación; redirects/callbacks del navegador nunca confirman pagos. Las transacciones se guardan con índice único para impedir reutilizarlas en otro pedido.

Pruebas aisladas: `node --test tests/*.test.mjs`. No usan claves reales, red del proveedor ni la base activa. Documentación oficial: [inicio API](https://docs.hel.io/reference/getting-started), [charges](https://docs.hel.io/reference/charge/create), [consulta de charge](https://docs.hel.io/reference/charge/retrieve), [firmas de webhook](https://docs.hel.io/docs/webhooks).

## Archivos en Amazon S3

El backend dispone de `S3Storage` en `lib/storage.mjs` para guardar y leer objetos del bucket privado `latamacc` en `us-east-1`. Las credenciales viven en `~/.config/latamacc/s3.json`, fuera de Git, con permisos **600** (carpeta 700):

```json
{"AWS_ACCESS_KEY_ID":"ACCESS_KEY","AWS_SECRET_ACCESS_KEY":"SECRET_KEY","AWS_REGION":"us-east-1","AWS_S3_BUCKET":"latamacc","AWS_ACCOUNT_ID":"ACCOUNT_ID_12_DIGITS","AWS_IAM_USER":"LatamaccApp"}
```

`S3_CONFIG_FILE` permite otra ruta privada. También se aceptan esas variables de entorno, con prioridad sobre el archivo, y `AWS_SESSION_TOKEN` para credenciales temporales. Las llamadas comprueban el propietario esperado (`AWS_ACCOUNT_ID`). Las subidas solicitan cifrado AES256, no asignan ACL pública y rechazan sobrescribir objetos existentes por defecto. La privacidad efectiva depende también de las políticas del bucket. El SDK oficial aplica firma y transporte HTTPS; las claves nunca se envían al navegador.

Comandos de administración desde el servidor:

```sh
node scripts/storage.mjs check
node scripts/storage.mjs probe
node scripts/storage.mjs put /ruta/archivo.pdf documentos/archivo.pdf application/pdf
node scripts/storage.mjs get documentos/archivo.pdf /ruta/nueva-copia.pdf
```

`check` consulta acceso al bucket; `probe` sube un texto sintético, comprueba lectura/cifrado y elimina únicamente ese objeto de prueba. Si falta permiso de borrado, devuelve código 1, `cleanedUp: false` y la clave sintética que quedó pendiente, aunque lectura y escritura hayan funcionado. La herramienta no sobrescribe archivos locales al descargar. Requiere `s3:ListBucket` para `check`, `s3:PutObject`/`s3:GetObject` para almacenar y leer, y `s3:DeleteObject` (o `s3:DeleteObjectVersion` con versionado) para limpiar la prueba.

Después de configurar, reiniciar `latamacc-web`. `/api/health` sólo expone `s3: true/false`: indica configuración cargada, no una comprobación continua de conectividad. Sin configuración, el sitio sigue funcionando. No hay un endpoint público de subida ni migración automática de SQLite o sus respaldos; los flujos futuros pueden usar el módulo desde el backend. Pruebas aisladas: `node --test tests/storage.test.mjs`. Referencia: [AWS SDK para S3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html).

## Correo transaccional con Brevo

`lib/email.mjs` envía por HTTPS a `https://api.brevo.com/v3/smtp/email`. Guardar la clave dedicada de LATAMACC en `~/.config/latamacc/brevo.json`, fuera de Git, con permisos **600** (carpeta 700):

```json
{"apiKey":"BREVO_API_KEY","fromEmail":"danny@latamacc.si","fromName":"LATAMACC","replyToEmail":"danny@latamacc.si","minIntervalMs":2000,"maxPerHour":20,"maxPerDay":100,"maxPerRecipientPerDay":3}
```

`BREVO_CONFIG_FILE` permite otra ruta privada. `BREVO_ENABLED=0` desactiva lectura de credenciales, cola y envíos; debe usarse en pruebas ajenas a correo. Sin archivo o con `enabled:false`, el sitio funciona sin correo. Configuraciones inválidas se desactivan con un error genérico. Los valores predeterminados de remitente y respuesta son `danny@latamacc.si`, el buzón verificado inicial; cambiar ambos cuando el nuevo buzón de César esté verificado. No se utilizan remitentes de Xertify. `/api/health` expone únicamente `email: true/false` (configuración cargada, no garantía de entrega).

Sólo se encolan registros **nuevos**, reservas sin cobro y pagos verificados. No se recorren registros históricos ni se crean contactos o campañas. Un checkout pendiente no genera confirmación de pago. `email_outbox` conserva el evento único `tipo:id`, contenido y estado en SQLite. Cuando el correo está activo, el registro, reserva o cambio a pagado y su evento se guardan en la misma transacción: si falla la escritura de la cola, se revierte esa operación. Los envíos se procesan de forma serial después de confirmar la transacción, sin llamadas de red dentro de ella. Si Brevo falla, el alta o pedido sigue guardado. Al desactivar correo, los nuevos eventos no se encolan; los pendientes anteriores se conservan hasta reactivarlo.

Los límites predeterminados son 20 intentos/hora y 100/24 horas, separados por al menos 2 segundos, con un máximo de 3 intentos por destinatario/24 horas. Se conservan entre reinicios; el historial de intentos de más de 24 horas se elimina al arrancar y procesar la cola. Sólo los errores 429 permiten hasta 4 intentos en total, con espera exponencial de al menos un minuto y respetando `Retry-After` hasta 24 horas. Los demás errores 4xx quedan como `failed`. Timeouts, errores 5xx (que pueden ocurrir tras aceptar el mensaje), respuestas ambiguas y envíos interrumpidos por un reinicio quedan como `unknown`, sin reenvío automático: primero conciliar su entrega en Brevo. Los pendientes expiran a las 48 horas (`maxAgeMs` configurable) para no enviar confirmaciones antiguas. `sent` significa que Brevo aceptó el mensaje, no que llegó al buzón. No se confía en una ventana temporal del proveedor para deduplicar.

La aplicación genera HTML sencillo y texto equivalente, sin imágenes, promociones, enlaces externos o contenido de perfil del usuario. Los destinatarios llevan `contactPixelTrackingConsent:false`. Activar en Brevo el consentimiento de píxel por contacto para que se aplique el campo y dejar desactivado el seguimiento para consentimiento desconocido. Según la [aclaración oficial del 21 de julio de 2026](https://developers.brevo.com/changelog/2026/7/21), `false` anonimiza las aperturas y conserva estadísticas agregadas; si la función no está habilitada en la cuenta, se ignora el campo. Esto no garantiza un mensaje sin píxel ni enlaces reescritos. La opción transaccional **Anonymous email tracking** también anonimiza aperturas y clics; no elimina el seguimiento. No hay webhook público nuevo ni importación de contactos.

Verificación real del **2026-10-11**: tanto una prueba con HTML y texto como otra enviada únicamente con `textContent` llegaron a Gmail con etiqueta `INBOX` y categoría `UPDATES`, y SPF, DKIM y DMARC correctos. En ambos casos, el MIME recibido contenía HTML con un píxel añadido por Brevo y enlaces reescritos mediante `sendibt3.com/tr/cl`. Por tanto, enviar sólo texto plano tampoco eliminó el seguimiento en esta cuenta. Se activó **Anonymous email tracking** en la configuración transaccional; no se ha demostrado eliminación del píxel ni de la reescritura. Comprobar siempre el MIME recibido para evaluar el contenido final del proveedor; la categoría Principal no está garantizada.

La integración se activó el **2026-10-11**: `/api/health` devolvió `email:true`. Se solicitó un enlace desde **Edit profile**, se confirmó su recepción en el buzón del propietario y se abrió el panel autenticado con ese enlace; la cola registró un intento aceptado y vació su payload. No se modificaron los datos del perfil.

Administración local: `node scripts/email.mjs check` consulta cuenta, dominio y remitentes sin enviar mensajes. `node scripts/email.mjs probe --to destinatario@example.com` envía una prueba sintética al destinatario explícito, sin crear registros ni pedidos; comprobar después el correo recibido. La aceptación de la API no demuestra entrega en inbox.

Pruebas aisladas: `BREVO_ENABLED=0 node --test tests/*.test.mjs`. Los tests de correo usan claves ficticias, transporte simulado y SQLite temporal, sin contactar Brevo. Después de configurar y validar, reiniciar `latamacc-web` para cargar la clave. Documentación: [envío transaccional](https://developers.brevo.com/reference/send-transac-email), [consentimiento para píxeles](https://help.brevo.com/hc/en-us/articles/37114679474706-About-email-tracking-pixels-and-the-CNIL-recommendation-in-Brevo).

## Correr

```sh
npm install
node server.mjs            # http://127.0.0.1:8790
```

## Publicación actual (GPU)

- Túnel Cloudflare `latamacc` (id `2881a381-9213-4a60-980f-e15afd766788`, config remota): `latamacc.si` y `www.latamacc.si` → `http://127.0.0.1:8790`. DNS: CNAME proxied `latamacc.si` y `www` → `<id>.cfargotunnel.com`.
- Corren como servicios systemd de usuario (linger activo: arrancan con la máquina y se reinician solos si fallan):
  - `latamacc-web.service`: `node server.mjs` en esta carpeta.
  - `latamacc-tunnel.service`: `cloudflared tunnel run --token-file ~/.local/state/cloudflare-agent/latamacc-tunnel.token`.
- Después de cambiar código del servidor: `systemctl --user restart latamacc-web` (SIGTERM respalda la base antes de salir). Estado y logs: `systemctl --user status latamacc-web latamacc-tunnel`, `journalctl --user -u latamacc-web -f`.
- No lanzar otro `node server.mjs` en el 8790 ni otro conector a mano: chocan con los servicios.

`wrangler.jsonc` queda de la v1 estática y no se usa con el servidor actual.
