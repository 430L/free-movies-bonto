import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const ENGINE_URL = process.env.PAYSONS_ENGINE_URL || 'http://127.0.0.1:3999';
const CACHE_TTL = 10 * 60 * 1000;
const TMDB_TIMEOUT = 12000;
const ENGINE_TIMEOUT = 45000;
const cache = new Map();

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

const baseSecurityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' https://image.tmdb.org https: data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self'",
    "connect-src 'self' https: blob:",
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseSecurityHeaders, ...headers });
  res.end(body);
}

function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
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

async function fetchWithTimeout(url, options = {}, timeout = TMDB_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tmdb(pathname, searchParams = {}) {
  if (!TMDB_API_KEY) {
    const error = new Error('TMDB_API_KEY is not configured on this deployment.');
    error.status = 503;
    throw error;
  }

  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, language: 'en-US', ...searchParams });
  const cacheKey = `${pathname}?${new URLSearchParams(searchParams).toString()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let response;
  try {
    response = await fetchWithTimeout(`${TMDB_BASE}${pathname}?${qs.toString()}`, { headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('TMDB request timed out.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`TMDB request failed (${response.status}): ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return setCached(cacheKey, await response.json());
}

async function engineJson(pathname, options = {}) {
  let response;
  try {
    response = await fetchWithTimeout(`${ENGINE_URL}${pathname}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) }
    }, ENGINE_TIMEOUT);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Playback engine timed out while resolving sources.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    const offline = new Error(`Playback engine unavailable: ${error.message}`);
    offline.status = 503;
    throw offline;
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `Playback engine returned HTTP ${response.status}` };
  }

  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || payload?.message || `Playback engine returned HTTP ${response.status}`;
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
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
  return videos.find((video) => video.site === 'YouTube' && video.type === 'Trailer' && video.official)
    || videos.find((video) => video.site === 'YouTube' && video.type === 'Trailer')
    || videos.find((video) => video.site === 'YouTube' && video.type === 'Teaser')
    || videos.find((video) => video.site === 'YouTube')
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
  json(res, status, { error: message, detail: error.message, upstream: error.payload || undefined }, { 'Cache-Control': 'no-store' });
}

async function homeResponse() {
  const [trending, topMovies, nowPlaying, topTV, upcoming, genresMovie, genresTv] = await Promise.all([
    tmdb('/trending/all/week'),
    tmdb('/movie/top_rated', { page: '1' }),
    tmdb('/movie/now_playing', { page: '1' }),
    tmdb('/tv/top_rated', { page: '1' }),
    tmdb('/movie/upcoming', { page: '1' }),
    tmdb('/genre/movie/list'),
    tmdb('/genre/tv/list')
  ]);

  const featuredItems = [...(trending.results || []), ...(upcoming.results || [])]
    .filter((item) => item.media_type !== 'person' && item.backdrop_path && (item.title || item.name) && item.overview)
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, 6)
    .map((item) => normalizeItem(item, item.media_type || 'movie'))
    .filter(Boolean);

  return {
    featured: featuredItems[0] || normalizeItem(trending.results?.[0], trending.results?.[0]?.media_type) || normalizeItem(nowPlaying.results?.[0], 'movie'),
    featuredItems,
    sections: [
      { id: 'trending', title: 'Trending Now', subtitle: 'Live picks from across film and television', items: (trending.results || []).filter((item) => item.media_type !== 'person').map((item) => normalizeItem(item, item.media_type)).filter(Boolean) },
      { id: 'top-movies', title: 'Top Movies', subtitle: 'Critically loved feature films', items: (topMovies.results || []).map((item) => normalizeItem(item, 'movie')).filter(Boolean) },
      { id: 'now-playing', title: 'Now Playing', subtitle: 'Fresh theatrical releases and current buzz', items: (nowPlaying.results || []).map((item) => normalizeItem(item, 'movie')).filter(Boolean) },
      { id: 'top-tv', title: 'Prestige Television', subtitle: 'Award-winning series and must-watch shows', items: (topTV.results || []).map((item) => normalizeItem(item, 'tv')).filter(Boolean) },
      { id: 'coming-soon', title: 'Coming Soon', subtitle: 'Upcoming releases worth tracking', items: (upcoming.results || []).map((item) => normalizeItem(item, 'movie')).filter(Boolean) }
    ],
    genres: { movie: genresMovie.genres || [], tv: genresTv.genres || [] }
  };
}

async function titleResponse(mediaType, id) {
  const details = await tmdb(`/${mediaType}/${id}`, { append_to_response: 'credits,videos,recommendations,similar,release_dates,content_ratings' });
  return {
    ...details,
    media_type: mediaType,
    display_title: details.title || details.name || 'Untitled',
    display_date: details.release_date || details.first_air_date || '',
    trailer: findTrailer(details),
    cast: (details.credits?.cast || []).slice(0, 14).map((member) => ({ id: member.id, name: member.name, character: member.character, profile_path: member.profile_path })),
    crew: (details.credits?.crew || []).filter((member) => ['Director', 'Writer', 'Screenplay', 'Creator', 'Executive Producer'].includes(member.job)).slice(0, 10),
    rating: certificationFor(details, mediaType),
    recommendations: (details.recommendations?.results || []).slice(0, 18).map((item) => normalizeItem(item, mediaType)).filter(Boolean),
    similar: (details.similar?.results || []).slice(0, 18).map((item) => normalizeItem(item, mediaType)).filter(Boolean),
    poster_url: details.poster_path ? `${IMAGE_BASE}/w500${details.poster_path}` : null,
    backdrop_url: details.backdrop_path ? `${IMAGE_BASE}/w1280${details.backdrop_path}` : null
  };
}

function requestOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = forwarded || (req.socket.encrypted ? 'https' : local ? 'http' : 'https');
  return host ? `${proto}://${host}` : '';
}

function rewriteInternalUrl(value, origin) {
  if (typeof value !== 'string') return value;
  if (!origin) return value;
  return value.split(ENGINE_URL).join(origin);
}

function rewritePayload(value, origin) {
  if (Array.isArray(value)) return value.map((entry) => rewritePayload(entry, origin));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = rewritePayload(child, origin);
    return output;
  }
  return rewriteInternalUrl(value, origin);
}

function sourceQualityScore(quality) {
  const text = String(quality || '').toLowerCase();
  if (text.includes('4k') || text.includes('2160')) return 2160;
  const match = text.match(/(\d{3,4})p?/);
  return match ? Number(match[1]) : 0;
}

function sourceTypeScore(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized === 'hls') return 40;
  if (normalized === 'dash') return 30;
  if (normalized === 'mp4') return 20;
  return 0;
}

