# latamacc.si

Sitio de **Latam Accelerationism (Latam/acc)**, en inglés: directorio de empresas y personas de IA que construyen la golden era de la región. El mapa de Latam se enciende en dorado y cada registro se ilumina en vivo en el mapa de todos (WebSocket).

- `server.mjs`: Node 24, sin framework. Estáticos de `public/`, `POST /api/register` (persona o empresa), `GET /api/state`, `GET /api/directory?q=&kind=&country=`, WebSocket en `/ws` (joins, personas en línea y chispas por clic). Guarda en SQLite (`data/latamacc.db`, fuera de Git). El directorio es público (el formulario lo avisa); el correo nunca sale del servidor. `DATA_DIR` permite usar otra carpeta de datos para pruebas.
- `public/app.js`: canvas del mapa (oro, faros por registro, arcos, hover/clic), formulario y directorio con búsqueda y filtros.
- `scripts/build-map.mjs`: genera `public/assets/latam.json` desde world-atlas (`npm i` y luego `node scripts/build-map.mjs countries-50m.json`).

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
