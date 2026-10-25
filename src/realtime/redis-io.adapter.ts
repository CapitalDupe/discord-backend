import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { getEnv } from '../config/env';

/** Socket.IO server options + Redis fan-out so several API instances behave as one realtime cluster. */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const url = getEnv().REDIS_URL;
    if (!url) {
      this.log.warn('REDIS_URL not set: Socket.IO runs single-instance (events will not reach other API instances)');
      return;
    }
    this.pub = new Redis(url);
    this.sub = this.pub.duplicate();
    this.adapterConstructor = createAdapter(this.pub, this.sub);
    this.log.log('Socket.IO Redis adapter enabled');
  }

  createIOServer(port: number, options?: Partial<ServerOptions>) {
    const server = super.createIOServer(port, {
      ...options,
      path: '/socket.io',
      cors: { origin: getEnv().ALLOWED_ORIGINS, credentials: true },
      maxHttpBufferSize: 64 * 1024, // payload limit per event
      pingInterval: 25_000,
      pingTimeout: 20_000,
      connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
    });
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async close(): Promise<void> {
    await this.pub?.quit().catch(() => undefined);
    await this.sub?.quit().catch(() => undefined);
  }
}
