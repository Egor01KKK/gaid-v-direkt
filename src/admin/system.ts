// 系統控制 Admin API（spec.md 第 16.3–16.5 節）：緊急停止/恢復、系統狀態。
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings } from '../app';
import { createDb } from '../database/client';
import { apiAttempts, auditLogs, automationRuns, instagramAccounts, systemSettings } from '../database/schema';
import { csrfMiddleware } from '../security/csrf';
import { adminApiRateLimitMiddleware } from '../security/rate-limit';
import { requireAdminAuth } from './auth';
import { LOCAL_UTC_OFFSET_MS } from '../shared/timezone';
import { hintForMetaError } from '../meta/error-hints';

const SETTINGS_ID = 'default';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureSettings(db: any) {
  const rows = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID)).limit(1);
  if (rows.length === 0) {
    await db.insert(systemSettings).values({ id: SETTINGS_ID, emergencyStop: 0 });
    return { id: SETTINGS_ID, emergencyStop: 0 };
  }
  return rows[0];
}

async function setEmergencyStop(
  env: AppBindings,
  adminUserId: string,
  ip: string | null,
  stop: boolean,
): Promise<void> {
  const db = createDb(env.DB);
  await ensureSettings(db);
  await db
    .update(systemSettings)
    .set({ emergencyStop: stop ? 1 : 0, updatedAt: new Date().toISOString() })
    .where(eq(systemSettings.id, SETTINGS_ID));
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    adminUserId,
    action: stop ? 'system.emergency_stop' : 'system.resume',
    entityType: 'system_settings',
    entityId: SETTINGS_ID,
    ipAddress: ip,
  });
}

