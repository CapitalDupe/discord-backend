'use strict';

// PUT /upload?name=photo.png  (private)
// The request body is the raw file (not multipart). Files are stored on disk in
// UPLOAD_DIR under a random id; the database keeps the name, type and size.
// Limits: MAX_UPLOAD_MB per file, USER_QUOTA_MB per user, 30 uploads per 10 minutes.
// Answers { id, name, mime, size }.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { limit } = require('../../lib/rateLimit');
const { fail } = require('../../lib/util');
const { sniffImageType, cleanFileName } = require('../../lib/files');
const { queryOne, query } = require('../../db/pool');
const { sendJson, readRawBody } = require('../respond');

module.exports = async function uploadRoutes(ctx) {
  if (ctx.method !== 'PUT' || ctx.path !== '/upload') return false;
  const { req, res, user } = ctx;
  if (!limit('upload:' + user.id, 30, 6e5)) fail(429, 'Uploading too fast, wait a moment');

  const bytes = await readRawBody(req, config.maxUploadBytes);
  if (!bytes.length) fail(400, 'Empty file');

  const used = await queryOne('select coalesce(sum(size),0)::float8 n from uploads where user_id=$1', [user.id]);
  if (used.n + bytes.length > config.userQuotaBytes) fail(413, 'Storage quota reached');

  const name = cleanFileName(new URL(req.url, 'http://x').searchParams.get('name'));
  const mime = sniffImageType(bytes) || 'application/octet-stream'; // only real images are served inline
  const id = crypto.randomBytes(16).toString('hex');

  await fs.promises.mkdir(config.uploadDir, { recursive: true });
  await fs.promises.writeFile(path.join(config.uploadDir, id), bytes, { flag: 'wx' });
  await query('insert into uploads(id,user_id,name,mime,size) values($1,$2,$3,$4,$5)', [id, user.id, name, mime, bytes.length]);

  sendJson(res, 201, { id, name, mime, size: bytes.length });
  return true;
};
