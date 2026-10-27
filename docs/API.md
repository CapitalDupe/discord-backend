# API & architecture contract (v1)

Every module author and the frontend must follow this file. Base path `/api/v1`. JSON only. Errors:
`{ "error": { "code": "FORBIDDEN", "message": "..." } }` with the matching HTTP status. Ids are 26-char
time-sortable strings (`newId()`). Timestamps are ISO-8601 strings. Pagination: `?limit=` (max 100) with
`before` / `after` ids; list responses are `{ items: [...], nextCursor?: string }` unless noted.

## Cross-cutting rules

* **Auth**: `Authorization: Bearer <accessToken>` (HS256 JWT, 15 min, claims `sub`, `sid`, `role`). Refresh token is
  an opaque 256-bit value in the `__Host-rt` HttpOnly, Secure, SameSite=Lax cookie (path `/api/v1/auth`), rotated on every
  use; reuse of a rotated token revokes the whole family. Browser state-changing cookie calls require the header
  `X-Requested-With: fetch` and a matching `Origin`. Bots use `Authorization: Bot <token>`.
* **Authorization is deny-by-default** and always resolved server side through `PermissionsService`
  (`src/permissions`). Never accept permission flags, role names, or user ids from the client as proof of anything.
* **Mass assignment**: all DTOs use `class-validator`; the global `ValidationPipe` has `whitelist` and
  `forbidNonWhitelisted`.
* **Rate limits**: `@RateLimit({ name, max, windowSec, by: 'ip' | 'user' | 'both' })` from `src/common/rate-limit`.
* **IP privacy**: raw IPs are written only through `SecurityEventsService` (table `SecurityEvent`). No other table,
  log line, API response, socket event, or error message may contain another person's IP.
* **Audit**: privileged actions call `AuditService.log(...)` (hash-chained, insert-only).
* **Idempotency**: message sends carry a client `nonce` (unique per channel+author); retries return the original message.

## Shared services (all in `src/common`, provided by the global `CommonModule`)

`PrismaService`, `RedisService`, `CryptoService`, `AuditService`, `SecurityEventsService`, `RateLimitService`,
`TokenService`, `PermissionsService` (in `src/permissions`), `RealtimeService` (in `src/realtime`).

Global modules that other modules may inject without importing: `MailModule` (`MailService`), `SecurityModule`
(`ChallengeService`, `IpRestrictionService`), `StorageModule` (`StorageService`), `NotificationsModule`
(`NotificationsService`). `ModerationModule` exports `AutomodService` and must be imported by `MessagingModule`.

### Interfaces other modules rely on

```ts
// src/mail/mail.service.ts
send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void>; // never throws to callers; logs + queues retry

// src/security/challenge.service.ts  (self-hosted proof-of-work challenge, no third party)
shouldChallenge(ctx: { ip: string; identifier?: string; action: 'register' | 'login' | 'join' | 'reset' }): Promise<boolean>;
issue(): Promise<{ id: string; salt: string; difficulty: number; expiresAt: string }>;
verify(id: string, solution: string): Promise<boolean>; // single use

// src/security/ip-restriction.service.ts
check(ip: string, action: string): Promise<{ allowed: boolean; challenge?: boolean; retryAfterSec?: number }>;

// src/storage/storage.service.ts
presignPut(args: { key: string; contentType: string; sizeBytes: number }): Promise<{ url: string; headers: Record<string,string> }>;
presignGet(key: string, ttlSec?: number): Promise<string>;
head(key: string): Promise<{ sizeBytes: number; contentType?: string } | null>;
readHead(key: string, bytes: number): Promise<Buffer>; // for magic-byte validation
delete(key: string): Promise<void>;

// src/notifications/notifications.service.ts
notify(args: { userId: string; kind: 'MENTION'|'REPLY'|'DM'|'INVITE'|'MOD'|'SECURITY'; data: object; dedupeKey?: string }): Promise<void>;

// src/moderation/automod.service.ts
evaluate(i: { serverId: string; channelId: string; userId: string; content: string; roleIds: string[] }):
  Promise<{ action: 'ALLOW' | 'BLOCK' | 'FLAG' | 'TIMEOUT'; reason?: string }>;

// src/realtime/realtime.service.ts
toUser(userId: string, event: string, payload: unknown): void;
toServer(serverId: string, event: string, payload: unknown): void;       // all members subscribed to the server room
toChannel(channelId: string, event: string, payload: unknown): void;     // only sockets authorized for the channel
resyncUser(userId: string): Promise<void>;     // re-evaluate room membership after role/overwrite/membership changes
resyncChannel(channelId: string): Promise<void>;
disconnectSession(sessionId: string): Promise<void>;
```

