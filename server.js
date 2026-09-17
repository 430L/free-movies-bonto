import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const vendorHlsPath = path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js');

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const CACHE_TTL = 10 * 60 * 1000;
const FETCH_TIMEOUT = 12000;
const PROBE_TIMEOUT = 2800;
const SOURCE_HEALTH_TTL = 45 * 1000;
const cache = new Map();
const sourceHealth = new Map();
const sourcePenalty = new Map();
const playbackCatalog = loadPlaybackCatalog();

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.vtt', 'text/vtt; charset=utf-8']
]);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' https://image.tmdb.org data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self'",
    "connect-src 'self' https:",
    "media-src 'self' https: blob:",
    "worker-src 'self' blob:",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadPlaybackCatalog() {
  let raw = process.env.PLAYBACK_SOURCES_JSON?.trim();
  const configPath = path.join(__dirname, 'playback-sources.json');
  if (!raw && existsSync(configPath)) raw = readFileSync(configPath, 'utf8');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`[Payson’s Movies] Ignoring invalid playback source config: ${error.message}`);
    return {};
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders, ...headers });
  res.end(body);
}

function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  cache.set(key, { timestamp: Date.now(), value });
  return value;
}

async function tmdb(pathname, searchParams = {}) {
  if (!TMDB_API_KEY) throw Object.assign(new Error('TMDB_API_KEY is not configured on this deployment.'), { status: 503 });
  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, language: 'en-US', ...searchParams });
  const cacheKey = `${pathname}?${new URLSearchParams(searchParams).toString()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${TMDB_BASE}${pathname}?${qs.toString()}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(`TMDB request failed (${response.status}): ${text.slice(0, 300)}`), { status: response.status });
    }
    return setCached(cacheKey, await response.json());
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('TMDB request timed out.'), { status: 504 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeItem(item, typeHint) {
  if (!item) return null;
  const mediaType = item.media_type && item.media_type !== 'person' ? item.media_type : typeHint || (item.title ? 'movie' : 'tv');
  return {
    id: item.id,
    media_type: mediaType,
    title: item.title || item.name || 'Untitled',
    original_title: item.original_title || item.original_name || item.title || item.name || 'Untitled',
    overview: item.overview || '',
    poster_path: item.poster_path || null,
    backdrop_path: item.backdrop_path || null,
    release_date: item.release_date || item.first_air_date || '',
    vote_average: Number(item.vote_average || 0),
    vote_count: Number(item.vote_count || 0),
    genre_ids: item.genre_ids || [],
    adult: Boolean(item.adult),
    popularity: Number(item.popularity || 0)
  };
}

function findTrailer(details) {
  const videos = details?.videos?.results || [];
  return videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official)
    || videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer')
    || videos.find((v) => v.site === 'YouTube' && v.type === 'Teaser')
    || videos.find((v) => v.site === 'YouTube')
    || null;
}

function certificationFor(details, mediaType) {
  if (mediaType === 'movie') {
    const us = details.release_dates?.results?.find((entry) => entry.iso_3166_1 === 'US');
    return us?.release_dates?.find((entry) => entry.certification)?.certification || '';
  }
  return details.content_ratings?.results?.find((entry) => entry.iso_3166_1 === 'US')?.rating || '';
}

function apiError(res, error, message) {
  const status = Number(error.status) || 500;
  console.error(`[Payson’s Movies] ${message}: ${error.message}`);
  json(res, status, { error: message, detail: error.message }, { 'Cache-Control': 'no-store' });
}

async function homeResponse() {
  const [trending, topMovies, nowPlaying, topTV, upcoming, genresMovie, genresTv] = await Promise.all([
    tmdb('/trending/all/week'), tmdb('/movie/top_rated', { page: '1' }), tmdb('/movie/now_playing', { page: '1' }),
    tmdb('/tv/top_rated', { page: '1' }), tmdb('/movie/upcoming', { page: '1' }), tmdb('/genre/movie/list'), tmdb('/genre/tv/list')
  ]);
  const featuredItems = [...(trending.results || []), ...(upcoming.results || [])]
    .filter((item) => item.media_type !== 'person' && item.backdrop_path && (item.title || item.name) && item.overview)
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 6)
    .map((item) => normalizeItem(item, item.media_type || 'movie')).filter(Boolean);

  return {
    featured: featuredItems[0] || normalizeItem(trending.results?.[0], trending.results?.[0]?.media_type) || normalizeItem(nowPlaying.results?.[0], 'movie'),
    featuredItems,
    sections: [
      { id: 'trending', title: 'Trending Now', subtitle: 'Live picks from across film and television', items: (trending.results || []).filter((i) => i.media_type !== 'person').map((i) => normalizeItem(i, i.media_type)).filter(Boolean) },
      { id: 'top-movies', title: 'Top Movies', subtitle: 'Critically loved feature films', items: (topMovies.results || []).map((i) => normalizeItem(i, 'movie')).filter(Boolean) },
      { id: 'now-playing', title: 'Now Playing', subtitle: 'Fresh theatrical releases and current buzz', items: (nowPlaying.results || []).map((i) => normalizeItem(i, 'movie')).filter(Boolean) },
      { id: 'top-tv', title: 'Prestige Television', subtitle: 'Award-winning series and must-watch shows', items: (topTV.results || []).map((i) => normalizeItem(i, 'tv')).filter(Boolean) },
      { id: 'coming-soon', title: 'Coming Soon', subtitle: 'Upcoming releases worth tracking', items: (upcoming.results || []).map((i) => normalizeItem(i, 'movie')).filter(Boolean) }
    ],
    genres: { movie: genresMovie.genres || [], tv: genresTv.genres || [] }
  };
}

async function titleResponse(mediaType, id) {
  const details = await tmdb(`/${mediaType}/${id}`, { append_to_response: 'credits,videos,recommendations,similar,release_dates,content_ratings' });
  const cast = (details.credits?.cast || []).slice(0, 14).map((m) => ({ id: m.id, name: m.name, character: m.character, profile_path: m.profile_path }));
  const crew = (details.credits?.crew || []).filter((m) => ['Director', 'Writer', 'Screenplay', 'Creator', 'Executive Producer'].includes(m.job)).slice(0, 10);
  return {
    ...details,
    media_type: mediaType,
    display_title: details.title || details.name || 'Untitled',
    display_date: details.release_date || details.first_air_date || '',
    trailer: findTrailer(details), cast, crew, rating: certificationFor(details, mediaType),
    recommendations: (details.recommendations?.results || []).slice(0, 18).map((i) => normalizeItem(i, mediaType)).filter(Boolean),
    similar: (details.similar?.results || []).slice(0, 18).map((i) => normalizeItem(i, mediaType)).filter(Boolean),
    poster_url: details.poster_path ? `${IMAGE_BASE}/w500${details.poster_path}` : null,
    backdrop_url: details.backdrop_path ? `${IMAGE_BASE}/w1280${details.backdrop_path}` : null
  };
}

function playbackKey(type, id, season, episode) {
  return type === 'tv' ? `tv:${id}:${season}:${episode}` : `movie:${id}`;
}

function qualityScore(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('4k') || text.includes('2160')) return 2160;
  const number = Number.parseInt(text.match(/\d{3,4}/)?.[0] || '0', 10);
  return Number.isFinite(number) ? number : 0;
}

function normalizePlaybackSource(source, index, key) {
  if (!source || typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) return null;
  const type = source.type || (source.url.includes('.m3u8') ? 'hls' : source.url.includes('.mpd') ? 'dash' : 'mp4');
  const stableId = String(source.id || `${key}:${index}`).replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 160);
  return {
    id: stableId,
    name: String(source.name || source.server || `Server ${index + 1}`).slice(0, 80),
    url: source.url,
    type,
    quality: String(source.quality || 'Auto').slice(0, 40),
    subtitles: Array.isArray(source.subtitles) ? source.subtitles.filter((s) => s && typeof s.url === 'string').map((s) => ({ label: String(s.label || s.language || 'Subtitle').slice(0, 60), language: String(s.language || '').slice(0, 20), url: s.url })) : [],
    audioTracks: Array.isArray(source.audioTracks) ? source.audioTracks.map((a) => ({ label: String(a.label || a.language || 'Audio').slice(0, 60), language: String(a.language || '').slice(0, 20) })) : []
  };
}

async function probeSource(source) {
  const cached = sourceHealth.get(source.id);
  if (cached && Date.now() - cached.checkedAt < SOURCE_HEALTH_TTL) return cached;
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  let online = false;
  let status = 0;
  try {
    let response = await fetch(source.url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { Accept: '*/*' } });
    if ([403, 405].includes(response.status)) {
      response = await fetch(source.url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { Range: 'bytes=0-0', Accept: '*/*' } });
    }
    status = response.status;
    online = response.ok || response.status === 206 || response.status === 416;
    try { await response.body?.cancel(); } catch {}
  } catch {
    online = false;
  } finally {
    clearTimeout(timeout);
  }
  const result = { online, status, latencyMs: Math.max(1, Math.round(performance.now() - started)), checkedAt: Date.now() };
  sourceHealth.set(source.id, result);
  return result;
}

async function resolvePlayback(type, id, season, episode) {
  const key = playbackKey(type, id, season, episode);
  const raw = Array.isArray(playbackCatalog[key]) ? playbackCatalog[key] : [];
  const sources = raw.map((source, index) => normalizePlaybackSource(source, index, key)).filter(Boolean);
  const measured = await Promise.all(sources.map(async (source) => ({ ...source, health: await probeSource(source), penalty: Number(sourcePenalty.get(source.id) || 0) })));
  measured.sort((a, b) => {
    if (a.health.online !== b.health.online) return a.health.online ? -1 : 1;
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    const latency = (a.health.latencyMs || 999999) - (b.health.latencyMs || 999999);
    if (Math.abs(latency) > 120) return latency;
    return qualityScore(b.quality) - qualityScore(a.quality);
  });
  return { key, sources: measured, autoSelected: measured.find((s) => s.health.online)?.id || measured[0]?.id || null };
}

function applyPlaybackReport(body) {
  const id = String(body.sourceId || '').slice(0, 160);
  if (!id) return;
  const current = Number(sourcePenalty.get(id) || 0);
  if (body.event === 'failure') sourcePenalty.set(id, Math.min(25, current + 3));
  else if (body.event === 'success') sourcePenalty.set(id, Math.max(0, current - 1));
  if (Number.isFinite(Number(body.latencyMs)) && Number(body.latencyMs) > 0) {
    const previous = sourceHealth.get(id) || {};
    sourceHealth.set(id, { ...previous, online: body.event !== 'failure', latencyMs: Math.round(Number(body.latencyMs)), checkedAt: Date.now() });
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/playback/report') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    try {
      applyPlaybackReport(await readJsonBody(req));
      return json(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return apiError(res, error, 'Playback report failed');
    }
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });

  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, name: 'Payson’s Movies', configured: Boolean(TMDB_API_KEY), playbackConfigured: Object.keys(playbackCatalog).length > 0, version: '1.2.0' }, { 'Cache-Control': 'no-store' });
  }

  if (url.pathname === '/api/config') {
    return json(res, 200, { appName: 'Payson’s Movies', imageBase: IMAGE_BASE, logo: '/assets/logo.svg', playbackConfigured: Object.keys(playbackCatalog).length > 0 }, { 'Cache-Control': 'public, max-age=3600' });
  }

  if (url.pathname === '/api/home') {
    try { return json(res, 200, await homeResponse(), { 'Cache-Control': 'public, max-age=120, stale-while-revalidate=300' }); }
    catch (error) { return apiError(res, error, 'Failed to load home data'); }
  }

  if (url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!query) return json(res, 200, { query: '', results: [] }, { 'Cache-Control': 'no-store' });
    try {
      const data = await tmdb('/search/multi', { query, include_adult: 'false', page: '1' });
      const results = (data.results || []).filter((i) => i.media_type !== 'person' && (i.poster_path || i.backdrop_path)).map((i) => normalizeItem(i, i.media_type)).filter(Boolean);
      return json(res, 200, { query, results }, { 'Cache-Control': 'private, max-age=60' });
    } catch (error) { return apiError(res, error, 'Search failed'); }
  }

  const titleMatch = url.pathname.match(/^\/api\/title\/(movie|tv)\/(\d+)$/);
  if (titleMatch) {
    try { return json(res, 200, await titleResponse(titleMatch[1], titleMatch[2]), { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' }); }
    catch (error) { return apiError(res, error, 'Failed to load title details'); }
  }

  const seasonMatch = url.pathname.match(/^\/api\/tv\/(\d+)\/season\/(\d+)$/);
  if (seasonMatch) {
    try {
      const data = await tmdb(`/tv/${seasonMatch[1]}/season/${seasonMatch[2]}`);
      return json(res, 200, data, { 'Cache-Control': 'public, max-age=600, stale-while-revalidate=1200' });
    } catch (error) { return apiError(res, error, 'Failed to load season details'); }
  }

  const watchMatch = url.pathname.match(/^\/api\/watch\/(movie|tv)\/(\d+)$/);
  if (watchMatch) {
    try {
      const data = await tmdb(`/${watchMatch[1]}/${watchMatch[2]}/watch/providers`);
      return json(res, 200, { region: 'US', ...(data.results?.US || {}) }, { 'Cache-Control': 'public, max-age=3600' });
    } catch (error) { return apiError(res, error, 'Failed to load watch providers'); }
  }

  if (url.pathname === '/api/playback/resolve') {
    const type = url.searchParams.get('type');
    const id = url.searchParams.get('id');
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');
    if (!['movie', 'tv'].includes(type) || !/^\d+$/.test(id || '')) return json(res, 400, { error: 'Invalid playback request' }, { 'Cache-Control': 'no-store' });
    if (type === 'tv' && (!/^\d+$/.test(season || '') || !/^\d+$/.test(episode || ''))) return json(res, 400, { error: 'TV playback requires season and episode' }, { 'Cache-Control': 'no-store' });
    try {
      return json(res, 200, await resolvePlayback(type, id, season, episode), { 'Cache-Control': 'no-store' });
    } catch (error) { return apiError(res, error, 'Playback resolution failed'); }
  }

  return json(res, 404, { error: 'API route not found' }, { 'Cache-Control': 'no-store' });
}

async function serveVendor(res, pathname) {
  if (pathname !== '/vendor/hls.min.js') return false;
  try {
    const info = await stat(vendorHlsPath);
    send(res, 200, await readFile(vendorHlsPath), { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': info.size, 'Cache-Control': 'public, max-age=86400, immutable' });
  } catch {
    send(res, 503, 'hls.js is not installed', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  return true;
}

async function serveStatic(res, pathname) {
  if (await serveVendor(res, pathname)) return;
  let requested = pathname === '/' ? '/index.html' : pathname;
  try { requested = decodeURIComponent(requested); }
  catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' }); }

  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) && resolved !== path.join(publicDir, 'index.html')) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not-file');
    const extension = path.extname(resolved).toLowerCase();
    const cacheControl = requested === '/sw.js' ? 'no-cache' : extension === '.html' ? 'no-cache' : 'public, max-age=3600';
    send(res, 200, await readFile(resolved), { 'Content-Type': MIME.get(extension) || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': cacheControl });
  } catch {
    if (path.extname(requested)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    const indexPath = path.join(publicDir, 'index.html');
    send(res, 200, await readFile(indexPath), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error('[Payson’s Movies] Request failure:', error);
    json(res, 500, { error: 'Internal server error' }, { 'Cache-Control': 'no-store' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Payson’s Movies running on http://${HOST}:${PORT}`);
  console.log(`[Payson’s Movies] Playback catalog: ${Object.keys(playbackCatalog).length} title/episode entries`);
  if (!TMDB_API_KEY) console.warn('[Payson’s Movies] Set TMDB_API_KEY in Bonto, then restart the app.');
});
