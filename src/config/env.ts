/**
 * Central, validated environment access. Secrets only ever come from the environment (never from code or the client bundle).
 */
export interface Env {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  PUBLIC_URL: string;
  WEB_URL: string;
  ALLOWED_ORIGINS: string[];
  TRUST_PROXY_HOPS: number;

  DATABASE_URL: string;
  DIRECT_URL: string;
  REDIS_URL: string | null;

  JWT_SECRET: string;
  ENCRYPTION_KEY: string; // base64, 32 bytes
  ACCESS_TOKEN_TTL_SEC: number;
  REFRESH_TOKEN_TTL_DAYS: number;
  REQUIRE_EMAIL_VERIFICATION: boolean;
  SIGNUPS_ENABLED: boolean;
  MIN_AGE: number;
  IP_RETENTION_DAYS: number;
  METRICS_TOKEN: string | null;

  MAIL_TRANSPORT: 'smtp' | 'composio' | 'log';
  MAIL_FROM: string;
  SMTP_HOST: string | null;
  SMTP_PORT: number;
  SMTP_USER: string | null;
  SMTP_PASS: string | null;
  SMTP_SECURE: boolean;
  COMPOSIO_API_KEY: string | null;
  COMPOSIO_USER_ID: string | null;
  COMPOSIO_CONNECTED_ACCOUNT_ID: string | null;

  S3_ENDPOINT: string | null;
  S3_PUBLIC_ENDPOINT: string | null;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY: string | null;
  S3_SECRET_KEY: string | null;
  S3_FORCE_PATH_STYLE: boolean;
  MAX_UPLOAD_MB: number;

  LIVEKIT_URL: string | null;
  LIVEKIT_PUBLIC_URL: string | null;
  LIVEKIT_API_KEY: string | null;
  LIVEKIT_API_SECRET: string | null;
  TURN_URLS: string[];
  TURN_SECRET: string | null;
  TURN_TTL_SEC: number;
  FORCE_RELAY: boolean;

  VAPID_PUBLIC_KEY: string | null;
  VAPID_PRIVATE_KEY: string | null;
  VAPID_SUBJECT: string;

  WEBAUTHN_RP_ID: string;
  WEBAUTHN_RP_NAME: string;
  WEBAUTHN_ORIGIN: string;