function normalizePlaybackResponse(raw, origin) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const globalSubtitles = Array.isArray(data?.subtitles) ? data.subtitles : [];
  const allSources = Array.isArray(data?.sources) ? data.sources : [];
  const streamable = allSources.filter((source) => source && source.streamable !== false && source.url);

  const sources = streamable.map((source, index) => {
    const provider = source.provider || {};
    const quality = source.quality || 'Auto';
    const type = source.type || (String(source.url).includes('.m3u8') ? 'hls' : String(source.url).includes('.mpd') ? 'dash' : 'mp4');
    return {
      id: source.id || `${provider.id || 'provider'}-${index}`,
      url: rewriteInternalUrl(source.url, origin),
      type,
      quality,
      streamable: source.streamable !== false,
      provider: {
        id: provider.id || `provider-${index + 1}`,
        name: provider.name || `Server ${index + 1}`
      },
      audioTracks: Array.isArray(source.audioTracks) ? source.audioTracks : [],
      subtitles: Array.isArray(source.subtitles) ? source.subtitles : globalSubtitles,
      score: sourceQualityScore(quality) + sourceTypeScore(type)
    };
  }).sort((a, b) => b.score - a.score);

  return {
    id: data?.id || raw?.id || null,
    expiresAt: data?.expiresAt || raw?.expiresAt || null,
    sources,
    subtitles: globalSubtitles.map((subtitle) => ({ ...subtitle, url: rewriteInternalUrl(subtitle.url, origin) })),
    diagnostics: data?.diagnostics || [],
    providerCount: new Set(sources.map((source) => source.provider.id)).size,
    sourceCount: sources.length
  };
}

async function playbackResolve(req, url) {
  const type = url.searchParams.get('type');
  const id = String(url.searchParams.get('id') || '');
  if (!['movie', 'tv'].includes(type) || !/^\d+$/.test(id)) {
    const error = new Error('Valid type and TMDB id are required.');
    error.status = 400;
    throw error;
  }

  let pathname;
  if (type === 'movie') {
    pathname = `/v1/movies/${encodeURIComponent(id)}?platform=web`;
  } else {
    const season = Number(url.searchParams.get('season'));
    const episode = Number(url.searchParams.get('episode'));
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
      const error = new Error('TV playback requires valid season and episode numbers.');
      error.status = 400;
      throw error;
    }
    pathname = `/v1/tv/${encodeURIComponent(id)}/seasons/${season}/episodes/${episode}?platform=web`;
  }

  const raw = await engineJson(pathname);
  const normalized = normalizePlaybackResponse(raw, requestOrigin(req));
  normalized.sources = await annotateSourceHealth(normalized.sources, requestOrigin(req));
  return normalized;
}

