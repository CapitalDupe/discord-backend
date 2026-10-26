'use strict';

// Routes a WebSocket event to its handler by event type (the `t` field).
// To add a new event: put a handler in a file under ./handlers and it is picked up here.

const handlers = Object.assign(
  {},
  require('./handlers/message'),
  require('./handlers/server'),
  require('./handlers/channel'),
  require('./handlers/user'),
  require('./handlers/activity')
);

// Returns the handler result (see handlers/message.js) or null for unknown/invalid events.
async function handleEvent(user, event) {
  if (!event || typeof event.t !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(handlers, event.t)) return null;
  return handlers[event.t](user, event);
}

module.exports = { handleEvent };
