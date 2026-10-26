'use strict';

// Small helpers for reading requests and writing JSON responses.

const MAX_BODY_BYTES = 16384;

function sendJson(res, status, body) {
  res
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(body));
}

// Reads the request body as JSON. Resolves to {} for an empty or non-object body.
// Rejects with status 413 (too big) or 400 (not valid JSON).
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else {
        raw += chunk;
      }
    });
    req.on('end', () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Bad JSON'), { status: 400 }));
      }
    });
  });
}

// Reads the request body as raw bytes (file uploads). Anything over maxBytes is
// discarded as it arrives and the request is rejected with 413 once it ends.
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk);
      else if (bytes > maxBytes * 3) req.destroy(); // refuse to keep reading a runaway upload
    });
    req.on('end', () => (bytes > maxBytes ? reject(Object.assign(new Error('File too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

module.exports = { sendJson, readJsonBody, readRawBody };
