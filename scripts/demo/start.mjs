// One command for the demo: API + worker (combined) against the demo database, and the web app,
// served from one address. Safe mode (default) removes the Gemini keys from the process so a click
// can never spend quota; --live keeps them.
//   npm run demo           safe mode
//   npm run demo:live      Gemini enabled (new recordings can be transcribed)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const live = process.argv.includes('--live');
const skipBuild = process.argv.includes('--no-build');
const isWin = process.platform === 'win32';

function envNames() {
  try {
    return new Set(
      readFileSync(join(root, '.env'), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.match(/^([A-Z0-9_]+)=/)?.[1])
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}
const names = envNames();
if (!existsSync(join(root, '.env'))) {
  console.error('No .env at the repo root. Copy .env.example and fill it in.');
  process.exit(1);
}

const apiEnv = {
  ...process.env,
  MONGODB_DB: 'meetingid_demo',
  SUMMARY_PROVIDER: 'handoff',
  PORT: '8080',
  CORS_ORIGINS: 'http://localhost:5173',
  ...(live ? {} : { GAPFILL: 'off' }),
};
// An empty value wins over .env (existing variables are never overridden) and counts as "unset".
if (!live)
  for (const k of new Set([...Object.keys(apiEnv), ...names]))
    if (/^GEMINI_API_KEY\d*$/.test(k)) apiEnv[k] = '';
apiEnv.ANTHROPIC_API_KEY = ''; // summaries come from the handoff provider only

if (!skipBuild) {
  console.log('Building the web app…');
  const r = spawnSync('npm', ['run', 'build', '-w', '@meetingid/web'], {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, VITE_API_URL: '' },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const children = [];
function start(label, cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${label}] `;
  const pipe = (stream, out) =>
    stream.on('data', (d) =>
      String(d)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => out.write(tag + l.slice(0, 220) + '\n')),
    );
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${tag}stopped (${code})`));
  children.push(child);
  return child;
}

start(
  'api',
  'npx',
  ['tsx', '--conditions=source', '--env-file-if-exists=../../.env', 'src/all.ts'],
  join(root, 'apps', 'api'),
  apiEnv,
);
start(
  'web',
  'npx',
  ['vite', 'preview', '--port', '5173', '--host'],
  join(root, 'apps', 'web'),
  process.env,
);

const stop = () => {
  for (const c of children) {
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// wait for the API, then say where everything is
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch('http://localhost:8080/api/v1/health');
    if (res.ok) {
      const h = await res.json();
      console.log(`
==================================================================
 MeetingID demo is running ${live ? '(LIVE: Gemini enabled)' : '(SAFE: Gemini disabled, nothing can spend quota)'}
   Open:   http://localhost:5173
   Login:  the access code is WORKSPACE_ACCESS_CODE in the .env file at the repo root
   Data:   database "${h.db === 'up' ? 'meetingid_demo' : '?'}" (a copy; the Phase 1 data is not touched)
   Phones: run  npm run demo:tunnel  in a second terminal for an https address
   Stop:   Ctrl+C
==================================================================`);
      break;
    }
  } catch {
    /* not up yet */
  }
}
