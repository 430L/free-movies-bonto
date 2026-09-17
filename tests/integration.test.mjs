import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function tmdbFixture(pathname) {
  if (pathname === '/3/movie/550') {
    return {
      id: 550,
      title: 'Fight Club',
      overview: 'Movie fixture',
      release_date: '1999-10-15',
      vote_average: 8.4,
      poster_path: '/movie.jpg',
      backdrop_path: '/movie-bg.jpg',
      genres: [{ id: 18, name: 'Drama' }],
      runtime: 139,
      status: 'Released',
      videos: { results: [] },
      credits: { cast: [], crew: [] },
      recommendations: { results: [] },
      similar: { results: [] },
      release_dates: { results: [] }
    };
  }

  if (pathname === '/3/tv/1399') {
    return {
      id: 1399,
      name: 'Game of Thrones',
      overview: 'TV fixture',
      first_air_date: '2011-04-17',
      vote_average: 8.5,
      poster_path: '/tv.jpg',
      backdrop_path: '/tv-bg.jpg',
      genres: [{ id: 18, name: 'Drama' }],
      number_of_seasons: 8,
      status: 'Ended',
      seasons: [{ id: 1, season_number: 1, name: 'Season 1', episode_count: 10 }],
      created_by: [{ id: 1, name: 'Creator Fixture' }],
      videos: { results: [] },
      credits: { cast: [], crew: [] },
      recommendations: { results: [] },
      similar: { results: [] },
      content_ratings: { results: [] }
    };
  }

  if (pathname === '/3/tv/1399/season/1') {
    return {
      id: 1,
      name: 'Season 1',
      season_number: 1,
      episodes: [{ id: 101, episode_number: 1, name: 'Winter Is Coming', overview: 'Episode fixture', runtime: 62, still_path: '/episode.jpg' }]
    };
  }

  return null;
}

