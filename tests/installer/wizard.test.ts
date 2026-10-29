// Тесты мастера установки: на каждую известную ошибку — понятный русский текст и шаг гайда.
// Мастер запускается настоящим процессом; Meta, Cloudflare (wrangler) и робот — поддельные.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(__dirname, '../..');
const APP_ID = '1234567890';
const SECRET = 'abcdefabcdefabcdefabcdefabcdefab';
const USER_TOKEN = 'EAA' + 'u'.repeat(60);
const ALL_SCOPES = [
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'business_management',
];

type Json = Record<string, unknown>;
type Reply = { status?: number; body: Json };
const ok = (body: Json): Reply => ({ body });
const metaErr = (code: number, message: string, status = 400): Reply => ({ status, body: { error: { code, message } } });

// Поведение поддельной Meta по умолчанию — «всё правильно»; тест меняет нужный кусок.
interface Scenario {
  app: () => Reply;
  debug: () => Reply;
  exchange: () => Reply;
  accounts: () => Reply;
  subscriptionFailures: number;
  subscribeError?: Reply;
  pageSubscribe: () => Reply;
  diagnostics: Json[];
}
function defaultScenario(): Scenario {
  return {
    app: () => ok({ id: APP_ID, name: 'Гайд в директ' }),
    debug: () => ok({ data: { app_id: APP_ID, application: 'Гайд в директ', is_valid: true, scopes: ALL_SCOPES } }),
    exchange: () => ok({ access_token: 'EAA' + 'L'.repeat(60) }),
    accounts: () =>
      ok({ data: [{ id: 'p1', name: 'Моя страница', access_token: 'EAA' + 'P'.repeat(60), instagram_business_account: { id: '17841', username: 'egor' } }] }),
    subscriptionFailures: 0,
    pageSubscribe: () => ok({ success: true }),
    diagnostics: [],
  };
}

let sc: Scenario;
let graphServer: http.Server;
let robotServer: http.Server;
let wizard: ChildProcess | null = null;
let tmp: string;
let diagCalls = 0;

function listen(handler: http.RequestListener): Promise<[http.Server, number]> {
  return new Promise((done) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => done([s, (s.address() as AddressInfo).port]));
  });
}
function send(res: http.ServerResponse, r: Reply) {
  res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(r.body));
}

let graphPort = 0;
let robotPort = 0;

beforeEach(async () => {
  sc = defaultScenario();
  diagCalls = 0;
  tmp = mkdtempSync(join(tmpdir(), 'gvd-wizard-'));
  [graphServer, graphPort] = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    if (req.method === 'GET' && p === APP_ID) return send(res, sc.app());
    if (p === 'debug_token') return send(res, sc.debug());
    if (p === 'oauth/access_token') return send(res, sc.exchange());
    if (p === 'me/accounts') return send(res, sc.accounts());
    if (p === 'me/businesses' || p === 'me/permissions') return send(res, ok({ data: [] }));
    if (p === `${APP_ID}/subscriptions`) {
      if (sc.subscribeError) return send(res, sc.subscribeError);
      if (sc.subscriptionFailures-- > 0) return send(res, metaErr(2200, 'Callback verification failed with the following errors: HTTP Status Code = 403'));
      return send(res, ok({ success: true }));
    }
    if (p.endsWith('/subscribed_apps')) return send(res, sc.pageSubscribe());
    if (req.method === 'POST' && p === APP_ID) return send(res, ok({ success: true }));
    send(res, metaErr(1, `unknown ${p}`));
  });
  [robotServer, robotPort] = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/api/webhooks/meta/instagram') return res.end(u.searchParams.get('hub.challenge') ?? '');
    if (u.pathname === '/api/setup/diagnostics') {
      const list = sc.diagnostics;
      const body = list[Math.min(diagCalls++, list.length - 1)];
      if (!body) return send(res, { status: 404, body: {} });
      return send(res, ok(body));
    }
    res.writeHead(404).end();
  });
});

