// Мастер установки «Гайд в директ» (вход через Facebook).
// 1) временный токен из Graph API Explorer → вечный токен страницы + поиск Instagram;
// 2) развёртывание на Cloudflare (Queue, admin, Worker, D1, миграции, секреты);
// 3) уведомления о комментариях через API Meta (подписка приложения и страницы).
//
// Безопасность: только 127.0.0.1, одноразовый токен сессии и проверка Host; секреты
// уходят в wrangler через stdin, в лог не пишутся (redact), на диск не сохраняются.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WRANGLER = process.env.WIZARD_WRANGLER || join(REPO, 'node_modules/wrangler/bin/wrangler.js');
const GRAPH = process.env.WIZARD_GRAPH || 'https://graph.facebook.com';
const GRAPH_VERSION = 'v21.0'; // та же версия, что в wrangler.jsonc у робота
const PORT = Number(process.env.WIZARD_PORT || 4546);
// WIZARD_SESSION_TOKEN — чтобы после перезапуска мастера старая ссылка продолжала работать.
const TOKEN = /^[0-9a-f]{32}$/.test(process.env.WIZARD_SESSION_TOKEN ?? '')
  ? process.env.WIZARD_SESSION_TOKEN
  : randomBytes(16).toString('hex');
const LOG_DIR = join(HERE, 'logs');
const LOG = join(LOG_DIR, `install-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
mkdirSync(LOG_DIR, { recursive: true });

const NEEDED_SCOPES = [
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
];

const secretsSeen = new Set();
function redact(text) {
  let out = String(text);
  for (const s of secretsSeen) if (s && s.length >= 6) out = out.split(s).join('<скрыто>');
  return out
    .replace(/access_token=[^&\s"]+/g, 'access_token=<скрыто>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
}
function log(line) {
  appendFileSync(LOG, `${new Date().toISOString()} ${redact(line)}\n`);
}

function spawnRun(cmd, args, { input, timeoutMs = 5 * 60_000, cwd = REPO } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`${cmd === process.execPath ? 'wrangler' : cmd} ${args.filter((a) => a !== WRANGLER).join(' ')} -> exit ${code}\n${out.trim()}\n---`);
      done({ code, out });
    };
    const timer = setTimeout(() => {
      out += '\n[мастер] команда не уложилась во время и остановлена';
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      out += err.message;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
const wrangler = (args, opts) => spawnRun(process.execPath, [WRANGLER, ...args], opts);

// Запрос к Graph API. Токены идут параметрами, поэтому URL в лог не пишем, только путь.
async function graph(method, path, params = {}) {
  const url = new URL(`${GRAPH}/${GRAPH_VERSION}/${path}`);
  let body;
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else body = new URLSearchParams(params);
  let res;
  try {
    res = await fetch(url, { method, body });
  } catch (e) {
    log(`graph ${method} ${path} -> network error ${e}`);
    return { ok: false, status: 0, data: null, error: `нет связи с Meta (${e.message})` };
  }
  const data = await res.json().catch(() => null);
  const error = data?.error ? `${data.error.message} (code ${data.error.code ?? '?'})` : null;
  log(`graph ${method} ${path} -> HTTP ${res.status}${error ? ` ${error}` : ''}`);
  return { ok: res.ok && !data?.error, status: res.status, data, error };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s) => s.replace(ANSI, '');
const isLoggedIn = (r) => r.code === 0 && !/not authenticated|not logged in/i.test(r.out);
const workerUrlFrom = (text) => text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi)?.pop() ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// То же, что ensureDatabaseId в scripts/deploy.mjs: без database_id миграции не найдут базу.
async function ensureDatabaseId(dbName) {
  const file = join(REPO, 'wrangler.jsonc');
  const cfg = readFileSync(file, 'utf8');
  const nameIdx = cfg.indexOf(`"database_name": "${dbName}"`);
  if (nameIdx === -1 || cfg.slice(nameIdx, nameIdx + 200).includes('"database_id"')) return 'уже указан';
  const r = await wrangler(['d1', 'list', '--json']);
  let found;
  try {
    found = JSON.parse(r.out.slice(r.out.indexOf('['))).find((d) => d.name === dbName);
  } catch {
    found = null;
  }
  if (!found) return 'не найден';
  const lineStart = cfg.lastIndexOf('\n', nameIdx) + 1;
  const indent = cfg.slice(lineStart, nameIdx);
  const insertAt = cfg.indexOf('\n', nameIdx);
  writeFileSync(file, cfg.slice(0, insertAt) + `\n${indent}"database_id": "${found.uuid}",` + cfg.slice(insertAt));
  return 'записан в wrangler.jsonc';
}

// ------------------------------------------------------------------ состояние

let job = null;
let meta = null; // { appId, appSecret, pages: Map<pageId, {name, token, ig}>, scopes, missing }

function newJob(kind, titles) {
  job = { kind, running: true, steps: titles.map((title) => ({ title, status: 'wait', note: '' })), result: null, error: null };
}
const start = (i) => (job.steps[i].status = 'run');
function ok(i, note = '') {
  job.steps[i].status = 'ok';
  job.steps[i].note = note;
}
function warnStep(i, note) {
  job.steps[i].status = 'warn';
  job.steps[i].note = note;
}
function fail(i, message, out = '') {
  if (i >= 0) job.steps[i].status = 'fail';
  job.error = { message, details: redact(strip(out)).trim().slice(-3000) };
  job.running = false;
  log(`ОШИБКА: ${message}`);
}

async function login() {
  newJob('login', ['Открываю вход в Cloudflare в браузере и жду, пока вы нажмёте Allow']);
  start(0);
  const r = await wrangler(['login'], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) return fail(0, 'Вход в Cloudflare не завершился. Попробуйте ещё раз.', r.out);
  ok(0, 'Вход выполнен');
  job.running = false;
}

async function checkMeta({ appId, appSecret, userToken }) {
  for (const s of [appSecret, userToken]) secretsSeen.add(s);
  newJob('meta', [
    'Меняю временный токен на долгий',
    'Ищу ваши страницы Facebook и привязанный Instagram',
    'Проверяю выданные разрешения',
  ]);
  meta = null;

  start(0);
  const ex = await graph('GET', 'oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: userToken,
  });
  if (!ex.ok || !ex.data?.access_token) {
    return fail(0, `Meta не приняла токен или секрет: ${ex.error ?? 'нет токена в ответе'}. Проверьте, что секрет и токен — от одного и того же приложения Meta, а токен сгенерирован только что.`);
  }
  const longUser = ex.data.access_token;
  secretsSeen.add(longUser);
  ok(0, 'Готово');

  start(1);
  const acc = await graph('GET', 'me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    access_token: longUser,
  });
  if (!acc.ok) return fail(1, `Не удалось получить список страниц: ${acc.error}`);
  const pages = new Map();
  const addPage = (p) => {
    if (!p?.id || pages.has(p.id)) return;
    if (p.access_token) secretsSeen.add(p.access_token);
    pages.set(p.id, { name: p.name, token: p.access_token, ig: p.instagram_business_account ?? null });
  };
  for (const p of acc.data?.data ?? []) addPage(p);
  // Страницы бизнес-портфолио в me/accounts не попадают, если человек управляет ими
  // через портфолио, а не напрямую.
  if (pages.size === 0) {
    const biz = await graph('GET', 'me/businesses', {
      fields: 'id,name,owned_pages{id,name,access_token,instagram_business_account{id,username}}',
      access_token: longUser,
    });
    for (const b of biz.data?.data ?? []) for (const p of b.owned_pages?.data ?? []) addPage(p);
  }
  if (pages.size === 0) {
    const why = await diagnoseNoPages(appId, appSecret, longUser);
    return fail(1, why);
  }
  const withIg = [...pages.values()].filter((p) => p.ig?.id);
  if (withIg.length === 0) {
    return fail(1, 'Ни к одной из ваших страниц Facebook не привязан профессиональный Instagram. Привяжите Instagram к странице (Instagram → Настройки → Центр аккаунтов / Профессиональный аккаунт → Страница) или в окне Facebook при выдаче токена отметьте и Instagram-аккаунт.');
  }
  ok(1, withIg.map((p) => `${p.name} → @${p.ig.username}`).join(', '));

  start(2);
  const dbg = await graph('GET', 'debug_token', { input_token: longUser, access_token: `${appId}|${appSecret}` });
  const scopes = dbg.data?.data?.scopes ?? [];
  const missing = NEEDED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) warnStep(2, `Не хватает: ${missing.join(', ')}. Добавьте их в Explorer и сгенерируйте токен заново.`);
  else ok(2, 'Все нужные разрешения есть');

  meta = { appId, appSecret, pages, missing };
  job.result = {
    pages: [...pages.entries()].map(([id, p]) => ({ id, name: p.name, ig: p.ig })),
    missing,
  };
  job.running = false;
}

// Почему Meta не дала ни одной страницы: смотрим, к каким страницам и Instagram-аккаунтам
// человек дал доступ в окне Facebook (granular_scopes) и какие разрешения отклонены.
async function diagnoseNoPages(appId, appSecret, userToken) {
  const dbg = await graph('GET', 'debug_token', { input_token: userToken, access_token: `${appId}|${appSecret}` });
  const gran = dbg.data?.data?.granular_scopes ?? [];
  const targets = (scope) => gran.find((g) => g.scope === scope)?.target_ids ?? [];
  const pageIds = [...new Set([...targets('pages_show_list'), ...targets('pages_read_engagement')])];
  const igIds = targets('instagram_basic');
  const perms = await graph('GET', 'me/permissions', { access_token: userToken });
  const declined = (perms.data?.data ?? []).filter((p) => p.status !== 'granted').map((p) => p.permission);
  log(`diagnose: pages=${pageIds.length} ig=${igIds.length} declined=${declined.join(',')}`);

  const parts = [];
  if (declined.length) parts.push(`Отклонены разрешения: ${declined.join(', ')}.`);
  if (pageIds.length === 0 && igIds.length === 0 && declined.length === 0) {
    parts.push(
      'Все разрешения выданы, но у этого аккаунта Facebook нет ни одной страницы и ни одного привязанного Instagram. Привяжите Instagram к странице Facebook этого же аккаунта (в приложении Instagram: Профиль → Редактировать профиль → Страница → Подключить или создать), затем сгенерируйте токен заново.',
    );
  } else if (pageIds.length === 0) {
    parts.push(
      'В окне Facebook не выбрана ни одна страница. Нажмите Generate Access Token ещё раз; когда Facebook спросит «Какие Страницы…», нажмите «Изменить настройки» / «Выбрать», поставьте галочку на свою страницу и Instagram.',
    );
    parts.push(
      'Если в этом окне нет ни одной страницы — значит, у вас нет страницы Facebook. Её нужно создать и привязать к ней Instagram (Instagram → Настройки → Центр аккаунтов). Как это сделать — в шаге 0 этого мастера.',
    );
  } else {
    parts.push(`Доступ дан к страницам: ${pageIds.length}, к Instagram: ${igIds.length}, но Meta не отдала их список. Сгенерируйте токен ещё раз и на экранах Facebook отметьте свою страницу и Instagram.`);
  }
  return parts.join(' ');
}

async function install({ pageId }) {
  if (!meta) return;
  const page = meta.pages.get(pageId);
  const T = [
    'Проверяю вход в Cloudflare',
    'Создаю очередь сообщений (Queue)',
    'Собираю админку',
    'Выкладываю робота и создаю базу данных',
    'Подключаю базу и создаю таблицы',
    'Сохраняю ключи и токен страницы в Cloudflare',
    'Жду, пока робот ответит',
    'Включаю уведомления о комментариях в Meta',
    'Подписываю страницу на приложение',
    'Вписываю в приложение Meta политику конфиденциальности и сайт',
  ];
  newJob('install', T);
  log('=== установка начата ===');

  start(0);
  const who = await wrangler(['whoami']);
  if (!isLoggedIn(who)) return fail(0, 'Вы не вошли в Cloudflare. Нажмите «Войти в Cloudflare» и повторите.', who.out);
  ok(0, 'Вход есть');

  start(1);
  const q = await wrangler(['queues', 'create', 'ig-comment-events']);
  ok(1, q.code === 0 ? 'Создана' : 'Уже есть');

  start(2);
  // vite запускаем тем же node, без npm из системы: так одинаково работает на macOS и Windows.
  const b = await spawnRun(process.execPath, [join(REPO, 'admin/node_modules/vite/bin/vite.js'), 'build'], { cwd: join(REPO, 'admin') });
  if (b.code !== 0) return fail(2, 'Админка не собралась.', b.out);
  ok(2, 'Готово');

  start(3);
  const d = await wrangler(['deploy']);
  if (d.code !== 0 && /register a workers\.dev subdomain/i.test(d.out)) {
    const link = d.out.match(/https:\/\/dash\.cloudflare\.com\/\S+\/workers\/onboarding/)?.[0] ?? 'https://dash.cloudflare.com → Workers & Pages';
    return fail(3, `У аккаунта Cloudflare ещё нет адреса на workers.dev. Откройте ${link}, выберите поддомен (часть адреса робота, будет публичной) и нажмите «Установить» ещё раз.`, d.out);
  }
  if (d.code !== 0) {
    return fail(3, 'Выкладка не удалась. Частая причина: в Cloudflare ещё ни разу не открывали Workers — откройте dash.cloudflare.com → Workers & Pages и повторите.', d.out);
  }
  const url = workerUrlFrom(d.out);
  if (!url) return fail(3, 'Робот выложен, но мастер не нашёл его адрес в ответе Cloudflare.', d.out);
  ok(3, url);

  start(4);
  const idNote = await ensureDatabaseId('ig-comment-dm-db');
  const m = await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (m.code !== 0) return fail(4, 'Не получилось создать таблицы.', m.out);
  ok(4, `ID базы ${idNote}; таблицы готовы`);

  start(5);
  const verifyToken = randomBytes(16).toString('hex');
  const sessionSecret = randomBytes(32).toString('base64');
  for (const s of [verifyToken, sessionSecret]) secretsSeen.add(s);
  // Повторная установка не должна разлогинивать админку: ключ сессии оставляем, если он уже есть.
  const list = await wrangler(['secret', 'list']);
  const hasSession = /"name":\s*"ADMIN_SESSION_SECRET"/.test(list.out);
  const secrets = [
    ['INSTAGRAM_APP_SECRET', meta.appSecret],
    ['INSTAGRAM_ACCOUNT_ACCESS_TOKEN', page.token],
    ['WEBHOOK_VERIFY_TOKEN', verifyToken],
    ...(hasSession ? [] : [['ADMIN_SESSION_SECRET', sessionSecret]]),
    ['META_BASE_URL', 'https://graph.facebook.com'],
  ];
  for (const [name, value] of secrets) {
    const r = await wrangler(['secret', 'put', name], { input: value });
    if (r.code !== 0) return fail(5, `Не получилось сохранить ${name}.`, r.out);
  }
  ok(5, `Сохранено значений: ${secrets.length}`);
  job.result = { url, admin: `${url}/admin`, page: { name: page.name, ig: page.ig } };

  start(6);
  // Секреты расходятся по Cloudflare не мгновенно (README 01: ~30 с), поэтому ждём,
  // пока робот ответит на проверку webhook нашим токеном — её же сделает Meta.
  let verified = false;
  let last = '';
  for (let i = 0; i < 18 && !verified; i++) {
    try {
      const res = await fetch(
        `${process.env.WIZARD_WORKER_BASE || url}/api/webhooks/meta/instagram?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=4242`,
      );
      const text = await res.text();
      last = `HTTP ${res.status}`;
      verified = res.status === 200 && text.trim() === '4242';
    } catch (e) {
      last = String(e);
    }
    if (!verified) await sleep(5000);
  }
  log(`verify self-check: ${verified} ${last}`);
  if (!verified) return fail(6, `Робот не ответил на проверку за 90 секунд (${last}). Нажмите «Установить» ещё раз.`);
  ok(6, 'Робот отвечает');

  start(7);
  // Cloudflare раскатывает новую версию по миру несколько секунд: наш запрос уже видит новый
  // ключ проверки, а Meta (из США) может ещё попасть на старую версию и получить 403 (#2200).
  // Поэтому при #2200 ждём и повторяем.
  let sub;
  for (let attempt = 1; attempt <= 12; attempt++) {
    sub = await graph('POST', `${meta.appId}/subscriptions`, {
      object: 'instagram',
      callback_url: `${url}/api/webhooks/meta/instagram`,
      fields: 'comments',
      verify_token: verifyToken,
      include_values: 'true',
      access_token: `${meta.appId}|${meta.appSecret}`,
    });
    if (sub.ok || !/\b2200\b/.test(sub.error ?? '')) break;
    job.steps[7].note = `Meta ещё видит старую версию робота — жду и пробую снова (${attempt} из 12)…`;
    await sleep(Number(process.env.WIZARD_RETRY_MS || 10_000));
  }
  if (!sub.ok) return fail(7, `Meta не включила уведомления: ${sub.error}. Подождите минуту и нажмите «Установить робота» ещё раз.`);
  ok(7, 'Instagram → comments → ваш робот');

  start(8);
  const ps = await graph('POST', `${pageId}/subscribed_apps`, { subscribed_fields: 'feed', access_token: page.token });
  if (!ps.ok) warnStep(8, `Meta ответила: ${ps.error}. Сохраните этот текст — он поможет разобраться.`);
  else ok(8, 'Готово');

  // Без политики конфиденциальности Meta не даёт перевести приложение в рабочий режим.
  // Категорию и ссылку удаления данных API не меняет — их владелец ставит руками (шаг 5 мастера).
  start(9);
  const app = await graph('POST', meta.appId, {
    privacy_policy_url: `${url}/privacy`,
    website_url: url,
    app_domains: JSON.stringify([new URL(url).host]),
    access_token: `${meta.appId}|${meta.appSecret}`,
  });
  if (!app.ok) warnStep(9, `Не получилось (${app.error}). Впишите ссылку на политику руками — шаг 5.`);
  else ok(9, `${url}/privacy`);

  job.running = false;
  log('=== установка закончена ===');
}

// ------------------------------------------------------------------ HTTP

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((done) => {
    let b = '';
    req.on('data', (d) => {
      b += d;
      if (b.length > 20_000) req.destroy();
    });
    req.on('end', () => {
      try {
        done(JSON.parse(b || '{}'));
      } catch {
        done({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return json(res, 403, { error: 'host' });
  const u = new URL(req.url, `http://${host}`);

  if (req.method === 'GET' && u.pathname === '/') {
    if (u.searchParams.get('t') !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Откройте мастер заново: двойной щелчок по «Установить».');
    }
    const html = readFileSync(join(HERE, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'Referrer-Policy': 'no-referrer',
    });
    return res.end(html);
  }

  if (!u.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (req.headers['x-wizard-token'] !== TOKEN) return json(res, 403, { error: 'token' });

  if (req.method === 'GET' && u.pathname === '/api/status') {
    const who = await wrangler(['whoami']);
    const email = who.out.match(/associated with the email (\S+@\S+?)\.?\s/i)?.[1] ?? null;
    return json(res, 200, { loggedIn: isLoggedIn(who), email, metaReady: !!meta });
  }
  if (req.method === 'GET' && u.pathname === '/api/job') return json(res, 200, job ?? {});
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  if (job?.running) return json(res, 409, { error: 'Уже идёт другое действие — дождитесь его конца.' });

  if (u.pathname === '/api/login') {
    login();
    return json(res, 202, { ok: true });
  }
  if (u.pathname === '/api/meta') {
    const b = await readBody(req);
    const appId = String(b.appId || '').trim();
    const appSecret = String(b.appSecret || '').trim();
    const userToken = String(b.userToken || '').trim();
    if (!/^\d{6,25}$/.test(appId)) return json(res, 400, { error: 'ID приложения — только цифры.' });
    if (!/^[0-9a-f]{32}$/i.test(appSecret)) return json(res, 400, { error: 'Секрет приложения — 32 символа из цифр и букв a–f.' });
    if (!/^EA[A-Za-z0-9]{40,}$/.test(userToken)) {
      return json(res, 400, { error: 'Это не похоже на токен из Explorer: он начинается с «EA» и очень длинный. Скопируйте его кнопкой справа от поля «Маркер доступа».' });
    }
    checkMeta({ appId, appSecret, userToken }).catch((e) => fail(-1, `Мастер упал: ${e.message}`));
    return json(res, 202, { ok: true });
  }
  if (u.pathname === '/api/install') {
    const b = await readBody(req);
    if (!meta) return json(res, 400, { error: 'Сначала шаг 2: проверка токена.' });
    const page = meta.pages.get(String(b.pageId || ''));
    if (!page?.ig?.id) return json(res, 400, { error: 'Выберите страницу, к которой привязан Instagram.' });
    install({ pageId: String(b.pageId) }).catch((e) => fail(-1, `Мастер упал: ${e.message}`));
    return json(res, 202, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`мастер запущен на 127.0.0.1:${PORT}`);
  console.log(`\nМастер установки запущен:\n\n  http://127.0.0.1:${PORT}/?t=${TOKEN}\n`);
});
