# discord-backend (v3 rewrite, work in progress)

NestJS + Prisma + Socket.IO + Redis + LiveKit/coturn API for the original Discord-style platform in
[CapitalDupe/discord](https://github.com/CapitalDupe/discord). Database: PostgreSQL (Neon supported: use the pooled URL
for `DATABASE_URL` and the direct URL for `DIRECT_URL`).

## Status of this branch

Done and committed:

- Project config (NestJS, TypeScript, ESLint, Prettier, Jest).
- `prisma/schema.prisma`: full normalized data model (users, sessions, devices, MFA, passkeys, servers, roles, channels,
  overwrites, messages, attachments, reactions, threads/forum, DMs, read states, notifications, voice, moderation, appeals,
  automod, hash-chained audit log, security events, IP restrictions, bots, webhooks, feature flags).
- `docs/API.md`: the REST + Socket.IO contract every module follows.
- Core services: validated env, Argon2id/AES-GCM crypto, JWT access tokens with session revocation, Redis-backed rate
  limits, IP normalisation and trusted-proxy handling, tamper-evident audit chain, restricted security-event store,
  global auth / site-role / step-up / rate-limit guards, CSRF middleware, error filter.
- Permission engine (`src/permissions`) with channel overwrites, timeouts, lockdown, role hierarchy and escalation guards,
  plus unit tests.
- Realtime (`src/realtime`): authenticated Socket.IO gateway, per-channel authorised rooms, presence with privacy,
  per-socket flood limits, Redis adapter.
- Health and Prometheus metrics endpoints.

Not written yet (see `docs/API.md` for the planned routes): auth, users, community, messaging, storage, notifications,
moderation, security, admin, bots, voice, mail modules; migrations; Docker Compose stack; CI; tests beyond the permission
unit tests; the Next.js frontend. `src/app.module.ts` only registers the modules that exist.

Nothing in this branch has been compiled or run yet: the build sandbox could not reach the npm registry.
Run `npm install && npx prisma generate && npm run typecheck && npm test` first and fix anything that surfaces.

## Legacy

`main` still contains the previous Node + ws backend (`server.js`, `schema.sql`, Caddy/Docker deploy files); those files are
untouched on this branch and should be moved to `legacy/` or deleted when this branch is merged.

## Local setup

```bash
cp .env.example .env   # fill in real values; never commit .env
npm install
npx prisma generate
npx prisma migrate dev   # or `prisma db push` against a scratch database
npm run start:dev
```
