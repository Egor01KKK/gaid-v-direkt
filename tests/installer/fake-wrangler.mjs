// Поддельный wrangler для тестов мастера: ничего не отправляет в сеть.
// FAKE_WRANGLER_MODE — через запятую: notlogged, subdomain, queue-taken, queue-error, deploy-error.
// В FAKE_WRANGLER_STATE пишутся только имена команд и длины секретов, не значения.
import fs from 'node:fs';
const file = process.env.FAKE_WRANGLER_STATE;
const modes = new Set((process.env.FAKE_WRANGLER_MODE || '').split(',').filter(Boolean));
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { calls: [], secrets: {} };
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 1));
const [a, b, c] = process.argv.slice(2);
state.calls.push(process.argv.slice(2).join(' '));

if (a === 'whoami') {
  save();
  if (modes.has('notlogged')) console.log('You are not authenticated. Please run `wrangler login`.');
  else console.log('You are logged in with an OAuth Token, associated with the email someone@example.com.');
} else if (a === 'queues') {
  save();
  if (modes.has('queue-taken')) {
    console.error("Queue name 'ig-comment-events' is already taken. Please use a different name and try again. [code: 11009]");
    process.exit(1);
  }
  if (modes.has('queue-error')) {
    console.error('A request to the Cloudflare API failed. Please verify your email address [code: 10034]');
    process.exit(1);
  }
  console.log("Created queue 'ig-comment-events'");
} else if (a === 'deploy') {
  save();
  if (modes.has('subdomain')) {
    console.error('You need to register a workers.dev subdomain before publishing to workers.dev\nhttps://dash.cloudflare.com/abc123/workers/onboarding');
    process.exit(1);
  }
  if (modes.has('deploy-error')) {
    console.error('Authentication error [code: 10000]');
    process.exit(1);
  }
  console.log('Uploaded ig-comment-dm-bot\nDeployed ig-comment-dm-bot triggers\n  https://ig-comment-dm-bot.fake-user.workers.dev');
} else if (a === 'd1') {
  save();
  console.log('Migrations applied');
} else if (a === 'secret' && b === 'list') {
  save();
  console.log(JSON.stringify(Object.keys(state.secrets).map((name) => ({ name, type: 'secret_text' }))));
} else if (a === 'secret' && b === 'put') {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    state.secrets[c] = input.length;
    save();
    console.log(`Success! Uploaded secret ${c}`);
  });
} else if (a === 'login') {
  save();
  console.log('Successfully logged in.');
} else {
  save();
  console.error('fake-wrangler: unknown command');
  process.exit(2);
}
