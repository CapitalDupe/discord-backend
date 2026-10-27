'use strict';

// File-type sniffing for uploads. The browser-supplied name and content type are
// never trusted: only the first bytes of the file decide whether it is an image.
// SVG is deliberately NOT treated as an image (it can carry scripts).

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// A name that is safe to store and to put in a Content-Disposition header.
function cleanFileName(name) {
  const cleaned = String(name || '').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').trim().slice(0, 120);
  return cleaned || 'file';
}

module.exports = { sniffImageType, cleanFileName };
