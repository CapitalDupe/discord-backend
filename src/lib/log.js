'use strict';

// Tiny leveled logger. Set LOG_LEVEL=debug to see every request and event.
// Never log tokens, passwords or full URLs of WebSocket connections.

const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] === undefined ? LEVELS.info : LEVELS[config.logLevel];

function write(level, message, detail) {
  if (LEVELS[level] > threshold) return;
  const line = new Date().toISOString() + ' ' + level.toUpperCase() + ' ' + message;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (detail === undefined) out(line);
  else out(line, detail);
}

module.exports = {
  error: (message, detail) => write('error', message, detail),
  warn: (message, detail) => write('warn', message, detail),
  info: (message, detail) => write('info', message, detail),
  debug: (message, detail) => write('debug', message, detail),
};