afterEach(async () => {
  wizard?.kill();
  wizard = null;
  await new Promise((r) => graphServer.close(r));
  await new Promise((r) => robotServer.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const SESSION = '0123456789abcdef0123456789abcdef';
let wizardPort = 0;

async function startWizard(wranglerMode = '') {
  wizardPort = 20000 + Math.floor(Math.random() * 20000);
  wizard = spawn(process.execPath, [join(ROOT, 'installer/server.mjs')], {
    env: {
      ...process.env,
      WIZARD_PORT: String(wizardPort),
      WIZARD_SESSION_TOKEN: SESSION,
      WIZARD_GRAPH: `http://127.0.0.1:${graphPort}`,
      WIZARD_WORKER_BASE: `http://127.0.0.1:${robotPort}`,
      WIZARD_WRANGLER: join(__dirname, 'fake-wrangler.mjs'),
      WIZARD_VITE: join(__dirname, 'fake-vite.cjs'),
      WIZARD_LOG_DIR: join(tmp, 'logs'),
      WIZARD_STATE_DIR: join(tmp, 'state'),
      WIZARD_RETRY_MS: '20',
      WIZARD_CHECK_POLL_MS: '20',
      WIZARD_CHECK_WAIT_MS: '600',
      FAKE_WRANGLER_STATE: join(tmp, 'wrangler.json'),
      FAKE_WRANGLER_MODE: wranglerMode,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await api('/api/job');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('wizard did not start');
}

async function api(path: string, body?: Json) {
  const res = await fetch(`http://127.0.0.1:${wizardPort}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Wizard-Token': SESSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

interface Job {
  steps: { title: string; status: string; note: string }[];
  error: { what: string; todo: string[]; guide: string | null; details: string } | null;
  result: Json | null;
}
async function waitJob(): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const j = (await api('/api/job')).body as unknown as Job & { running: boolean };
    if (j.steps && !j.running) return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
}

async function checkMeta(fields: Partial<{ appId: string; appSecret: string; userToken: string }> = {}) {
  const r = await api('/api/meta', { appId: APP_ID, appSecret: SECRET, userToken: USER_TOKEN, ...fields });
  if (r.status !== 202) return { rejected: r.body.error as string };
  return { job: await waitJob() };
}
async function install() {
  await checkMeta();
  await api('/api/install', { pageId: 'p1' });
  return waitJob();
}

// Главная ошибка — всегда по-русски и с шагами, сырой английский — только в подробностях.
function expectHumanError(j: Job, whatPart: string, guide: string) {
  expect(j.error).not.toBeNull();
  expect(j.error!.what).toContain(whatPart);
  expect(j.error!.what).toMatch(/[а-яё]/i);
  expect(j.error!.todo.length).toBeGreaterThan(0);
  expect(j.error!.guide).toContain(guide);
}

describe('мастер: поля до проверки', () => {
  beforeEach(() => startWizard());

  it('ID с буквами', async () => {
    expect((await checkMeta({ appId: 'abc' })).rejected).toContain('только цифры');
  });
  it('секрет не той длины', async () => {
    expect((await checkMeta({ appSecret: 'short' })).rejected).toContain('32 символа');
  });
  it('в поле токена вставили не токен', async () => {
    expect((await checkMeta({ userToken: 'hello' })).rejected).toContain('начинается с «EA»');
  });
});

describe('мастер: проверка Meta', () => {
  beforeEach(() => startWizard());

  it('всё правильно — показывает страницу и Instagram', async () => {
    const { job } = await checkMeta();
    expect(job.error).toBeNull();
    expect(job.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(job.result).toMatchObject({ pages: [{ id: 'p1', ig: { username: 'egor' } }] });
  });

  it('ID и секрет от разных приложений', async () => {
    sc.app = () => metaErr(190, 'Invalid OAuth access token signature.');
    const { job } = await checkMeta();
    expectHumanError(job!, 'ID приложения и секрет не подходят', 'Шаг 7');
    expect(job!.error!.details).toContain('Invalid OAuth');
  });

  it('нет интернета / Meta заблокирована', async () => {
    graphServer.close();
    graphServer.closeAllConnections();
    const { job } = await checkMeta();
    expectHumanError(job!, 'не может связаться с Meta', 'Шаг 7');
    expect(job!.error!.todo.join(' ')).toContain('VPN');
  });

  it('токен от другого приложения (ошибка Meta)', async () => {
    sc.debug = () => metaErr(100, 'The App_id in the input_token did not match the Viewing App');
    const { job } = await checkMeta();
    expectHumanError(job!, 'для другого приложения', 'Шаг 7б');
  });

  it('токен от другого приложения (другой app_id)', async () => {
    sc.debug = () => ok({ data: { app_id: '999', application: 'тест гайда', is_valid: true, scopes: ALL_SCOPES } });
    const { job } = await checkMeta();
    expectHumanError(job!, '«тест гайда»', 'Шаг 7б');
  });

  it('токен устарел', async () => {
    sc.debug = () => ok({ data: { app_id: APP_ID, is_valid: false, error: { code: 190, message: 'Session has expired' } } });
    const { job } = await checkMeta();
    expectHumanError(job!, 'устарел', 'Шаг 7б');
  });

  it('не хватает разрешений — не пускает дальше и говорит, в каком разделе Explorer', async () => {
    sc.debug = () => ok({ data: { app_id: APP_ID, is_valid: true, scopes: ['instagram_basic', 'pages_show_list'] } });
    const { job } = await checkMeta();
    expectHumanError(job!, 'instagram_manage_messages', 'Шаг 7б');
    const todo = job!.error!.todo.join('\n');
    expect(todo).toContain('раздел Other → отметьте instagram_manage_comments, instagram_manage_messages');
    expect(todo).toContain('раздел Events Groups Pages → отметьте pages_read_engagement, pages_manage_metadata');
    expect(job!.result).toBeNull();
    expect((await api('/api/install', { pageId: 'p1' })).status).toBe(400);
  });

  it('нет ни одной страницы Facebook', async () => {
    sc.accounts = () => ok({ data: [] });
    const { job } = await checkMeta();
    expectHumanError(job!, 'ни одной вашей страницы', 'Шаг 2');
  });

  it('страница есть, Instagram не привязан или личный', async () => {
    sc.accounts = () => ok({ data: [{ id: 'p1', name: 'Моя страница', access_token: 'EAA' + 'P'.repeat(60) }] });
    const { job } = await checkMeta();
    expectHumanError(job!, 'не привязан профессиональный Instagram', 'Шаги 1–2');
  });
});

describe('мастер: установка', () => {
  it('всё правильно — 10 шагов, ключ для проверки сохранён', async () => {
    await startWizard();
    const j = await install();
    expect(j.error).toBeNull();
    expect(j.steps.map((s) => s.status)).toEqual(Array(10).fill('ok'));
    const state = JSON.parse(readFileSync(join(tmp, 'wrangler.json'), 'utf8'));
    expect(Object.keys(state.secrets)).toContain('SETUP_TOKEN');
    const setup = JSON.parse(readFileSync(join(tmp, 'state', 'setup.json'), 'utf8'));
    expect(setup.url).toBe('https://ig-comment-dm-bot.fake-user.workers.dev');
    // секреты не попали в журнал
    const logDir = join(tmp, 'logs');
    const log = readFileSync(join(logDir, readdirSync(logDir)[0]), 'utf8');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(setup.setupToken);
  });

  it('не вошли в Cloudflare', async () => {
    await startWizard('notlogged');
    expectHumanError(await install(), 'не видит вход в Cloudflare', 'Шаг 5');
  });

  it('очередь уже есть (повторная установка) — не ошибка', async () => {
    await startWizard('queue-taken');
    const j = await install();
    expect(j.error).toBeNull();
    expect(j.steps[1].note).toBe('Уже есть');
  });

  it('Cloudflare не дал создать очередь (почта не подтверждена)', async () => {
    await startWizard('queue-error');
    const j = await install();
    expectHumanError(j, 'не дал создать очередь', 'Шаг 5');
    expect(j.error!.todo.join(' ')).toContain('подтвердите');
  });

  it('нет адреса workers.dev — даёт ссылку', async () => {
    await startWizard('subdomain');
    const j = await install();
    expectHumanError(j, 'нет адреса на workers.dev', 'Шаг 8');
    expect(j.error!.todo[0]).toContain('https://dash.cloudflare.com/abc123/workers/onboarding');
  });

  it('Cloudflare не принял робота', async () => {
    await startWizard('deploy-error');
    expectHumanError(await install(), 'Cloudflare не принял робота', 'Шаг 8');
  });

  it('Meta видит старую версию робота (#2200) — ждёт и повторяет', async () => {
    await startWizard();
    sc.subscriptionFailures = 3;
    const j = await install();
    expect(j.error).toBeNull();
    expect(j.steps[7].status).toBe('ok');
  });

  it('Meta всё время не включает уведомления', async () => {
    await startWizard();
    sc.subscribeError = metaErr(100, 'Invalid parameter');
    const j = await install();
    expectHumanError(j, 'не включила уведомления', 'Шаг 8');
    expect(j.error!.details).toContain('Invalid parameter');
  });

  it('страница не подписалась — предупреждение по-русски, установка продолжается', async () => {
    await startWizard();
    sc.pageSubscribe = () => metaErr(200, 'Permissions error');
    const j = await install();
    expect(j.error).toBeNull();
    expect(j.steps[8].status).toBe('warn');
    expect(j.steps[8].note).toContain('pages_manage_metadata');
  });
});

// ---- проверка «всё работает»
const NOW = '2026-10-29T12:00:00.000Z';
const rule = { name: 'гайд', scope: 'media', matchType: 'exact_any', keywords: ['+'], privateReplyEnabled: true, publicReplyEnabled: true, post: null };
const base = (extra: Json = {}): Json => ({
  now: NOW,
  account: { username: 'egor', automationEnabled: true, circuitBreakerStatus: 'closed', lastWebhookReceivedAt: null },
  emergencyStop: false,
  activeRules: [rule],
  events: [],
  runs: [],
  lastProblem: null,
  ...extra,
});
const ev = (status: string, type = 'comments') => ({ receivedAt: NOW, type, status, signatureValid: type !== 'invalid_signature', commentId: 'c1' });
const run = (privateReplyStatus: string, publicReplyStatus: string) => ({
  createdAt: NOW, commentId: 'c1', commenterUsername: 'friend', matchedKeyword: '+', status: 'completed', privateReplyStatus, publicReplyStatus,
});

async function runCheck(diagnostics: Json[]) {
  await startWizard();
  await install();
  sc.diagnostics = diagnostics;
  diagCalls = 0;
  await api('/api/check', {});
  return waitJob();
}

describe('мастер: проверка «всё ли работает»', () => {
  it('без установки в этой папке', async () => {
    await startWizard();
    await api('/api/check', {});
    expectHumanError(await waitJob(), 'установка в этой папке ещё не проходила', 'Шаг 8');
  });

  it('всё работает', async () => {
    const j = await runCheck([base(), base({ events: [ev('completed')], runs: [run('success', 'success')] })]);
    expect(j.error).toBeNull();
    expect(j.steps.map((s) => s.status)).toEqual(Array(6).fill('ok'));
  });

  it('робот старой версии', async () => {
    const j = await runCheck([]);
    expectHumanError(j, 'старой версией', 'Шаг 8');
  });

  it('нет включённого правила', async () => {
    expectHumanError(await runCheck([base({ activeRules: [] })]), 'нет ни одного включённого правила', 'Шаг 12');
  });

  it('включена аварийная остановка', async () => {
    expectHumanError(await runCheck([base({ emergencyStop: true })]), 'Аварийная остановка', 'Шаг 12');
  });

  it('комментарий не дошёл — приложение не опубликовано', async () => {
    const j = await runCheck([base()]);
    expectHumanError(j, 'не дошёл до робота', 'Шаг 11');
    expect(j.error!.todo.join(' ')).toContain('рабочий режим');
  });

  it('секрет сбросили — робот отклоняет уведомления', async () => {
    expectHumanError(await runCheck([base(), base({ events: [ev('invalid_signature', 'invalid_signature')] })]), 'секрет приложения не совпадает', 'Шаг 7в');
  });

  it('написали со своего аккаунта', async () => {
    expectHumanError(await runCheck([base(), base({ events: [ev('skipped:own_comment')] })]), 'с того же аккаунта', 'Шаг 13');
  });

  it('слово не подошло под правило — показывает слова и режим', async () => {
    const j = await runCheck([base(), base({ events: [ev('no_match')] })]);
    expectHumanError(j, 'не подошёл ни под одно правило', 'Шаг 12');
    expect(j.error!.todo[0]).toContain('«+»');
    expect(j.error!.todo[0]).toContain('точно совпадает');
  });

  it('у поста нет правила', async () => {
    expectHumanError(await runCheck([base(), base({ events: [ev('skipped:no_active_automation')] })]), 'у этого поста нет', 'Шаг 12');
  });

  it('директ не ушёл — подсказка из робота (тумблер в Instagram)', async () => {
    const hint = 'В Instagram выключен доступ к сообщениям… Allow access to messages.';
    const j = await runCheck([
      base(),
      base({ events: [ev('completed')], runs: [run('failed', 'skipped')], lastProblem: { metaErrorCode: '200', metaErrorMessage: 'disabled access', hint } }),
    ]);
    expectHumanError(j, 'не дала отправить сообщение в директ', 'Шаг 10');
    expect(j.error!.todo[0]).toBe(hint);
  });

  it('ответ под комментарием не ушёл — предупреждение, директ засчитан', async () => {
    const j = await runCheck([base(), base({ events: [ev('completed')], runs: [run('success', 'failed')], lastProblem: { hint: 'Meta ограничила частоту запросов.' } })]);
    expect(j.error).toBeNull();
    expect(j.steps[4].status).toBe('ok');
    expect(j.steps[5].status).toBe('warn');
  });
});