export function createSystemRoutes() {
  const app = new Hono<{ Bindings: AppBindings; Variables: { adminUserId: string } }>();

  app.use('*', requireAdminAuth());

  // GET status（唯讀，不需 CSRF/限流以外的保護）
  app.get('/status', adminApiRateLimitMiddleware(), async (c) => {
    const db = createDb(c.env.DB);
    const settings = await ensureSettings(db);
    const accounts = await db.select().from(instagramAccounts).limit(1);

    // 「今日」以營運者當地時區（shared/timezone）為界——created_at 存 UTC ISO 字串，取當地當日 00:00
    // 對應的 UTC 時刻當下界後用字串比較（ISO UTC 字串的字典序＝時間序）。
    const localDay = new Date(Date.now() + LOCAL_UTC_OFFSET_MS).toISOString().slice(0, 10);
    const dayStartUtc = new Date(Date.parse(`${localDay}T00:00:00Z`) - LOCAL_UTC_OFFSET_MS).toISOString();

    const runs = await db.select().from(automationRuns);
    const todayRuns = runs.filter((r: { createdAt: string }) => r.createdAt >= dayStartUtc);

    // DM 趨勢序列（當地時區分桶）：日＝近 30 天、週＝近 12 週（週一起算）、月＝近 12 個月。
    // 計算都在「平移後的 UTC 時間軸」進行（平移當地時差後取 UTC 日/週/月界），避免本地時區干擾。
    const DAY_MS = 24 * 60 * 60 * 1000;
    const shiftedNow = Date.now() + LOCAL_UTC_OFFSET_MS;
    const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
    const weekStartMs = (ms: number) => {
      const d = new Date(ms);
      const startOfDay = Date.parse(`${dayKey(ms)}T00:00:00Z`);
      return startOfDay - (((d.getUTCDay() + 6) % 7) * DAY_MS); // 週一為每週起點
    };

    interface SeriesPoint {
      label: string;
      matched: number;
      dmSuccess: number;
      failures: number;
    }
    const bucketize = (keys: string[], keyOf: (shiftedMs: number) => string): SeriesPoint[] => {
      const points = new Map<string, SeriesPoint>(
        keys.map((label) => [label, { label, matched: 0, dmSuccess: 0, failures: 0 }]),
      );
      for (const r of runs) {
        const p = points.get(keyOf(Date.parse(r.createdAt) + LOCAL_UTC_OFFSET_MS));
        if (!p) continue;
        p.matched += 1;
        if (r.privateReplyStatus === 'success') p.dmSuccess += 1;
        if (r.status === 'completed_with_errors') p.failures += 1;
      }
      return keys.map((k) => points.get(k)!);
    };

    const todayStart = Date.parse(`${localDay}T00:00:00Z`);
    const dailyKeys = Array.from({ length: 30 }, (_, i) => dayKey(todayStart - (29 - i) * DAY_MS));
    const thisWeekStart = weekStartMs(shiftedNow);
    const weeklyKeys = Array.from({ length: 12 }, (_, i) => dayKey(thisWeekStart - (11 - i) * 7 * DAY_MS));
    const monthlyKeys = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(shiftedNow);
      return `${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (11 - i), 1)).toISOString().slice(0, 7)}`;
    });

    const series = {
      daily: bucketize(dailyKeys, (ms) => dayKey(ms)),
      weekly: bucketize(weeklyKeys, (ms) => dayKey(weekStartMs(ms))),
      monthly: bucketize(monthlyKeys, (ms) => monthKey(ms)),
    };
    const countStats = (rows: Array<{ publicReplyStatus: string | null; privateReplyStatus: string | null; status: string }>) => ({
      matched: rows.length,
      publicReplySuccess: rows.filter((r) => r.publicReplyStatus === 'success').length,
      dmSuccess: rows.filter((r) => r.privateReplyStatus === 'success').length,
      failures: rows.filter((r) => r.status === 'completed_with_errors').length,
    });

    return c.json({
      emergencyStop: settings.emergencyStop === 1,
      circuitBreakerStatus: accounts[0]?.circuitBreakerStatus ?? 'unknown',
      // 首頁 IG 個人頁式頁首用。
      account: accounts[0]
        ? { username: accounts[0].username, profilePictureUrl: accounts[0].profilePictureUrl }
        : null,
      tokenExpiresAt: accounts[0]?.tokenExpiresAt ?? null,
      lastWebhookReceivedAt: accounts[0]?.lastWebhookReceivedAt ?? null,
      today: countStats(todayRuns),
      total: countStats(runs),
      series,
    });
  });

  // GET last-problem：最近一次送出（公開回覆/DM）若失敗，回傳 Meta 錯誤與給管理者的俄文提示；
  // 最近一次成功或從未送出 → problem: null。
  app.get('/last-problem', adminApiRateLimitMiddleware(), async (c) => {
    const db = createDb(c.env.DB);
    const last = (
      await db.select().from(apiAttempts).orderBy(desc(apiAttempts.completedAt)).limit(1)
    )[0];
    if (!last || last.failureReason == null) return c.json({ problem: null });
    return c.json({
      problem: {
        at: last.completedAt,
        action: last.actionType,
        metaErrorCode: last.metaErrorCode,
        metaErrorMessage: last.metaErrorMessage,
        hint: hintForMetaError({
          metaErrorCode: last.metaErrorCode,
          metaErrorMessage: last.metaErrorMessage,
          httpStatus: last.httpStatus,
        }),
      },
    });
  });

  // 修改型：CSRF + 限流
  app.post('/emergency-stop', csrfMiddleware(), adminApiRateLimitMiddleware(), async (c) => {
    await setEmergencyStop(c.env, c.get('adminUserId'), c.req.header('CF-Connecting-IP') ?? null, true);
    return c.json({ ok: true, emergencyStop: true });
  });

  app.post('/resume', csrfMiddleware(), adminApiRateLimitMiddleware(), async (c) => {
    await setEmergencyStop(c.env, c.get('adminUserId'), c.req.header('CF-Connecting-IP') ?? null, false);
    return c.json({ ok: true, emergencyStop: false });
  });

  // 熔斷復歸：把帳號的熔斷狀態設回 closed（單帳號系統，直接更新全部帳號列）。
  app.post('/circuit-breaker/reset', csrfMiddleware(), adminApiRateLimitMiddleware(), async (c) => {
    const db = createDb(c.env.DB);
    await db
      .update(instagramAccounts)
      .set({ circuitBreakerStatus: 'closed', updatedAt: new Date().toISOString() });
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      adminUserId: c.get('adminUserId'),
      action: 'system.circuit_breaker_reset',
      entityType: 'instagram_accounts',
      ipAddress: c.req.header('CF-Connecting-IP') ?? null,
    });
    return c.json({ ok: true, circuitBreakerStatus: 'closed' });
  });

  return app;
}
