// Диагностика для мастера установки: GET /api/setup/diagnostics?since=ISO.
// Мастер по этим данным проверяет цепочку «комментарий → робот → правило → директ → ответ»
// и объясняет, где она оборвалась. Доступ — по секрету SETUP_TOKEN, который мастер сам
// сохраняет в Cloudflare при установке. Секретов и текстов сообщений в ответе нет.
import { desc, eq, gte, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings } from '../app';
import { createDb } from '../database/client';
import {
  apiAttempts,
  automationKeywords,
  automationRuns,
  automations,
  instagramAccounts,
  instagramMedia,
  systemSettings,
  webhookEvents,
} from '../database/schema';
import { hintForMetaError } from '../meta/error-hints';

const encoder = new TextEncoder();

// Сравнение за постоянное время: длину не скрываем, токен фиксированной длины.
function sameToken(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function createSetupRoutes() {
  const app = new Hono<{ Bindings: AppBindings }>();

  app.get('/diagnostics', async (c) => {
    const expected = c.env.SETUP_TOKEN;
    const given = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!expected || expected.length < 32) return c.json({ error: 'not configured' }, 404);
    if (!sameToken(given, expected)) return c.json({ error: 'unauthorized' }, 401);

    const sinceParam = c.req.query('since');
    const since = sinceParam && !Number.isNaN(Date.parse(sinceParam)) ? new Date(sinceParam).toISOString() : '1970-01-01T00:00:00.000Z';
    const db = createDb(c.env.DB);

    const account = (await db.select().from(instagramAccounts).limit(1))[0] ?? null;
    const settings = (await db.select().from(systemSettings).where(eq(systemSettings.id, 'default')).limit(1))[0];

    const active = await db.select().from(automations).where(eq(automations.status, 'active'));
    const ids = active.map((a) => a.id);
    const kws = ids.length ? await db.select().from(automationKeywords).where(inArray(automationKeywords.automationId, ids)) : [];
    const mediaIds = active.map((a) => a.instagramMediaId).filter((x): x is string => !!x);
    const media = mediaIds.length ? await db.select().from(instagramMedia).where(inArray(instagramMedia.id, mediaIds)) : [];

    const events = await db
      .select()
      .from(webhookEvents)
      .where(gte(webhookEvents.receivedAt, since))
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(20);
    const runs = await db
      .select()
      .from(automationRuns)
      .where(gte(automationRuns.createdAt, since))
      .orderBy(desc(automationRuns.createdAt))
      .limit(10);
    const failed = (
      await db
        .select()
        .from(apiAttempts)
        .where(gte(apiAttempts.startedAt, since))
        .orderBy(desc(apiAttempts.completedAt))
        .limit(1)
    )[0];

    return c.json({
      now: new Date().toISOString(),
      account: account
        ? {
            username: account.username,
            automationEnabled: account.automationEnabled === 1,
            circuitBreakerStatus: account.circuitBreakerStatus,
            lastWebhookReceivedAt: account.lastWebhookReceivedAt,
          }
        : null,
      emergencyStop: settings?.emergencyStop === 1,
      activeRules: active.map((a) => {
        const m = media.find((x) => x.id === a.instagramMediaId);
        return {
          name: a.name,
          scope: a.applyScope,
          matchType: a.matchType,
          keywords: kws.filter((k) => k.automationId === a.id).map((k) => k.keyword),
          privateReplyEnabled: a.privateReplyEnabled === 1,
          publicReplyEnabled: a.publicReplyEnabled === 1,
          post: m ? { caption: (m.caption ?? '').slice(0, 80), permalink: m.permalink } : null,
        };
      }),
      events: events.map((e) => ({
        receivedAt: e.receivedAt,
        type: e.eventType,
        status: e.status,
        signatureValid: e.signatureValid === 1,
        commentId: e.instagramCommentId,
      })),
      runs: runs.map((r) => ({
        createdAt: r.createdAt,
        commentId: r.instagramCommentId,
        commenterUsername: r.commenterUsername,
        matchedKeyword: r.matchedKeyword,
        status: r.status,
        privateReplyStatus: r.privateReplyStatus,
        publicReplyStatus: r.publicReplyStatus,
      })),
      lastProblem:
        failed && failed.failureReason != null
          ? {
              at: failed.completedAt,
              action: failed.actionType,
              metaErrorCode: failed.metaErrorCode,
              metaErrorMessage: failed.metaErrorMessage,
              hint: hintForMetaError({
                metaErrorCode: failed.metaErrorCode,
                metaErrorMessage: failed.metaErrorMessage,
                httpStatus: failed.httpStatus,
              }),
            }
          : null,
    });
  });

  return app;
}
