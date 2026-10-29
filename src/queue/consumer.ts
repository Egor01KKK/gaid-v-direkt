// Queue Consumer 進入點：把 Cloudflare Queue batch 逐則餵給引擎，並依結果 ack / retry。
import type { MessageBatch } from '@cloudflare/workers-types';
import { eq } from 'drizzle-orm';
import type { AppBindings } from '../app';
import { processCommentEvent, processStoryReplyEvent, type EngineDeps, type EngineOutcome } from '../automation/engine';
import { webhookEvents } from '../database/schema';
import { MetaClient } from '../meta/client';
import type { CommentEventMessage } from './producer';

export async function consumeCommentEvents(
  batch: MessageBatch<CommentEventMessage>,
  env: AppBindings,
): Promise<void> {
  const { createDb } = await import('../database/client');
  const deps: EngineDeps = {
    db: createDb(env.DB),
    metaClient: new MetaClient({
      accessToken: env.INSTAGRAM_ACCOUNT_ACCESS_TOKEN,
      graphApiVersion: env.META_GRAPH_API_VERSION,
      // 與每日同步用同一個 host：Facebook Login 時公開回覆與 DM 也必須走 graph.facebook.com。
      baseUrl: env.META_BASE_URL || undefined,
    }),
  };

  for (const msg of batch.messages) {
    try {
      const outcome =
        msg.body.eventType === 'story_reply'
          ? await processStoryReplyEvent(deps, msg.body)
          : await processCommentEvent(deps, msg.body);
      if (outcome.kind === 'retry' && outcome.delaySeconds !== null) {
        msg.retry({ delaySeconds: outcome.delaySeconds });
      } else {
        await recordOutcome(deps, msg.body.webhookEventId, outcome);
        msg.ack();
      }
    } catch {
      // 未預期錯誤：交回 Queue 重試（Cloudflare 的 max_retries 上限保護）。
      msg.retry();
    }
  }
}

// Итог обработки пишем в webhook_events.status: по нему мастер установки и админка объясняют,
// почему комментарий не дал сообщения (свой аккаунт, слово не подошло, нет правила…).
export function outcomeStatus(outcome: EngineOutcome): string {
  if (outcome.kind === 'skipped') return `skipped:${outcome.reason}`;
  return outcome.kind;
}

async function recordOutcome(deps: EngineDeps, webhookEventId: string, outcome: EngineOutcome): Promise<void> {
  try {
    await deps.db
      .update(webhookEvents)
      .set({ status: outcomeStatus(outcome), processedAt: new Date().toISOString() })
      .where(eq(webhookEvents.id, webhookEventId));
  } catch {
    // Диагностика не должна мешать доставке.
  }
}