## REST routes

Legend: 🔒 requires login; ⬆ requires step-up token (`X-Step-Up` header from `POST /auth/step-up`).

### Auth (`AuthModule`)
| Method & path | Notes |
|---|---|
| `GET /auth/challenge` | self-hosted PoW challenge |
| `POST /auth/register` | `{email,username,password,birthDate,challenge?}` → 202 uniform response (never reveals whether the email exists) |
| `POST /auth/verify-email` | `{token}` |
| `POST /auth/resend-verification` | `{email}` → 202 uniform |
| `POST /auth/login` | `{identifier,password,challenge?}` → `{accessToken,expiresIn,user}` or `{mfaRequired:true,mfaToken,methods}` |
| `POST /auth/mfa/verify` | `{mfaToken,code,type:'totp'\|'backup'}` |
| `POST /auth/refresh` | cookie → `{accessToken,expiresIn}` |
| `POST /auth/logout`, `POST /auth/logout-all` 🔒 | |
| `POST /auth/password/forgot` `{email}` → 202; `POST /auth/password/reset` `{token,newPassword}` | single-use, expiring, hashed tokens |
| `POST /auth/step-up` 🔒 | `{password}` or `{code}` → `{stepUpToken,expiresIn}` (5 min) |
| `POST /auth/passkey/login/options`, `POST /auth/passkey/login/verify` | WebAuthn |
| `GET /auth/oauth/:provider/start`, `GET /auth/oauth/:provider/callback` | optional, only providers configured in env |

### Account (`AuthModule`) 🔒
`GET /account/sessions`, `DELETE /account/sessions/:id`, `GET /account/devices`, `GET /account/security-events` (own events, no IPs),
`POST /account/mfa/totp/setup`, `POST /account/mfa/totp/enable {code}`, `POST /account/mfa/disable` ⬆,
`POST /account/mfa/backup-codes/regenerate` ⬆, `POST /account/passkeys/register/options`, `POST /account/passkeys/register/verify`,
`GET /account/passkeys`, `DELETE /account/passkeys/:id` ⬆, `PATCH /account/password` ⬆, `PATCH /account/email` ⬆,
`DELETE /account` ⬆ (soft delete, retention window in `docs/RETENTION.md`), `POST /account/export`, `GET /account/export/:id`.

