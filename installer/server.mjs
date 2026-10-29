// Мастер установки «Гайд в директ» (вход через Facebook).
// 1) временный токен из Graph API Explorer → вечный токен страницы + поиск Instagram;
// 2) развёртывание на Cloudflare (Queue, admin, Worker, D1, миграции, секреты);
// 3) уведомления о комментариях через API Meta (подписка приложения и страницы).
//
// Безопасность: только 127.0.0.1, одноразовый токен сессии и проверка Host; секреты
// уходят в wrangler через stdin, в лог не пишутся (redact), на диск не сохраняются.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E, W, classifyMetaError } from './errors.mjs';

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
const LOG_DIR = process.env.WIZARD_LOG_DIR || join(HERE, 'logs');
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
    return { ok: false, status: 0, data: null, error: `нет связи с Meta (${e.message})`, err: { network: true } };
  }
  const data = await res.json().catch(() => null);
  const error = data?.error ? `${data.error.message} (code ${data.error.code ?? '?'})` : null;
  log(`graph ${method} ${path} -> HTTP ${res.status}${error ? ` ${error}` : ''}`);
  return { ok: res.ok && !data?.error, status: res.status, data, error, err: data?.error ?? (res.ok ? null : { code: res.status }) };
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
// e — ошибка из каталога errors.mjs ({ what, todo, guide }) или просто текст.
function fail(i, e, out = '') {
  if (i >= 0) job.steps[i].status = 'fail';
  const err = typeof e === 'string' ? { what: e, todo: [], guide: null } : e;
  const raw = [out, err.raw].filter(Boolean).join('\n');
  job.error = { what: err.what, todo: err.todo ?? [], guide: err.guide ?? null, message: err.what, details: redact(strip(raw)).trim().slice(-3000) };
  job.running = false;
  log(`ОШИБКА: ${err.what}${raw ? ` | ${raw.slice(-500)}` : ''}`);
}

// Ошибка Graph API → запись каталога (или «непонятная» с сырым текстом).
function metaFail(i, r, fallback) {
  const kind = classifyMetaError(r.err);
  const e =
    kind === 'network' ? E.metaNetwork()
      : kind === 'secret' ? E.appSecretMismatch()
        : kind === 'otherApp' ? E.tokenOtherApp()
          : kind === 'token' ? E.tokenInvalid()
            : (fallback ?? E.metaUnknown());
  return fail(i, e, r.error ?? '');
}

// Где робот и ключ для проверки — рядом с программой (.runtime не попадает в git).
// После перезапуска мастера проверку можно запустить без повторной установки.
const SETUP_FILE = join(process.env.WIZARD_STATE_DIR || join(REPO, '.runtime'), 'setup.json');
function saveSetup(v) {
  mkdirSync(dirname(SETUP_FILE), { recursive: true });
  writeFileSync(SETUP_FILE, JSON.stringify(v), { mode: 0o600 });
}
function loadSetup() {
  try {
    const v = existsSync(SETUP_FILE) ? JSON.parse(readFileSync(SETUP_FILE, 'utf8')) : null;
    if (v?.setupToken) secretsSeen.add(v.setupToken);
    return v?.url && v?.setupToken ? v : null;
  } catch {
    return null;
  }
}

async function login() {
  newJob('login', ['Открываю вход в Cloudflare в браузере и жду, пока вы нажмёте Allow']);
  start(0);
  const r = await wrangler(['login'], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) return fail(0, E.cfLoginFailed(), r.out);
  ok(0, 'Вход выполнен');
  job.running = false;
}

