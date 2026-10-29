import { join } from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/database/schema';
import { consumeCommentEvents } from '../../src/queue/consumer';
import { applyMigrations, createD1Shim } from '../helpers/d1-shim';

let sqlite: Database.Database;
let urls: string[];

beforeEach(async () => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite, join(__dirname, '../../drizzle/migrations'));
  const db = drizzle(sqlite, { schema });
  await db.insert(schema.instagramAccounts).values({ id: 'acct', instagramAccountId: 'ig-acct' });
  await db.insert(schema.instagramMedia).values({
    id: 'media',
    instagramAccountId: 'acct',
    instagramMediaId: 'ig-media',
    mediaType: 'IMAGE',
  });
  await db.insert(schema.automations).values({
    id: 'auto',
    instagramMediaId: 'media',
    name: 'guide',
    status: 'active',
    matchType: 'contains_any',
    publicReplyEnabled: 1,
    privateReplyEnabled: 1,
    openingDm: 'link',
  });
  await db.insert(schema.automationKeywords).values({ id: 'kw', automationId: 'auto', keyword: 'guide', normalizedKeyword: 'guide' });
  await db.insert(schema.publicReplyVariants).values({ id: 'v', automationId: 'auto', message: 'sent', enabled: 1 });
  await db.insert(schema.webhookEvents).values({
    id: 'evt',
    eventKey: 'key',
    eventType: 'comments',
    instagramAccountId: 'ig-acct',
    instagramMediaId: 'ig-media',
    instagramCommentId: 'c1',
    rawPayload: JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: 'ig-acct',
          time: 1700000000,
          changes: [
            { field: 'comments', value: { id: 'c1', text: 'guide', from: { id: 'u9', username: 'x' }, media: { id: 'ig-media' } } },
          ],
        },
      ],
    }),
    signatureValid: 1,
  });

  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ id: 'r', message_id: 'm' }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function batch() {
  const msg = {
    body: {
      webhookEventId: 'evt',
      eventKey: 'key',
      instagramAccountId: 'ig-acct',
      instagramMediaId: 'ig-media',
      instagramCommentId: 'c1',
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return { msg, batch: { messages: [msg] } };
}

function env(extra: Record<string, unknown> = {}) {
  return {
    DB: createD1Shim(sqlite),
    INSTAGRAM_ACCOUNT_ACCESS_TOKEN: 'tok',
    META_GRAPH_API_VERSION: 'v21.0',
    ...extra,
  };
}

describe('consumeCommentEvents — Meta host', () => {
  it('sends the DM and the public reply through META_BASE_URL (Facebook Login)', async () => {
    const { msg, batch: b } = batch();
    await consumeCommentEvents(b as never, env({ META_BASE_URL: 'https://graph.facebook.com' }) as never);
    expect(msg.ack).toHaveBeenCalled();
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(u.startsWith('https://graph.facebook.com/v21.0/')).toBe(true);
  });

  it('defaults to graph.instagram.com when META_BASE_URL is not set', async () => {
    const { batch: b } = batch();
    await consumeCommentEvents(b as never, env() as never);
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(u.startsWith('https://graph.instagram.com/v21.0/')).toBe(true);
  });
});
