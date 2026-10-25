'use strict';

// In-memory sliding-window rate limiter.
// State lives in this process only: it resets on restart and is not shared
// between instances. That is fine for one container; use Redis if you scale out.

const hits = new Map(); // key -> array of timestamps in ms

// Records one hit for `key`. Returns true while the key has made at most `max`
// hits within the last `windowMs` milliseconds, false once it goes over.
function limit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length <= max;
}

// Forget keys that have been quiet for an hour so the map cannot grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) {
    if (!times.length || now - times[times.length - 1] > 36e5) hits.delete(key);
  }
}, 6e5).unref();

module.exports = { limit };
