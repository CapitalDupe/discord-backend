import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { getEnv } from '../config/env';

@Injectable()
export class CryptoService {
  private readonly key = Buffer.from(getEnv().ENCRYPTION_KEY, 'base64');

  sha256(v: string | Buffer): string {
    return createHash('sha256').update(v).digest('hex');
  }

  hmacSha256(key: string | Buffer, data: string | Buffer): string {
    return createHmac('sha256', key).update(data).digest('hex');
  }

  /** Cryptographically secure URL-safe random token (default 256 bits). */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Uniform random numeric code. */
  randomDigits(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += randomInt(0, 10).toString();
    return s;
  }

  /** Constant-time string comparison (hashes first so length differences do not leak). */
  safeEqual(a: string, b: string): boolean {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  }

  /** AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext> (base64url). */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, ct] = payload.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  // Argon2id, 64 MiB / t=3 / p=1 (above the OWASP minimum).
  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
  }
}
