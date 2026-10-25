'use strict';

// Works out the IP address of the person making a request.
//
// X-Forwarded-For is only believed when TRUST_PROXY is on, meaning exactly one
// reverse proxy (Caddy) sits in front of us. That proxy appends the real client
// address as the LAST entry, so we read the last entry and ignore anything a
// client may have put earlier in the header.

const config = require('../config');

function clientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  const ip = (config.trustProxy && forwarded) || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, ''); // treat IPv4-mapped IPv6 as plain IPv4
}

module.exports = { clientIp };
