'use strict';

// The HTTP server: CORS headers, path clean-up, and turning errors into JSON.
// Errors thrown with fail(status, message) become { error: message } with that status;
// anything else is logged and returned as a generic 500.

const http = require('http');
const config = require('../config');
const log = require('../lib/log');
const { sendJson } = require('./respond');
const { route } = require('./router');

// Caddy forwards /api/* to us; strip the prefix and any trailing slash.
function normalizePath(rawUrl) {
  let path = new URL(rawUrl, 'http://x').pathname;
  if (path === '/api' || path.startsWith('/api/')) path = path.slice(4);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

function createApp() {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      log.debug(req.method + ' ' + req.url.split('?')[0] + ' -> ' + res.statusCode + ' (' + (Date.now() - started) + 'ms)');
    });

    res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      await route(req, res, normalizePath(req.url));
    } catch (err) {
      if (err.status) return sendJson(res, err.status, { error: err.message });
      log.error('request failed: ' + req.method + ' ' + req.url.split('?')[0], err);
      sendJson(res, 500, { error: 'Server error' });
    }
  });
}

module.exports = { createApp };