  OAUTH_GITHUB_CLIENT_ID: string | null;
  OAUTH_GITHUB_CLIENT_SECRET: string | null;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const num = (v: string | undefined, d: number) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in environment: ${v}`);
  return n;
};
const str = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
const list = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const e = process.env;
  const nodeEnv = (e.NODE_ENV as Env['NODE_ENV']) || 'development';
  const prod = nodeEnv === 'production';

  const required = (name: string, fallbackForDev?: string): string => {
    const v = e[name];
    if (v && v.trim()) return v.trim();
    if (!prod && fallbackForDev !== undefined) return fallbackForDev;
    throw new Error(`Missing required environment variable ${name}`);
  };

  const devKey = Buffer.alloc(32, 7).toString('base64');
  const jwt = required('JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789abcdef');
  if (prod && jwt.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
  const encKey = required('ENCRYPTION_KEY', devKey);
  if (Buffer.from(encKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  if (prod && encKey === devKey) throw new Error('ENCRYPTION_KEY must not be the development default');

  const publicUrl = (e.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const webUrl = (e.WEB_URL || 'http://localhost:3001').replace(/\/+$/, '');
  const dbUrl = required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/discord?schema=app');

  cached = {
    NODE_ENV: nodeEnv,
    PORT: num(e.PORT, 3000),
    PUBLIC_URL: publicUrl,
    WEB_URL: webUrl,
    ALLOWED_ORIGINS: list(e.ALLOWED_ORIGINS).length ? list(e.ALLOWED_ORIGINS) : [webUrl],
    TRUST_PROXY_HOPS: num(e.TRUST_PROXY_HOPS, 0),

    DATABASE_URL: dbUrl,
    DIRECT_URL: str(e.DIRECT_URL) || dbUrl,
    REDIS_URL: str(e.REDIS_URL),

    JWT_SECRET: jwt,
    ENCRYPTION_KEY: encKey,
    ACCESS_TOKEN_TTL_SEC: num(e.ACCESS_TOKEN_TTL_SEC, 900),
    REFRESH_TOKEN_TTL_DAYS: num(e.REFRESH_TOKEN_TTL_DAYS, 30),
    REQUIRE_EMAIL_VERIFICATION: bool(e.REQUIRE_EMAIL_VERIFICATION, true),
    SIGNUPS_ENABLED: bool(e.SIGNUPS_ENABLED, true),
    MIN_AGE: num(e.MIN_AGE, 13),
    IP_RETENTION_DAYS: num(e.IP_RETENTION_DAYS, 30),
    METRICS_TOKEN: str(e.METRICS_TOKEN),

    MAIL_TRANSPORT: (e.MAIL_TRANSPORT as Env['MAIL_TRANSPORT']) || (str(e.SMTP_HOST) ? 'smtp' : 'log'),
    MAIL_FROM: e.MAIL_FROM || 'Chat <no-reply@localhost>',
    SMTP_HOST: str(e.SMTP_HOST),
    SMTP_PORT: num(e.SMTP_PORT, 587),
    SMTP_USER: str(e.SMTP_USER),
    SMTP_PASS: str(e.SMTP_PASS),
    SMTP_SECURE: bool(e.SMTP_SECURE, false),
    COMPOSIO_API_KEY: str(e.COMPOSIO_API_KEY),
    COMPOSIO_USER_ID: str(e.COMPOSIO_USER_ID),
    COMPOSIO_CONNECTED_ACCOUNT_ID: str(e.COMPOSIO_CONNECTED_ACCOUNT_ID),

    S3_ENDPOINT: str(e.S3_ENDPOINT),
    S3_PUBLIC_ENDPOINT: str(e.S3_PUBLIC_ENDPOINT) || str(e.S3_ENDPOINT),
    S3_REGION: e.S3_REGION || 'us-east-1',
    S3_BUCKET: e.S3_BUCKET || 'chat-uploads',
    S3_ACCESS_KEY: str(e.S3_ACCESS_KEY),
    S3_SECRET_KEY: str(e.S3_SECRET_KEY),
    S3_FORCE_PATH_STYLE: bool(e.S3_FORCE_PATH_STYLE, true),
    MAX_UPLOAD_MB: num(e.MAX_UPLOAD_MB, 25),

    LIVEKIT_URL: str(e.LIVEKIT_URL),
    LIVEKIT_PUBLIC_URL: str(e.LIVEKIT_PUBLIC_URL) || str(e.LIVEKIT_URL),
    LIVEKIT_API_KEY: str(e.LIVEKIT_API_KEY),
    LIVEKIT_API_SECRET: str(e.LIVEKIT_API_SECRET),
    TURN_URLS: list(e.TURN_URLS),
    TURN_SECRET: str(e.TURN_SECRET),
    TURN_TTL_SEC: num(e.TURN_TTL_SEC, 600),
    FORCE_RELAY: bool(e.FORCE_RELAY, false),

    VAPID_PUBLIC_KEY: str(e.VAPID_PUBLIC_KEY),
    VAPID_PRIVATE_KEY: str(e.VAPID_PRIVATE_KEY),
    VAPID_SUBJECT: e.VAPID_SUBJECT || 'mailto:admin@localhost',

    WEBAUTHN_RP_ID: e.WEBAUTHN_RP_ID || new URL(webUrl).hostname,
    WEBAUTHN_RP_NAME: e.WEBAUTHN_RP_NAME || 'Chat',
    WEBAUTHN_ORIGIN: e.WEBAUTHN_ORIGIN || webUrl,

    OAUTH_GITHUB_CLIENT_ID: str(e.OAUTH_GITHUB_CLIENT_ID),
    OAUTH_GITHUB_CLIENT_SECRET: str(e.OAUTH_GITHUB_CLIENT_SECRET),
  };
  return cached;
}

/** Test helper: clear the memoised env. */
export function resetEnvForTests(): void {
  cached = null;
}