async function checkMeta({ appId, appSecret, userToken }) {
  for (const s of [appSecret, userToken]) secretsSeen.add(s);
  newJob('meta', [
    'Проверяю ID и секрет приложения',
    'Проверяю токен из Explorer и его разрешения',
    'Меняю временный токен на долгий',
    'Ищу вашу страницу Facebook и привязанный Instagram',
  ]);
  meta = null;
  const appToken = `${appId}|${appSecret}`;

  // 0. ID + секрет: токен приложения работает только если они от одного приложения.
  start(0);
  const app = await graph('GET', appId, { fields: 'id,name', access_token: appToken });
  if (!app.ok) {
    const kind = classifyMetaError(app.err);
    return fail(0, kind === 'network' ? E.metaNetwork() : E.appSecretMismatch(), app.error ?? '');
  }
  ok(0, app.data?.name ? `Приложение «${app.data.name}»` : 'Подходят');

  // 1. Токен: живой, от этого же приложения, со всеми разрешениями — иначе дальше не пускаем.
  start(1);
  const dbg = await graph('GET', 'debug_token', { input_token: userToken, access_token: appToken });
  if (!dbg.ok) return metaFail(1, dbg, E.tokenInvalid());
  const info = dbg.data?.data ?? {};
  if (info.app_id && String(info.app_id) !== appId) return fail(1, E.tokenOtherApp(info.application), '');
  if (info.is_valid === false) return fail(1, E.tokenInvalid(), info.error?.message ?? '');
  const scopes = info.scopes ?? [];
  const missing = NEEDED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) return fail(1, E.scopesMissing(missing), `scopes: ${scopes.join(', ')}`);
  ok(1, 'Токен от этого приложения, все разрешения есть');

  start(2);
  const ex = await graph('GET', 'oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: userToken,
  });
  if (!ex.ok || !ex.data?.access_token) return metaFail(2, ex);
  const longUser = ex.data.access_token;
  secretsSeen.add(longUser);
  ok(2, 'Готово');

  start(3);
  const acc = await graph('GET', 'me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    access_token: longUser,
  });
  if (!acc.ok) return metaFail(3, acc);
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
  if (pages.size === 0) return fail(3, E.noPages(await diagnoseNoPages(appId, appSecret, longUser)));
  const withIg = [...pages.values()].filter((p) => p.ig?.id);
  if (withIg.length === 0) return fail(3, E.noInstagram());
  ok(3, withIg.map((p) => `${p.name} → @${p.ig.username}`).join(', '));

  meta = { appId, appSecret, pages, missing: [] };
  job.result = {
    pages: [...pages.entries()].map(([id, p]) => ({ id, name: p.name, ig: p.ig })),
    missing: [],
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
  if (!isLoggedIn(who)) return fail(0, E.cfNotLoggedIn(), who.out);
  ok(0, 'Вход есть');

  start(1);
  const q = await wrangler(['queues', 'create', 'ig-comment-events']);
  if (q.code !== 0 && !/already taken|already exists|11009/i.test(q.out)) return fail(1, E.cfQueue(), q.out);
  ok(1, q.code === 0 ? 'Создана' : 'Уже есть');

  start(2);
  // vite запускаем тем же node, без npm из системы: так одинаково работает на macOS и Windows.
  const b = await spawnRun(process.execPath, [process.env.WIZARD_VITE || join(REPO, 'admin/node_modules/vite/bin/vite.js'), 'build'], { cwd: join(REPO, 'admin') });
  if (b.code !== 0) return fail(2, E.adminBuild(), b.out);
  ok(2, 'Готово');

  start(3);
  const d = await wrangler(['deploy']);
  if (d.code !== 0 && /register a workers\.dev subdomain/i.test(d.out)) {
    const link = d.out.match(/https:\/\/dash\.cloudflare\.com\/\S+\/workers\/onboarding/)?.[0] ?? 'https://dash.cloudflare.com → Workers & Pages';
    return fail(3, E.cfSubdomain(link), d.out);
  }
  if (d.code !== 0) {
    return fail(3, E.cfDeploy(), d.out);
  }
  const url = workerUrlFrom(d.out);
  if (!url) return fail(3, E.cfDeploy(), d.out);
  ok(3, url);

  start(4);
  const idNote = await ensureDatabaseId('ig-comment-dm-db');
  const m = await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (m.code !== 0) return fail(4, E.dbMigrations(), m.out);
  ok(4, `ID базы ${idNote}; таблицы готовы`);

  start(5);
  const verifyToken = randomBytes(16).toString('hex');
  const sessionSecret = randomBytes(32).toString('base64');
  const setupToken = randomBytes(24).toString('hex');
  for (const s of [verifyToken, sessionSecret, setupToken]) secretsSeen.add(s);
  // Повторная установка не должна разлогинивать админку: ключ сессии оставляем, если он уже есть.
  const list = await wrangler(['secret', 'list']);
  const hasSession = /"name":\s*"ADMIN_SESSION_SECRET"/.test(list.out);
  const secrets = [
    ['INSTAGRAM_APP_SECRET', meta.appSecret],
    ['INSTAGRAM_ACCOUNT_ACCESS_TOKEN', page.token],
    ['WEBHOOK_VERIFY_TOKEN', verifyToken],
    ...(hasSession ? [] : [['ADMIN_SESSION_SECRET', sessionSecret]]),
    ['META_BASE_URL', 'https://graph.facebook.com'],
    ['SETUP_TOKEN', setupToken],
  ];
  for (const [name, value] of secrets) {
    const r = await wrangler(['secret', 'put', name], { input: value });
    if (r.code !== 0) return fail(5, E.secretPut(name), r.out);
  }
  ok(5, `Сохранено значений: ${secrets.length}`);
  job.result = { url, admin: `${url}/admin`, page: { name: page.name, ig: page.ig } };
  saveSetup({ url, setupToken });

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
  if (!verified) return fail(6, E.robotSilent(last));
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
  if (!sub.ok) return fail(7, E.subscribeFailed(), sub.error ?? '');
  ok(7, 'Instagram → comments → ваш робот');

  start(8);
  const ps = await graph('POST', `${pageId}/subscribed_apps`, { subscribed_fields: 'feed', access_token: page.token });
  if (!ps.ok) warnStep(8, `${W.pageSubscribe()} (Meta: ${ps.error})`);
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
  if (!app.ok) warnStep(9, `${W.appUpdate()} (Meta: ${app.error})`);
  else ok(9, `${url}/privacy`);

  job.running = false;
  log('=== установка закончена ===');
}

