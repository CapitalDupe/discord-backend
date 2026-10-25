# Debugging guide

## Folder map (one folder per feature)

```
src/
  main.ts                 bootstrap: helmet, CORS, trust-proxy, validation pipe, Socket.IO Redis adapter
  app.module.ts           the list of modules that are actually registered (add new modules here)
  config/
    env.ts                every environment variable, validated in one place (start here for config bugs)
    load-env.ts           loads .env before anything reads process.env
  common/                 shared services used by every module
    auth.ts               JwtAuthGuard, SiteRolesGuard, StepUpGuard and the @Public/@SiteRoles decorators
    rate-limit.ts         RateLimitService + @RateLimit decorator + guard (Redis, in-memory fallback)
    token.service.ts      JWT signing/verifying and session revocation
    crypto.service.ts     Argon2id, AES-256-GCM, SHA-256, constant-time compare
    audit.service.ts      hash-chained audit log + verify()
    security-events.service.ts   the ONLY place raw IPs are stored
    ip.ts                 IPv4/IPv6 normalisation, CIDR checks, trusted-proxy client IP
    http.ts               error filter ({error:{code,message}}) and CSRF middleware
    ids.ts                time-sortable ids
  permissions/
    permissions.ts        pure permission maths (no database): easiest place to unit-test
    permissions.service.ts  loads members/roles/overwrites and answers "may user X do Y"
    permissions.spec.ts   tests
  realtime/
    realtime.gateway.ts   Socket.IO handshake auth, rooms, per-socket flood limit, presence
    realtime.service.ts   what other modules call to push events
    redis-io.adapter.ts   multi-instance fan-out
  health/                 /health/live, /health/ready, /metrics
prisma/schema.prisma      data model
docs/API.md               the REST + socket contract (modules not yet written follow this)
```

## Where to look for common problems

| Symptom | Look at |
|---|---|
| App will not start: "Missing required environment variable" | `src/config/env.ts` (production requires real secrets) |
| 401 on every request | `JwtAuthGuard` in `common/auth.ts`; check the `Authorization: Bearer` header and that the session is not revoked (`TokenService.isSessionRevoked`) |
| 403 "Missing permission" or 404 on a channel you expect to see | `PermissionsService.getChannelAccess`; hidden channels deliberately answer 404 |
| 429 too many requests | `@RateLimit` on the route; limits can be overridden in the `SystemSetting` row `rateLimits` |
| Socket connects then drops | gateway middleware in `realtime.gateway.ts` (origin, token, session, max 10 sockets per user) |
| Socket events never arrive | the client must call `channel:subscribe`; check the gateway debug logs below |
| Wrong client IP behind a proxy | `TRUST_PROXY_HOPS` must equal the number of proxies in front of the API |
| Audit chain reports broken | `AuditService.verify()` returns the first bad row id |

## Logging

Set `LOG_LEVEL=debug` to see the gateway log every connect, disconnect, subscription and denied event (user ids only, never IPs or tokens). Request logs are JSON (pino) with authorization and cookies redacted.

## Running one piece at a time

```bash
npm run typecheck          # compile errors without building
npx jest permissions       # only the permission tests
npx prisma validate        # schema errors
npx prisma studio          # browse the database
```
