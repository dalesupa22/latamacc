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
- Preventa de merch (`POST /api/merch/preorder`): Golden Era Tee ($49) y Signal Cap (precio por confirmar). No se cobra; se exporta con `node scripts/export-merch.mjs`.

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
