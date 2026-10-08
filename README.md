# latamacc.si

Sitio de **Latam Accelerationism (Latam/acc)**: mapa de Latam que se enciende en fuego, el post de @cesarsuarezpab y registro de builders que se encienden en vivo en el mapa de todos (WebSocket).

- `server.mjs`: Node 24, sin framework. Estáticos de `public/`, `POST /api/register`, `GET /api/state`, WebSocket en `/ws` (joins, personas en línea y chispas por clic). Guarda en SQLite (`data/latamacc.db`, fuera de Git). Solo publica nombre + inicial, ciudad, país y proyecto; el correo nunca sale del servidor.
- `public/app.js`: canvas del mapa (fuego, brasas, faros por registro, hover/clic), tweet animado y formulario.
- `scripts/build-map.mjs`: genera `public/assets/latam.json` desde world-atlas (`npm i` y luego `node scripts/build-map.mjs countries-50m.json`).

## Base de datos

- SQLite en `data/latamacc.db` (modo WAL, permisos 600, carpeta 700, fuera de Git).
- Respaldo automático en `data/backups/` al arrancar y cada hora si hubo registros nuevos; se guardan los últimos 72. Al apagar con Ctrl-C también respalda.
- Estado: `curl https://latamacc.si/api/health` (solo conteos).
- Exportar con correos (solo en local): `node scripts/export.mjs > builders.csv`.

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