### Users, uploads (`UsersModule`, `StorageModule`) 🔒
`GET /users/@me`, `PATCH /users/@me` (`displayName,bio,accentColor,customStatus,presence,showPresence,showReadReceipts,avatarUploadId?,bannerUploadId?`),
`PATCH /users/@me/username`, `GET /users/:id` (public profile, honours privacy settings).
`POST /uploads/presign {purpose:'attachment'|'avatar'|'banner'|'icon'|'emoji'|'voice',filename,contentType,sizeBytes,channelId?}` →
`{uploadId,url,headers}`; `POST /uploads/:id/complete` (server re-checks size, magic bytes, scan hook) → `{attachment}`;
`GET /uploads/:id/url` → short-lived signed GET URL (authorized per attachment's channel).

### Communities (`CommunityModule`) 🔒
Servers: `POST /servers`, `GET /servers`, `GET /servers/discover?q=`, `GET|PATCH|DELETE /servers/:sid`, `POST /servers/:sid/join`,
`POST /servers/:sid/leave`, `GET /servers/:sid/members`, `PATCH /servers/:sid/members/:uid {nickname?,roleIds?}`,
`POST /servers/:sid/rules/accept`, `POST /servers/:sid/screening`, `PATCH /servers/:sid/onboarding`.
Roles: `GET|POST /servers/:sid/roles`, `PATCH|DELETE /servers/:sid/roles/:rid`, `PUT /servers/:sid/roles/order`.
Channels: `GET|POST /servers/:sid/channels`, `PATCH|DELETE /channels/:cid`, `PUT /servers/:sid/channels/order`,
`PUT|DELETE /channels/:cid/overwrites/:targetType/:targetId` (`targetType` = `role`|`user`),
categories `POST /servers/:sid/categories`, `PATCH|DELETE /categories/:id`.
Invites: `POST /servers/:sid/invites`, `GET /servers/:sid/invites`, `DELETE /invites/:code`, `GET /invites/:code` (preview), `POST /invites/:code/accept`.
Join requests: `GET /servers/:sid/join-requests`, `POST /servers/:sid/join-requests/:id/approve|reject`.
Templates/backup: `POST|GET /servers/:sid/templates`, `POST /templates/:id/apply`, `GET /servers/:sid/backup`, `POST /servers/:sid/restore` ⬆.
Threads/forum: `POST /messages/:mid/threads`, `GET /channels/:cid/threads`, `PATCH /threads/:id` (archive), `POST /channels/:cid/posts`,
`GET|POST|DELETE /servers/:sid/forum-tags`. Audit log: `GET /servers/:sid/audit-log`. Emoji: `GET|POST|DELETE /servers/:sid/emoji`.

### Messaging (`MessagingModule`, `NotificationsModule`) 🔒
`GET /channels/:cid/messages?before&after&around&limit`, `POST /channels/:cid/messages {content,nonce,replyToId?,attachmentIds?}`,
`PATCH /messages/:mid {content}`, `DELETE /messages/:mid`, `PUT|DELETE /messages/:mid/reactions/:emoji`,
`GET /channels/:cid/pins`, `PUT|DELETE /channels/:cid/pins/:mid`, `GET /users/@me/saved`, `PUT|DELETE /users/@me/saved/:mid`,
`GET /search/messages?q&serverId&channelId&authorId&has&before&after`, `POST /dms {userIds[]}`, `GET /dms`,
`PUT /channels/:cid/read {messageId}`, `GET /users/@me/read-states`, `GET|PUT|DELETE /channels/:cid/draft`, `POST /channels/:cid/typing`,
`POST /messages/:mid/report {reason}`, `GET /notifications`, `POST /notifications/read`, `GET|PUT /notification-preferences`,
`POST|DELETE /push/subscribe`, `GET /push/vapid-key`.

### Moderation (`ModerationModule`) 🔒
`POST /servers/:sid/bans`, `DELETE /servers/:sid/bans/:uid`, `GET /servers/:sid/bans`, `POST /servers/:sid/members/:uid/kick`,
`PUT|DELETE /servers/:sid/members/:uid/timeout`, `POST /servers/:sid/messages/bulk-delete`, `GET /servers/:sid/reports`, `PATCH /reports/:rid`,
`GET|POST /servers/:sid/members/:uid/notes`, `GET|POST /servers/:sid/automod-rules`, `PATCH|DELETE /automod-rules/:id`,
`POST|DELETE /servers/:sid/lockdown`, `POST /appeals`, `GET /servers/:sid/appeals`, `PATCH /appeals/:id`, `GET /servers/:sid/mod-log`.

### Security (`SecurityModule`) 🔒 site role SECURITY or ADMIN
`GET /security/events`, `POST /security/events/:id/reveal-ip {reason}` (audited), `GET|POST|DELETE /security/ip-restrictions`, `GET /security/access-log`.

### Admin (`AdminModule`) 🔒 site role ADMIN (some SUPPORT read-only)
`GET /admin/overview`, `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/lock|unlock` ⬆, `GET /admin/servers`,
`GET /admin/reports`, `GET /admin/health`, `GET /admin/jobs`, `GET /admin/storage`, `GET /admin/audit`, `GET /admin/audit/verify`,
`GET|PUT /admin/rate-limits`, `GET|PUT /admin/flags`, `GET|PUT /admin/retention`, `GET /admin/backups`.

### Voice (`VoiceModule`) 🔒
`POST /voice/channels/:cid/join {relayOnly?,video?}` → `{livekitUrl,token,iceServers,relayOnly}`, `POST /voice/channels/:cid/leave`,
`GET /voice/channels/:cid/state`, `PATCH /voice/channels/:cid/participants/:uid {mute?,deafen?,moveTo?,speaker?}`,
`POST /voice/channels/:cid/stage/request`, `POST|DELETE /voice/channels/:cid/recording`, `POST /dms/:cid/call/start`, `POST /dms/:cid/call/join`,
`GET /voice/ice`.

### Bots & webhooks (`BotsModule`) 🔒
`POST|GET /bots`, `POST /bots/:id/token/rotate`, `PUT|DELETE /servers/:sid/bots/:botId`, `PUT /bots/:id/commands`, `GET /servers/:sid/commands`,
`PUT /bots/:id/subscriptions`, `POST /interactions`, `GET|POST /servers/:sid/webhooks`, `POST /webhooks/:id/rotate-secret`, `DELETE /webhooks/:id`,
`POST /hooks/:id/:token` (inbound, HMAC `X-Signature` + `X-Timestamp`, replay-protected), bot API under `/bot/*` with `Authorization: Bot <token>`.

### Health
`GET /health/live`, `GET /health/ready` (unprefixed `/health/*` too), `GET /metrics` (Prometheus, internal network only).

## Socket.IO

Path `/socket.io`, handshake `auth: { token: <accessToken> }`. After connect the server joins `user:<id>` and, for each
server the user belongs to, `server:<id>`; channel rooms (`channel:<id>`) are joined only after a permission check
(`VIEW_CHANNEL` + `READ_HISTORY`), re-evaluated on every role/overwrite/membership change.

Client → server (all with ack): `channel:subscribe {channelId}`, `channel:unsubscribe`, `typing:start {channelId}`,
`presence:set {status}`, `message:send {channelId,content,nonce,replyToId?,attachmentIds?}` (same pipeline as REST).

Server → client: `ready {user,servers}`, `message:new`, `message:update`, `message:delete`, `reaction:add`, `reaction:remove`,
`typing {channelId,userId}`, `presence:update {userId,status}`, `channel:create|update|delete`, `member:add|update|remove`,
`role:create|update|delete`, `server:update`, `notification:new`, `readstate:update`, `voice:state`, `session:revoked`, `resync`.
Reconnect recovery: the client remembers the last message id per open channel and calls
`GET /channels/:cid/messages?after=<id>`; the server also emits `resync` if it cannot guarantee delivery.

## Response shapes (what `v3.js` in the frontend relies on)

Lists return `{ items, nextCursor? }`. Within a page, `items` for messages are ordered **oldest to newest**.

```jsonc
User     { "id", "username", "displayName", "accentColor", "isBot", "avatarUrl"? , "status"? /* ONLINE|IDLE|DND|OFFLINE */ }
Server   { "id", "name", "ownerId" }
Channel  { "id", "serverId", "type": "TEXT|ANNOUNCEMENT|VOICE|STAGE|FORUM|DM|...", "name", "position"? }
Member   { "userId", "nickname"|null, "user": User, "status": "ONLINE|IDLE|DND|OFFLINE" }
Message  { "id", "channelId", "author": { "id", "displayName", "accentColor" } | null,
           "content", "createdAt", "editedAt"|null, "deletedAt"|null, "nonce"|null,
           "reactions": [ { "emoji", "count", "me": true|false } ] }
```

| Call | Response |
|---|---|
| `POST /servers {name}` | `{ server, channels }` (a default `general` text channel is created) |
| `POST /servers/:sid/channels {name,type}` | `Channel` |
| `POST /servers/:sid/invites` | `{ code }` |
| `POST /invites/:code/accept` | `{ server }` |
| `POST /channels/:cid/messages {content,nonce}` | `Message` (a retry with the same nonce returns the original) |
| `GET /servers/:sid/members?limit=100` | `{ items: Member[] }` |

`nonce` is 1 to 64 characters. The frontend uses its local message id.

### Proof-of-work challenge

`GET /auth/challenge` returns `{ id, salt, difficulty, expiresAt }`. When a route needs one it answers 4xx with error code
`CHALLENGE_REQUIRED`. The client then resends the body with `challenge: { id, solution }`, where `solution` is the number `n`
such that SHA-256 of `"<salt>:<n>"` has at least `difficulty` leading zero bits. A challenge is single use.

### Login and MFA

`POST /auth/login {identifier,password}` returns `{ accessToken, expiresIn }` or `{ mfaRequired: true, mfaToken }`.
`POST /auth/mfa/verify {mfaToken,code,type:'totp'|'backup'}` returns `{ accessToken, expiresIn }`.

### Socket events (payloads)

The frontend adapter (`v3.js`) reads exactly these fields:

| Event | Payload |
|---|---|
| `message:new`, `message:update` | `{ message: Message }` |
| `message:delete` | `{ channelId, id }` |
| `reaction:add`, `reaction:remove` | `{ channelId, messageId, emoji, userId }` |
| `typing` | `{ channelId, userId }` |
| `presence:update` | `{ userId, status }` |
| `channel:create`, `channel:update` | `{ channel: Channel }` (with `serverId`) |
| `channel:delete` | `{ serverId, channelId }` |
| `server:update` | `{ server: Server }` |
| `member:add` | `{ member: Member }` |
| `member:remove` | `{ serverId, userId }` |
| `session:revoked`, `resync` | `{}` |
