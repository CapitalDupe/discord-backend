import { randomBytes } from 'crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** 26-char, time-sortable id: 10 chars of millisecond timestamp + 16 chars (80 bits) of randomness. */
export function newId(now: number = Date.now()): string {
  let t = now;
  let ts = '';
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of randomBytes(10)) bits = (bits << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return ts + rand;
}

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
