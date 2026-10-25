import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getEnv } from '../config/env';

/**
 * Thin wrapper around ioredis. Redis is required for multi-instance deployments (Socket.IO adapter, shared rate limits,
 * session revocation). Without REDIS_URL the API still runs as a single instance using in-memory fallbacks.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  readonly client: Redis | null;

  constructor() {
    const url = getEnv().REDIS_URL;
    if (!url) {
      this.client = null;
      this.log.warn('REDIS_URL not set: running single-instance with in-memory fallbacks');
      return;
    }
    this.client = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true });
    this.client.on('error', (e) => this.log.error(`redis error: ${e.message}`));
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  duplicate(): Redis | null {
    return this.client ? this.client.duplicate() : null;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return true;
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
