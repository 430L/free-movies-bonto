import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const key = process.env.TMDB_API_KEY?.trim();

if (!key) {
    console.error('[cinepro-bonto] Missing TMDB_API_KEY. Add it in Bonto Settings > Environment Variables, then restart the app.');
    process.exit(1);
}

process.env.TMDB_API_KEY = key;
process.env.HOST ||= '0.0.0.0';
process.env.CACHE_TYPE ||= 'memory';
process.env.CORS_ORIGIN ||= '*';
process.env.STREMIO_ADDON ||= 'false';
process.env.MCP_ENABLED ||= 'false';
process.env.INTERNAL_DEBUG ||= 'false';
process.env.TMDB_CACHE_TTL ||= '86400';
process.env.NODE_ENV ||= 'production';

if (!process.env.PORT) {
    process.env.PORT = '3000';
}

const server = resolve(here, 'node_modules/@cinepro/core/src/server.ts');
const tsx = resolve(here, 'node_modules/.bin/tsx');

if (!existsSync(server)) {
    console.error('[cinepro-bonto] CinePro Core was not installed. Bonto should run npm install automatically; restart the app after installation completes.');
    process.exit(1);
}

if (!existsSync(tsx)) {
    console.error('[cinepro-bonto] tsx was not installed. Bonto should run npm install automatically; restart the app after installation completes.');
    process.exit(1);
}

console.log(`[cinepro-bonto] Starting CinePro Core on ${process.env.HOST}:${process.env.PORT}`);
console.log('[cinepro-bonto] Cache: memory | CORS: * | Redis: disabled');

const child = spawn(tsx, [server], {
    cwd: dirname(server),
    env: process.env,
    stdio: 'inherit'
});

let stopping = false;
const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
    const timer = setTimeout(() => process.exit(0), 5000);
    timer.unref();
};

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

child.on('error', (error) => {
    console.error('[cinepro-bonto] Failed to launch CinePro Core:', error);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    if (signal) {
        console.log(`[cinepro-bonto] CinePro Core stopped by ${signal}`);
        process.exit(0);
    }
    process.exit(code ?? 0);
});