// ------------------------------------------------------------------ проверка «всё работает»

const CHECK_POLL_MS = Number(process.env.WIZARD_CHECK_POLL_MS || 4000);
const CHECK_WAIT_COMMENT_MS = Number(process.env.WIZARD_CHECK_WAIT_MS || 4 * 60_000);

async function diagnostics(setup, since) {
  const q = since ? `?since=${encodeURIComponent(since)}` : '';
  try {
    const res = await fetch(`${process.env.WIZARD_WORKER_BASE || setup.url}/api/setup/diagnostics${q}`, {
      headers: { Authorization: `Bearer ${setup.setupToken}` },
    });
    if (res.status === 404 || res.status === 401) return { old: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}

const RULE_TEXT = { exact_any: 'точно совпадает', contains_any: 'содержит', all_comments: 'любой комментарий' };

async function runCheck() {
  newJob('check', [
    'Связь с роботом',
    'Включённое правило',
    'Жду комментарий с другого аккаунта',
    'Робот разобрал комментарий',
    'Сообщение в директ',
    'Ответ под комментарием',
  ]);
  const setup = loadSetup();
  if (!setup) return fail(0, E.checkNotInstalled());

  start(0);
  const first = await diagnostics(setup);
  if (first.old) return fail(0, E.checkOldRobot());
  if (first.error) return fail(0, E.checkUnreachable(first.error));
  const d0 = first.data;
  ok(0, setup.url);

  start(1);
  if (d0.emergencyStop) return fail(1, E.checkEmergency());
  if (d0.account?.circuitBreakerStatus && d0.account.circuitBreakerStatus !== 'closed') return fail(1, E.checkCircuit());
  if (!d0.activeRules.length) return fail(1, E.checkNoRule());
  const rules = d0.activeRules;
  ok(1, rules.map((r) => `«${r.name}»: ${r.keywords.length ? r.keywords.map((k) => `«${k}»`).join(', ') : 'любой комментарий'} (${RULE_TEXT[r.matchType] ?? r.matchType})`).join('; '));

  // Всё, что пришло раньше начала проверки, не считаем.
  const since = d0.now;
  start(2);
  const word = rules.find((r) => r.keywords.length)?.keywords[0];
  job.steps[2].note = `Возьмите ДРУГОЙ аккаунт Instagram и напишите под постом ${word ? `«${word}»` : 'любой комментарий'}. Жду до ${Math.round(CHECK_WAIT_COMMENT_MS / 60000)} минут…`;
  const deadline = Date.now() + CHECK_WAIT_COMMENT_MS;
  let d;
  let event;
  while (Date.now() < deadline) {
    await sleep(CHECK_POLL_MS);
    const r = await diagnostics(setup, since);
    if (!r.data) continue;
    d = r.data;
    event = d.events.find((e) => e.type !== 'invalid_signature');
    if (event) break;
    if (d.events.some((e) => e.type === 'invalid_signature')) return fail(2, E.checkBadSignature());
  }
  if (!event) return fail(2, E.checkNoWebhook());
  ok(2, 'Комментарий дошёл до робота');

  // Ждём, пока робот обработает: статус события сменится, или появится запуск правила.
  start(3);
  const findRun = () => d.runs.find((r) => r.commentId === event.commentId);
  for (let i = 0; i < 30 && event.status === 'received' && !findRun(); i++) {
    await sleep(CHECK_POLL_MS);
    const r = await diagnostics(setup, since);
    if (!r.data) continue;
    d = r.data;
    event = d.events.find((e) => e.commentId === event.commentId) ?? event;
  }
  const st = event.status;
  if (st === 'no_match') return fail(3, E.checkNoMatch(rules));
  if (st === 'skipped:own_comment' || st === 'skipped:own_message') return fail(3, E.checkOwnComment());
  if (st === 'skipped:no_active_automation') return fail(3, E.checkNoRuleForPost());
  if (st === 'skipped:emergency_stop') return fail(3, E.checkEmergency());
  if (st === 'skipped:circuit_open') return fail(3, E.checkCircuit());
  if (st.startsWith('skipped:')) return fail(3, E.checkSkipped(st.slice(8)));
  if (!findRun()) return fail(3, E.checkSkipped('робот не успел обработать комментарий за 2 минуты'));
  ok(3, `Сработало правило на «${findRun().matchedKeyword ?? 'комментарий'}»`);

  // Сообщение и ответ: при временной ошибке Meta робот повторяет — подождём.
  start(4);
  for (let i = 0; i < 30 && ['pending', null].includes(findRun().privateReplyStatus); i++) {
    await sleep(CHECK_POLL_MS);
    const r = await diagnostics(setup, since);
    if (r.data) d = r.data;
  }
  const run = findRun();
  if (run.privateReplyStatus === 'success') ok(4, 'Ушло. Если тот аккаунт не подписан на вас — сообщение в папке «Запросы».');
  else if (run.privateReplyStatus === 'failed') return fail(4, E.checkDmFailed(d.lastProblem?.hint), d.lastProblem ? `(#${d.lastProblem.metaErrorCode}) ${d.lastProblem.metaErrorMessage}` : '');
  else if (run.privateReplyStatus === 'skipped') warnStep(4, 'Не отправлялось: в правиле выключено «Отправлять сообщение в директ» или достигнут лимит.');
  else warnStep(4, 'Meta пока не приняла сообщение, робот повторит сам. Проверьте директ через пару минут.');

  start(5);
  if (run.publicReplyStatus === 'success') ok(5, 'Ответ появился под комментарием');
  else if (run.publicReplyStatus === 'failed') warnStep(5, d.lastProblem?.hint ?? 'Meta не дала ответить под комментарием. Причина — на главной странице админки.');
  else if (run.publicReplyStatus === 'skipped') warnStep(5, 'Не отправлялся: выключен в правиле, или робот не стал писать «отправил», потому что директ не ушёл.');
  else warnStep(5, 'Ответ ещё в очереди — появится через минуту.');

  job.result = { ok: true };
  job.running = false;
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
    return json(res, 200, { loggedIn: isLoggedIn(who), email, metaReady: !!meta, installedUrl: loadSetup()?.url ?? null });
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
  if (u.pathname === '/api/check') {
    runCheck().catch((e) => fail(-1, `Мастер упал: ${e.message}`));
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
