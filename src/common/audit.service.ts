import { Injectable } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { PrismaService } from './prisma.service';

const GENESIS = '0'.repeat(64);
const LOCK_ID = 770001; // advisory-lock key serialising appends to the chain

export interface AuditInput {
  serverId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/**
 * Tamper-evident audit trail. Every row stores hash = SHA-256(prevHash | canonical(row)); the table is meant to be
 * insert-only (a DB trigger is required in the migration), so editing history breaks the chain and `verify()` reports where.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  private digest(prevHash: string, row: { serverId: string | null; actorId: string | null; action: string; targetType: string | null; targetId: string | null; metadata: unknown; createdAt: Date }): string {
    return this.crypto.sha256(`${prevHash}|${canonical({ ...row, createdAt: row.createdAt.toISOString() })}`);
  }

  async log(input: AuditInput): Promise<void> {
    const row = {
      serverId: input.serverId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? null,
      createdAt: new Date(),
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
      const last = await tx.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
      const prevHash = last?.hash ?? GENESIS;
      await tx.auditLog.create({ data: { ...row, metadata: row.metadata as any, prevHash, hash: this.digest(prevHash, row) } });
    });
  }

  /** Recompute the chain; returns the first broken row id (or null if intact). */
  async verify(batch = 1000): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
    let prev = GENESIS;
    let cursor: bigint | undefined;
    let checked = 0;
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({ where: cursor ? { id: { gt: cursor } } : undefined, orderBy: { id: 'asc' }, take: batch });
      if (!rows.length) return { ok: true, checked, brokenAt: null };
      for (const r of rows) {
        const expected = this.digest(prev, {
          serverId: r.serverId, actorId: r.actorId, action: r.action, targetType: r.targetType, targetId: r.targetId,
          metadata: r.metadata ?? null, createdAt: r.createdAt,
        });
        if (r.prevHash !== prev || r.hash !== expected) return { ok: false, checked, brokenAt: r.id.toString() };
        prev = r.hash;
        checked++;
        cursor = r.id;
      }
    }
  }
}
