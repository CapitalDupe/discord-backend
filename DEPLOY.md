# Deploy on your own VPS (Docker + Caddy + Neon)

Stack: frontend on GitHub Pages -> `https://pondered.duckdns.org` (Caddy, port 443 only) -> backend container (internal port 3000) -> Neon Postgres.
Other apps on the VPS (including whatever uses port 80) are untouched. Only host port **443** (TCP+UDP) is used.

## 1. Prerequisites
- DNS: `pondered.duckdns.org` A record -> your VPS IP.
- Firewall: allow inbound **443/tcp** (and 443/udp for HTTP/3) in `ufw` *and* your provider's firewall panel.
- Docker + Compose plugin installed.
- Neon: the schema in `schema.sql` is already applied to the `production` branch; the server also re-applies it (idempotently) on every start.

## 2. Configure
```bash
git clone https://github.com/CapitalDupe/discord-backend.git
cd discord-backend
cp .env.example .env
nano .env   # set DATABASE_URL (from Neon console -> Connect) and SIGNUP_CODE
chmod 600 .env
```
Generate a signup code: `openssl rand -hex 12`.

## 3. Run
```bash
docker compose up -d --build
docker compose logs -f   # wait for "Listening on :3000" and a certificate being obtained
curl https://pondered.duckdns.org/api/healthz   # -> ok
```

## 4. Open the frontend
```
https://capitaldupe.github.io/discord/?backend=https://pondered.duckdns.org
```
Choose Create account and enter your signup code. The backend URL is remembered in that browser.

## Updating
```bash
git pull && docker compose up -d --build
```

## Troubleshooting
- **Certificate not issued:** confirm 443 is reachable from the internet and the DuckDNS record points at this VPS. This setup never uses port 80.
- **CORS / WebSocket 403:** `ALLOWED_ORIGIN` must be exactly `https://capitaldupe.github.io`.
- **Neon connection errors:** keep `sslmode=require`; the free plan suspends idle compute, so the first request after a pause can take a moment.
- **Rate limits / client IPs:** `TRUST_PROXY=1` is set in compose because exactly one proxy (Caddy) is in front.
