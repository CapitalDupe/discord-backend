'use strict';

// All environment variables are read here, once. Other modules import this
// object instead of touching process.env, so there is exactly one place to look
// when a setting seems to be ignored.

const path = require('path');

const env = process.env;

const config = {
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL || '',

  // The browser origin allowed to call the API and open WebSockets.
  // '*' means anyone and is only meant for local development.
  allowedOrigin: env.ALLOWED_ORIGIN || '*',

  // If set, people must enter this code to register. Empty = open sign-ups.
  signupCode: env.SIGNUP_CODE || '',

  // Secret for POST /api/official/announce. Empty = endpoint disabled.
  adminKey: env.ADMIN_KEY || '',

  // Only trust X-Forwarded-For when exactly one reverse proxy (Caddy) sits in
  // front of this process. '1', 'true' or 'yes' turn it on; anything else is off.
  trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),

  // Global cap on new accounts per hour (on top of the per-IP cap).
  maxSignupsPerHour: Number(env.MAX_SIGNUPS_PER_HOUR) || 200,

  // Set DB_SSL_STRICT=1 to verify the database TLS certificate.
  dbSslStrict: /^(1|true|yes)$/i.test(env.DB_SSL_STRICT || ''),

  // Uploaded files (avatars and attachments) are stored on disk here. Mount a volume on it in Docker.
  uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 8) * 1024 * 1024,
  userQuotaBytes: (Number(env.USER_QUOTA_MB) || 200) * 1024 * 1024,

  // error | warn | info | debug
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
};

// Called once at startup (src/index.js) before anything else runs.
function validate() {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (config.allowedOrigin === '*') {
    console.warn('WARNING: ALLOWED_ORIGIN is not set; CORS and WebSocket origin checks are wide open.');
  }
}

module.exports = config;
module.exports.validate = validate;