async function annotateSourceHealth(sources, origin) {
  if (!sources.length) return sources;
  const limit = Math.min(sources.length, 8);
  const probeResults = await Promise.all(sources.slice(0, limit).map((source) => probeSource(source, origin)));
  const result = sources.map((source, index) => index < limit ? { ...source, health: probeResults[index] } : source);
  return result.sort((a, b) => {
    if (a.health?.online !== b.health?.online) return a.health?.online ? -1 : 1;
    const aLatency = Number.isFinite(a.health?.latencyMs) ? a.health.latencyMs : 999999;
    const bLatency = Number.isFinite(b.health?.latencyMs) ? b.health.latencyMs : 999999;
    if (Math.abs(aLatency - bLatency) > 100) return aLatency - bLatency;
    return Number(b.score || 0) - Number(a.score || 0);
  });
}

async function probeSource(source, origin) {
  const started = Date.now();
  let probeUrl = source.url;
  if (origin && probeUrl.startsWith(`${origin}/v1/`)) probeUrl = `${ENGINE_URL}${probeUrl.slice(origin.length)}`;
  try {
    const response = await fetchWithTimeout(probeUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=0-1', Accept: '*/*' }
    }, 1800);
    try { await response.body?.cancel(); } catch {}
    return { online: response.status >= 200 && response.status < 400, latencyMs: Date.now() - started, status: response.status };
  } catch {
    return { online: false, latencyMs: Date.now() - started };
  }
}

async function engineHealth() {
  try {
    const home = await engineJson('/v1', { headers: { Accept: 'application/json' } });
    return {
      status: home?.status || 'operational',
      spec: home?.spec || 'omss',
      providers: Array.isArray(home?.providers) ? home.providers.map((provider) => ({ id: provider.id, name: provider.name, capabilities: provider.capabilities || [] })) : []
    };
  } catch (error) {
    return { status: 'down', spec: 'omss', providers: [], error: error.message };
  }
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body.');
    error.status = 400;
    throw error;
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    const playback = await engineHealth();
    json(res, 200, {
      ok: Boolean(TMDB_API_KEY) && playback.status === 'operational',
      name: 'Payson’s Movies',
      version: '1.3.0',
      tmdb: TMDB_API_KEY ? 'configured' : 'missing',
      playback: playback.status,
      providers: playback.providers.length
    }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    json(res, 200, { appName: 'Payson’s Movies', imageBase: IMAGE_BASE, logo: '/assets/logo.svg' }, { 'Cache-Control': 'public, max-age=3600' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/home') {
    try { json(res, 200, await homeResponse(), { 'Cache-Control': 'public, max-age=120, stale-while-revalidate=300' }); }
    catch (error) { apiError(res, error, 'Failed to load home data'); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!query) { json(res, 200, { query: '', results: [] }, { 'Cache-Control': 'no-store' }); return; }
    try {
      const data = await tmdb('/search/multi', { query, include_adult: 'false', page: '1' });
      const results = (data.results || []).filter((item) => item.media_type !== 'person' && (item.poster_path || item.backdrop_path)).map((item) => normalizeItem(item, item.media_type)).filter(Boolean);
      json(res, 200, { query, results }, { 'Cache-Control': 'private, max-age=60' });
    } catch (error) { apiError(res, error, 'Search failed'); }
    return;
  }

  const titleMatch = url.pathname.match(/^\/api\/title\/(movie|tv)\/(\d+)$/);
  if (req.method === 'GET' && titleMatch) {
    try { json(res, 200, await titleResponse(titleMatch[1], titleMatch[2]), { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' }); }
    catch (error) { apiError(res, error, 'Failed to load title details'); }
    return;
  }

  const seasonMatch = url.pathname.match(/^\/api\/tv\/(\d+)\/season\/(\d+)$/);
  if (req.method === 'GET' && seasonMatch) {
    try { json(res, 200, await tmdb(`/tv/${seasonMatch[1]}/season/${seasonMatch[2]}`), { 'Cache-Control': 'public, max-age=1800' }); }
    catch (error) { apiError(res, error, 'Failed to load season data'); }
    return;
  }

  const watchMatch = url.pathname.match(/^\/api\/watch\/(movie|tv)\/(\d+)$/);
  if (req.method === 'GET' && watchMatch) {
    try {
      const providers = await tmdb(`/${watchMatch[1]}/${watchMatch[2]}/watch/providers`);
      json(res, 200, providers.results?.US || {}, { 'Cache-Control': 'public, max-age=21600' });
    } catch (error) { apiError(res, error, 'Failed to load provider availability'); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/playback/providers') {
    const health = await engineHealth();
    json(res, health.status === 'down' ? 503 : 200, { status: health.status, providers: health.providers, count: health.providers.length }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/playback/resolve') {
    try { json(res, 200, await playbackResolve(req, url), { 'Cache-Control': 'no-store' }); }
    catch (error) { apiError(res, error, 'Playback resolution failed'); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/playback/refresh') {
    try {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        const error = new Error('A valid playback response id is required.');
        error.status = 400;
        throw error;
      }
      const result = await engineJson(`/v1/refresh/${encodeURIComponent(id)}`, { method: 'POST' });
      json(res, 200, result, { 'Cache-Control': 'no-store' });
    } catch (error) { apiError(res, error, 'Playback refresh failed'); }
    return;
  }

  json(res, 404, { error: 'API route not found' }, { 'Cache-Control': 'no-store' });
}

const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);

async function proxyEngine(req, res, url) {
  const target = new URL(`${ENGINE_URL}${url.pathname}${url.search}`);
  const headers = { ...req.headers, host: target.host };
  delete headers['content-length'];

  const upstream = http.request(target, { method: req.method, headers }, (upstreamRes) => {
    const origin = requestOrigin(req);
    const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
    const isJson = contentType.includes('application/json');
    const isManifest = contentType.includes('mpegurl') || contentType.includes('m3u8');

    if (isJson || isManifest) {
      const chunks = [];
      let size = 0;
      upstreamRes.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 6 * 1024 * 1024) chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        if (size > 6 * 1024 * 1024) {
          send(res, 502, 'Playback response too large to rewrite safely.', { 'Content-Type': 'text/plain; charset=utf-8' });
          return;
        }
        let body = Buffer.concat(chunks).toString('utf8').split(ENGINE_URL).join(origin || ENGINE_URL);
        if (isJson) {
          try {
            const parsed = JSON.parse(body);
            const rewritten = rewritePayload(parsed, origin);
            if (url.pathname === '/v1' && rewritten && typeof rewritten === 'object') rewritten.name = 'Payson’s Movies Playback';
            body = JSON.stringify(rewritten);
          } catch {}
        }
        const responseHeaders = { ...upstreamRes.headers };
        for (const name of hopByHopHeaders) delete responseHeaders[name];
        delete responseHeaders['content-length'];
        responseHeaders['Content-Length'] = Buffer.byteLength(body);
        responseHeaders['Cache-Control'] = 'no-store';
        res.writeHead(upstreamRes.statusCode || 502, { ...baseSecurityHeaders, ...responseHeaders });
        res.end(body);
      });
      return;
    }

    const responseHeaders = { ...upstreamRes.headers };
    for (const name of hopByHopHeaders) delete responseHeaders[name];
    if (responseHeaders.location) responseHeaders.location = rewriteInternalUrl(responseHeaders.location, origin);
    res.writeHead(upstreamRes.statusCode || 502, { ...baseSecurityHeaders, ...responseHeaders });
    upstreamRes.pipe(res);
  });

  upstream.on('error', (error) => {
    if (!res.headersSent) json(res, 502, { error: 'Playback backend unavailable', detail: error.message }, { 'Cache-Control': 'no-store' });
    else res.destroy(error);
  });

  req.pipe(upstream);
}

async function serveVendor(res, pathname) {
  if (pathname !== '/vendor/hls.min.js') return false;
  const vendorPath = path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  try {
    const body = await readFile(vendorPath);
    send(res, 200, body, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400, immutable' });
  } catch {
    send(res, 404, 'hls.js is not installed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  return true;
}

async function serveStatic(res, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  try { requested = decodeURIComponent(requested); }
  catch { send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }

  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) && resolved !== path.join(publicDir, 'index.html')) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not-file');
    const extension = path.extname(resolved).toLowerCase();
    const cacheControl = requested === '/sw.js' ? 'no-cache' : extension === '.html' ? 'no-cache' : 'public, max-age=3600';
    send(res, 200, await readFile(resolved), { 'Content-Type': MIME.get(extension) || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': cacheControl });
  } catch {
    if (path.extname(requested)) {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return;
    }
    const indexPath = path.join(publicDir, 'index.html');
    send(res, 200, await readFile(indexPath), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/stremio/') || url.pathname.startsWith('/mcp/')) {
      await proxyEngine(req, res, url);
      return;
    }

    if (await serveVendor(res, url.pathname)) return;
    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error('[Payson’s Movies] Request failure:', error);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error' }, { 'Cache-Control': 'no-store' });
    else res.destroy(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Payson’s Movies running on http://${HOST}:${PORT}`);
  console.log(`[Payson’s Movies] Playback engine: ${ENGINE_URL}`);
  if (!TMDB_API_KEY) console.warn('[Payson’s Movies] Set TMDB_API_KEY in Bonto, then restart the app.');
});
