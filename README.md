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
3. Revisar `moonpay-plan.json` y repetir con `--apply` para crear un paylink dinámico y su webhook, guardar sus IDs/credencial y activar configuración. No ejecuta pagos. Ante un resultado de creación desconocido, el script conserva `pendingOperation` y exige conciliarlo en el dashboard antes de repetir, para evitar duplicados.
4. Reiniciar el servidor. `/api/health` indica `moonpay: true`; `/api/state` indica `merchPayments.tee: true`. Las tarjetas permanecen deshabilitadas salvo `canPayWithCard:true` y ramps habilitadas en la cuenta.

El servidor calcula $49 × cantidad entera de 1 a 10 y crea un charge con el total en unidades mínimas: **USD tiene 6 decimales en Helio**, $49 = `49000000`. Cada charge vence en 30 minutos y usa cantidad 1 porque su importe ya representa el total del pedido. La wallet recibe USDC en Solana, elegida explícitamente en configuración.

`GET /api/merch/status?token=CAPABILITY` devuelve estado/producto/talla/cantidad/total sin datos personales. Se comprueban token, ID de charge, paylink, importe bruto original (`pricingCurrencyRequestAmount`), moneda y destinatario en una consulta directa al proveedor. El importe neto de la transacción puede excluir comisiones. `POST /api/moonpay/webhook` verifica Bearer y HMAC-SHA256 sobre el cuerpo original y dispara la misma conciliación; redirects/callbacks del navegador nunca confirman pagos. Las transacciones se guardan con índice único para impedir reutilizarlas en otro pedido.

Pruebas aisladas: `node --test tests/*.test.mjs`. No usan claves reales, red del proveedor ni la base activa. Documentación oficial: [inicio API](https://docs.hel.io/reference/getting-started), [charges](https://docs.hel.io/reference/charge/create), [consulta de charge](https://docs.hel.io/reference/charge/retrieve), [firmas de webhook](https://docs.hel.io/docs/webhooks).

## Correr

```sh
npm install
node server.mjs            # http://127.0.0.1:8790
```

## Publicación actual (prueba desde la GPU)

- Túnel Cloudflare `latamacc` (id `2881a381-9213-4a60-980f-e15afd766788`, config remota): `latamacc.si` y `www.latamacc.si` → `http://127.0.0.1:8790`.
- DNS: CNAME proxied `latamacc.si` y `www` → `<id>.cfargotunnel.com`.
- Conector: `cloudflared tunnel --no-autoupdate run --token-file ~/.local/state/cloudflare-agent/latamacc-tunnel.token`.
- El servidor y el conector corren en pestañas de terminal; no son servicios persistentes y no sobreviven un reinicio.

`wrangler.jsonc` queda de la v1 estática y no se usa con el servidor actual.