async function waitForServer(baseUrl, child, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`public server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('public server did not start');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('CinePro integration preserves playback, refresh, proxy, movie, and TV contracts', async (t) => {
  let refreshMethod = '';
  let proxyAcceptEncoding = '';
  let proxiedRange = '';
  let engineBase = '';

  const tmdbServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const fixture = tmdbFixture(url.pathname);
    if (fixture) return json(res, 200, fixture);
    json(res, 404, { status_message: `No fixture for ${url.pathname}` });
  });
  const tmdbPort = await listen(tmdbServer);

  const engineServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/v1/health' || url.pathname === '/v1') {
      return json(res, 200, {
        name: 'CinePro',
        version: '1.0.0',
        status: 'operational',
        spec: 'omss',
        note: 'Running with 2 provider(s). Supported Providers: Alpha, Beta',
        endpoints: { movie: '/v1/movies/{id}', tv: '/v1/tv/{id}/seasons/{s}/episodes/{e}', proxy: '/v1/proxy?data={encoded_data}', refresh: '/v1/refresh/{responseId}' }
      });
    }

    if (url.pathname === '/v1/movies/550') {
      return json(res, 200, {
        responseId: 'movie-response',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        sources: [{
          id: 'movie-alpha',
          url: `${engineBase}/v1/proxy?data=movie`,
          type: 'application/vnd.apple.mpegurl',
          quality: 'FHD',
          provider: { id: 'alpha', name: 'Alpha' },
          subtitles: [{ url: `${engineBase}/v1/proxy?data=sub`, label: 'English', language: 'en', format: 'vtt' }]
        }],
        subtitles: [],
        diagnostics: []
      });
    }

    if (url.pathname === '/v1/tv/1399/seasons/1/episodes/1') {
      return json(res, 200, {
        responseId: 'tv-response',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        sources: [{
          id: 'tv-beta',
          url: '/v1/proxy?data=tv',
          type: 'hls',
          quality: '720p',
          provider: { id: 'beta', name: 'Beta' }
        }],
        subtitles: [{ url: '/v1/proxy?data=tv-sub', label: 'English', language: 'en', format: 'vtt' }],
        diagnostics: []
      });
    }

    if (url.pathname === '/v1/refresh/movie-response') {
      refreshMethod = req.method;
      if (req.method !== 'GET') return json(res, 405, { error: { message: 'GET required' } });
      return json(res, 200, { status: 'OK' });
    }

    if (url.pathname === '/v1/proxy' && url.searchParams.get('data') === 'movie') {
      proxyAcceptEncoding = String(req.headers['accept-encoding'] || '');
      const body = `#EXTM3U\n#EXT-X-VERSION:3\n${engineBase}/v1/proxy?data=segment\n`;
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }

    if (url.pathname === '/v1/proxy' && url.searchParams.get('data') === 'segment') {
      proxiedRange = String(req.headers.range || '');
      const body = Buffer.from([0x47, 0x40]);
      res.writeHead(proxiedRange ? 206 : 200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': body.length,
        'Accept-Ranges': 'bytes',
        ...(proxiedRange ? { 'Content-Range': 'bytes 0-1/4' } : {})
      });
      return res.end(body);
    }

    if (url.pathname === '/v1/proxy') {
      const body = 'fixture';
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      return res.end(body);
    }

    json(res, 404, { error: { message: `No engine fixture for ${url.pathname}` } });
  });
  const enginePort = await listen(engineServer);
  engineBase = `http://127.0.0.1:${enginePort}`;

  const publicPort = await freePort();
  const publicBase = `http://127.0.0.1:${publicPort}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(publicPort),
      TMDB_API_KEY: 'fixture-key',
      TMDB_BASE_URL: `http://127.0.0.1:${tmdbPort}/3`,
      PAYSONS_ENGINE_URL: engineBase,
      PLAYBACK_PROBE_SOURCES: 'false',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', (chunk) => { logs += String(chunk); });
  child.stderr.on('data', (chunk) => { logs += String(chunk); });

  t.after(async () => {
    await stopChild(child);
    await new Promise((resolve) => engineServer.close(resolve));
    await new Promise((resolve) => tmdbServer.close(resolve));
  });

  try {
    await waitForServer(publicBase, child);

    const health = await fetch(`${publicBase}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.playback, 'operational');
    assert.equal(health.providers, 2);

    const providers = await fetch(`${publicBase}/api/playback/providers`).then((response) => response.json());
    assert.equal(providers.count, 2);
    assert.deepEqual(providers.providers.map((provider) => provider.name), ['Alpha', 'Beta']);

    const movieDetails = await fetch(`${publicBase}/api/title/movie/550`).then((response) => response.json());
    assert.equal(movieDetails.display_title, 'Fight Club');
    assert.equal(movieDetails.media_type, 'movie');

    const tvDetails = await fetch(`${publicBase}/api/title/tv/1399`).then((response) => response.json());
    assert.equal(tvDetails.display_title, 'Game of Thrones');
    assert.equal(tvDetails.seasons[0].season_number, 1);

    const season = await fetch(`${publicBase}/api/tv/1399/season/1`).then((response) => response.json());
    assert.equal(season.episodes[0].name, 'Winter Is Coming');

    const movie = await fetch(`${publicBase}/api/playback/resolve?type=movie&id=550`).then((response) => response.json());
    assert.equal(movie.id, 'movie-response');
    assert.equal(movie.responseId, 'movie-response');
    assert.equal(movie.sources[0].type, 'hls');
    assert.equal(movie.sources[0].quality, 'FHD');
    assert.equal(movie.sources[0].url, `${publicBase}/v1/proxy?data=movie`);
    assert.equal(movie.sources[0].subtitles[0].url, `${publicBase}/v1/proxy?data=sub`);

    const forwardedMovie = await fetch(`${publicBase}/api/playback/resolve?type=movie&id=550`, {
      headers: { 'X-Forwarded-Host': 'movies.example.test', 'X-Forwarded-Proto': 'https' }
    }).then((response) => response.json());
    assert.equal(forwardedMovie.sources[0].url, 'https://movies.example.test/v1/proxy?data=movie');

    const tv = await fetch(`${publicBase}/api/playback/resolve?type=tv&id=1399&season=1&episode=1`).then((response) => response.json());
    assert.equal(tv.responseId, 'tv-response');
    assert.equal(tv.sources[0].url, `${publicBase}/v1/proxy?data=tv`);
    assert.equal(tv.subtitles[0].url, `${publicBase}/v1/proxy?data=tv-sub`);
    assert.equal(tv.sources[0].subtitles[0].url, `${publicBase}/v1/proxy?data=tv-sub`);

    const refreshResponse = await fetch(`${publicBase}/api/playback/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: movie.responseId })
    });
    assert.equal(refreshResponse.status, 200);
    assert.equal(refreshMethod, 'GET');

    const manifestResponse = await fetch(movie.sources[0].url);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.text();
    assert.match(manifest, new RegExp(publicBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(manifest.includes(engineBase), false);
    assert.equal(proxyAcceptEncoding, 'identity');

    const segmentResponse = await fetch(`${publicBase}/v1/proxy?data=segment`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(segmentResponse.status, 206);
    assert.equal(segmentResponse.headers.get('content-range'), 'bytes 0-1/4');
    assert.equal(segmentResponse.headers.get('accept-ranges'), 'bytes');
    assert.equal(proxiedRange, 'bytes=0-1');

    const index = await fetch(publicBase).then((response) => response.text());
    assert.match(index, /Payson/);
  } catch (error) {
    throw new Error(`${error.message}\nServer logs:\n${logs}`, { cause: error });
  }
});
