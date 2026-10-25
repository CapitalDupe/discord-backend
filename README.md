# discord-backend

REST + WebSocket backend for [CapitalDupe/discord](https://github.com/CapitalDupe/discord). One Node file (`server.js`), two dependencies.

- `GET /api/state`: full state (needs `Authorization: Bearer <ACCESS_TOKEN>`)
- `wss://host/ws?token=<ACCESS_TOKEN>`: realtime events (`msg.new`, `msg.edit`, `msg.del`, `msg.react`, `srv.new/del`, `ch.new/del`, `user.set`)
- `GET /healthz`

The server validates every event, stamps messages with the server user and time, saves them, and broadcasts to your other devices.

## Deploy free on Render

1. Create a free Postgres database at [neon.tech](https://neon.tech) and copy its connection string. Free hosts wipe local files on restart, so without this your messages will vanish.
2. On [render.com](https://render.com): **New → Blueprint**, pick this repo. It reads `render.yaml` and generates an `ACCESS_TOKEN` for you.
3. Paste the Postgres string into the `DATABASE_URL` env var.
4. After it deploys, copy the service URL (e.g. `https://discord-backend-xxxx.onrender.com`) and the `ACCESS_TOKEN` from the Render dashboard.
5. Open your frontend once with:

```
https://capitaldupe.github.io/discord/?backend=https://YOUR-SERVICE.onrender.com&token=YOUR_ACCESS_TOKEN
```

The frontend saves both in that browser and removes them from the address bar. Repeat on each device. Use `?backend=local` to switch back to browser-only mode.

Render's free tier sleeps after ~15 min idle, so the first load afterwards takes about a minute.

## Run locally

```bash
npm install
ACCESS_TOKEN=secret npm start   # data saved in ./data/state.json
```

Then open the frontend with `?backend=http://localhost:3000&token=secret`. Browsers allow an https page to call `localhost`, but not other http hosts.

## Environment variables

| name | purpose |
|---|---|
| `ACCESS_TOKEN` | shared secret; unset = open to anyone |
| `ALLOWED_ORIGIN` | the frontend origin (CORS and WebSocket check); default `*` |
| `DATABASE_URL` | Postgres for persistence; otherwise a JSON file in `DATA_DIR` |
| `PORT` | default 3000 |

## Limits

There are no accounts by design: anyone holding the token acts as the same single user ("You"), so this syncs your own devices rather than hosting a multi-person server. Voice channels are UI only.
