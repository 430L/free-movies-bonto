import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadLocalEnv();

const key = process.env.TMDB_API_KEY?.trim();
if (!key) {
  console.error('[Payson’s Movies] Missing TMDB_API_KEY. Add it in Bonto environment variables, then restart.');
  process.exit(1);
}

const coreEntry = path.join(__dirname, 'node_modules', '@cinepro', 'core', 'src', 'server.ts');
const tsxCli = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(coreEntry) || !existsSync(tsxCli)) {
  console.error('[Payson’s Movies] Playback dependencies are not installed. Run npm install (Bonto does this automatically).');
  process.exit(1);
}

const corePort = Number(process.env.PAYSONS_ENGINE_PORT || await findFreePort());
const engineUrl = `http://127.0.0.1:${corePort}`;
let coreChild = null;
let shuttingDown = false;
let restartTimer = null;

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(name in process.env)) process.env[name] = value;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function coreEnvironment() {
  return {
    ...process.env,
    TMDB_API_KEY: key,
    HOST: '127.0.0.1',
    PORT: String(corePort),
    PUBLIC_URL: process.env.CINEPRO_PUBLIC_URL || engineUrl,
    CACHE_TYPE: process.env.CACHE_TYPE || 'memory',
    CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
    STREMIO_ADDON: process.env.STREMIO_ADDON || 'false',
    MCP_ENABLED: process.env.MCP_ENABLED || 'false',
    INTERNAL_DEBUG: process.env.INTERNAL_DEBUG || 'false',
    NODE_ENV: process.env.NODE_ENV || 'production'
  };
}

function startCore() {
  if (shuttingDown) return;
  console.log(`[Payson’s Movies] Starting playback engine on 127.0.0.1:${corePort}`);

  coreChild = spawn(process.execPath, [tsxCli, coreEntry], {
    cwd: path.dirname(coreEntry),
    env: coreEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  coreChild.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[Payson playback] ${text}`);
  });
  coreChild.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[Payson playback] ${text}`);
  });

  coreChild.on('error', (error) => {
    console.error('[Payson’s Movies] Playback engine failed to launch:', error.message);
  });

  coreChild.on('exit', (code, signal) => {
    coreChild = null;
    if (shuttingDown) return;
    console.error(`[Payson’s Movies] Playback engine stopped (${signal || code || 'unknown'}). Restarting in 2 seconds…`);
    restartTimer = setTimeout(startCore, 2000);
    restartTimer.unref();
  });
}

async function waitForCore(timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const pathname of ['/v1/health', '/v1']) {
      try {
        const response = await fetch(`${engineUrl}${pathname}`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return true;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (coreChild && !coreChild.killed) coreChild.kill(signal);
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startCore();
const ready = await waitForCore();
if (!ready) {
  console.warn('[Payson’s Movies] Playback engine did not report ready before timeout. The UI will still start and health checks will show playback as degraded.');
}

process.env.PAYSONS_ENGINE_URL = engineUrl;
await import('./server.js');
