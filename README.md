# discord-backend (Phase 1: accounts + multi-user)

Node + Postgres + WebSocket backend for [CapitalDupe/discord](https://github.com/CapitalDupe/discord).

## What's in Phase 1

- Registration and login, passwords hashed with **Argon2id**; uniform login errors and a dummy hash check so unknown usernames aren't distinguishable by response or timing.
- Opaque session tokens (256-bit random, only the SHA-256 is stored), 30-day expiry, max 20 per user, logout revokes.
- Rate limits: logins per IP and per username, sign-ups and invite joins per IP (in memory, per instance). Client IPs are only read from `X-Forwarded-For` when `TRUST_PROXY=1`. IPs are not stored.
- Optional `SIGNUP_CODE` gate on registration.
- Normalized Postgres schema (`schema.sql`, applied on startup): users, sessions, servers, roles, members, member_roles, channels, messages, reactions, invites, all with foreign keys and indexes.
- Servers with owner, `@everyone` role, extra roles with bit permissions, role hierarchy (you can't grant permissions you lack, or touch roles/members at or above your rank), kick/leave.
- Invite links with expiry and use limits.
- Realtime events are authorized per user and only delivered to members of the relevant server. Messages are stamped with the real author and time by the server.

## API

`POST /api/register {username,password,code}` and `/api/login {username,password}` return `{token}`. Send `Authorization: Bearer <token>` on everything else; the WebSocket takes `?token=`.

`GET /api/me`, `GET /api/state`, `POST /api/logout`, `POST /api/servers/:sid/invites`, `POST /api/invites/:code/join`, `POST /api/servers/:sid/roles {name,perms,position}`, `PUT /api/servers/:sid/members/:uid/roles {roleIds}`, `DELETE /api/servers/:sid/members/:uid`.

Permission bits: VIEW 1, SEND 2, MANAGE_MESSAGES 4, MANAGE_CHANNELS 8, MANAGE_SERVER 16, MANAGE_ROLES 32, INVITE 64, KICK 128, ADMIN 2^30. Default role: VIEW+SEND+INVITE.

## Deploy (free)

1. Create a Postgres database at neon.tech and copy the connection string.
2. Render: New → Blueprint → this repo. Paste the string into `DATABASE_URL`. Render generates `SIGNUP_CODE` (see its env vars page).
3. Open `https://capitaldupe.github.io/discord/?backend=https://YOUR-SERVICE.onrender.com`, choose Create account, and enter the signup code.
4. Use the 🔗 button to make an invite link for friends.

Run locally: `npm install && DATABASE_URL=postgres://... npm start`.

## Not in Phase 1 yet

Email verification, password reset, 2FA/passkeys, per-channel permission overrides, a role-management UI (roles are API-only), bans, audit logs, DMs, uploads, automated tests. The session token lives in browser localStorage because the site and API are on different domains; an XSS bug in the frontend would expose it. Messages are readable by the server operator (no end-to-end encryption).
