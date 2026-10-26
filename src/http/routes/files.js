'use strict';

// GET /files/:id  (public)
// Serves an uploaded file. The id is 128 random bits, so only people who were shown
// the file (in a message or as an avatar) can know it. Images are shown inline; every
// other file is forced to download, and nothing is ever interpreted as a web page.

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { fail } = require('../../lib/util');
const { queryOne } = require('../../db/pool');

const FILE_PATH = /^\/files\/([a-f0-9]{32})$/;

module.exports = async function fileRoutes(ctx) {
  const match = ctx.method === 'GET' && ctx.path.match(FILE_PATH);
  if (!match) return false;
  const { res } = ctx;

  const file = await queryOne('select name,mime,size from uploads where id=$1', [match[1]]);
  if (!file) fail(404, 'Not found');

  const inline = file.mime.startsWith('image/');
  res.writeHead(200, {
    'Content-Type': inline ? file.mime : 'application/octet-stream',
    'Content-Length': file.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin', // the frontend is on another origin
    ...(inline ? {} : { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name) }),
  });
  fs.createReadStream(path.join(config.uploadDir, match[1])).on('error', () => res.destroy()).pipe(res);
  return true;
};
