import { join } from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import * as schema from '../../src/database/schema';
import { applyMigrations, createD1Shim } from '../helpers/d1-shim';

const TOKEN = 'a'.repeat(48);
let sqlite: Database.Database;
let env: Record<string, unknown>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite, join(__dirname, '../../drizzle/migrations'));
  const db = drizzle(sqlite, { schema });
  await db.insert(schema.instagramAccounts).values({ id: 'acct', instagramAccountId: 'ig-acct', username: 'egor' });
  await db.insert(schema.instagramMedia).values({ id: 'media', instagramAccountId: 'acct', instagramMediaId: 'ig-media', mediaType: 'IMAGE', caption: 'Пост про гайд' });
  await db.insert(schema.automations).values({ id: 'auto', instagramMediaId: 'media', name: 'гайд', status: 'active', matchType: 'exact_any' });
  await db.insert(schema.automationKeywords).values({ id: 'kw', automationId: 'auto', keyword: '+', normalizedKeyword: '+' });
  await db.insert(schema.automations).values({ id: 'draft', name: 'черновик', status: 'draft', applyScope: 'account_default' });
  await db.insert(schema.webhookEvents).values([
    { id: 'old', eventKey: 'k-old', eventType: 'comments', rawPayload: '{"secret":"x"}', signatureValid: 1, status: 'completed', receivedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', eventKey: 'k-new', eventType: 'comments', instagramCommentId: 'c1', rawPayload: '{"secret":"x"}', signatureValid: 1, status: 'skipped:own_comment', receivedAt: '2026-10-29T10:00:00.000Z' },
  ]);
  env = { DB: createD1Shim(sqlite), SETUP_TOKEN: TOKEN };
});

const get = (headers: Record<string, string> = {}, q = '?since=2026-10-29T00:00:00.000Z') =>
  createApp().fetch(new Request(`https://igbot.example.com/api/setup/diagnostics${q}`, { headers }), env);

describe('GET /api/setup/diagnostics', () => {
  it('is hidden when SETUP_TOKEN is not configured', async () => {
    delete env.SETUP_TOKEN;
    expect((await get({ Authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it('rejects a wrong token', async () => {
    expect((await get({ Authorization: `Bearer ${'b'.repeat(48)}` })).status).toBe(401);
    expect((await get()).status).toBe(401);
  });

  it('returns active rules and events since the given time, without payloads', async () => {
    const res = await get({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account.username).toBe('egor');
    expect(body.activeRules).toEqual([
      expect.objectContaining({ name: 'гайд', matchType: 'exact_any', keywords: ['+'], post: expect.objectContaining({ caption: 'Пост про гайд' }) }),
    ]);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ status: 'skipped:own_comment', commentId: 'c1' });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
