import { Hono } from 'hono';
import { createAdminRoutes } from './admin/routes';
import type { CommentEventMessage } from './queue/producer';
import { createWebhookRoutes } from './webhook/routes';

// Cloudflare 原生 Rate Limiting binding 的最小介面（wrangler 4.86 的 ratelimits）。
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type AppBindings = {
  DB: D1Database;
  COMMENT_QUEUE: Queue<CommentEventMessage>;
  ASSETS: Fetcher;
  ADMIN_RATE_LIMITER: RateLimiter;
  INSTAGRAM_APP_SECRET: string;
  WEBHOOK_VERIFY_TOKEN: string;
  INSTAGRAM_ACCOUNT_ACCESS_TOKEN: string;
  ADMIN_SESSION_SECRET: string;
  META_GRAPH_API_VERSION: string;
  META_BASE_URL?: string;
  APP_ENV: string;
  // 隱私政策頁的自訂聯絡方式（選填，純文字）。未設定時顯示通用文字，不點名任何身分。
  PRIVACY_CONTACT?: string;
  LOG_LEVEL: string;
};

export function createApp() {
  const app = new Hono<{ Bindings: AppBindings }>();

  // 根路徑導向後台登入頁。靜態資產的 index.html 在 / 會渲染空白（SPA base 是 /admin），
  // 因此 wrangler.jsonc 的 assets.run_worker_first 讓 / 先進 Worker、走這條 302。
  app.get('/', (c) => c.redirect('/admin', 302));

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  // 隱私政策頁（Meta App 上線審核要求提供公開網址）。
  // 聯絡方式預設只顯示通用文字，「不」點名任何身分：
  // - 管理者 Email 是登入憑證的一半，公開等於送攻擊者半組帳密、也成為釣魚目標。
  // - IG 帳號名會讓任何知道網址的訪客把這個部署連結到你的身分；而真正需要
  //   聯絡的人（收到私訊的留言者）本來就知道帳號是誰，不需要在此點名。
  // 部署者想提供具體聯絡管道時，設定 PRIVACY_CONTACT 變數（純文字，會做 HTML escape）。
  app.get('/privacy', (c) => {
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const custom = c.env.PRIVACY_CONTACT?.trim();
    const contactHtml = custom
      ? escapeHtml(custom)
      : 'Напишите нам в директ Instagram-аккаунта, к которому подключён этот сервис (если вы уже получили от него сообщение — просто ответьте в этот диалог).';
    return c.html(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Политика конфиденциальности</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.7;color:#0f172a}h1{font-size:24px}h2{font-size:17px;margin-top:28px}p,li{font-size:15px;color:#334155}</style></head><body>
<h1>Политика конфиденциальности</h1>
<p>Этот сервис — инструмент автоматических ответов на комментарии в Instagram, которым пользуется один владелец аккаунта для своего аккаунта.</p>
<h2>Какие данные обрабатываются и зачем</h2>
<ul>
<li>Сервис обрабатывает только публичные комментарии, которые вы сами оставили под постами владельца аккаунта (текст комментария, публичное имя и ID комментатора), и только для того, чтобы по ключевому слову один раз ответить под комментарием и отправить одно сообщение в директ.</li>
<li>Сервис не добавляет комментаторов в рекламные списки, не делает рассылок и не передаёт данные третьим лицам.</li>
</ul>
<h2>Хранение и удаление данных</h2>
<ul>
<li>События комментариев и журнал срабатываний хранятся только в базе данных, которую развернул владелец аккаунта, и используются как журнал работы.</li>
<li>Чтобы удалить данные о вас, напишите нам способом, указанным ниже, — мы удалим их в разумный срок.</li>
</ul>
<h2>Контакты</h2>
<p>${contactHtml}</p>
<p>Обновлено: 2026-10-29</p>
</body></html>`);
  });

  app.route('/api/admin', createAdminRoutes());
  app.route('/api/webhooks', createWebhookRoutes());

  // 管理後台 SPA（React）由 ASSETS binding 提供。ASSETS 目錄對應網址根目錄，但前端
  // build base 是 /admin/，因此在此把 /admin 前綴映射到實際 asset 路徑：
  // - /admin/assets/xxx → 去掉 /admin 前綴取檔案
  // - /admin 或其他前端路由 → 回傳 index.html（SPA client-side routing）
  app.get('/admin', (c) =>
    c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url))),
  );
  app.get('/admin/*', (c) => {
    const url = new URL(c.req.url);
    const stripped = url.pathname.replace(/^\/admin/, '') || '/';
    const isFile = /\.[a-zA-Z0-9]+$/.test(stripped);
    const target = isFile ? stripped : '/index.html';
    return c.env.ASSETS.fetch(new Request(new URL(target, url.origin)));
  });

  return app;
}
