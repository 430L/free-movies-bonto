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
const CACHE_TTL = 10 * 60 * 1000;
const FETCH_TIMEOUT = 12000;
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
  ['.webp', 'image/webp']
]);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' https://image.tmdb.org data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self'",
    "connect-src 'self'",
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders, ...headers });
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

async function tmdb(pathname, searchParams = {}) {
  if (!TMDB_API_KEY) {
    const error = new Error('TMDB_API_KEY is not configured on this deployment.');
    error.status = 503;
    throw error;
  }

  const qs = new URLSearchParams({
    api_key: TMDB_API_KEY,
    language: 'en-US',
    ...searchParams
  });
  const cacheKey = `${pathname}?${new URLSearchParams(searchParams).toString()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(`${TMDB_BASE}${pathname}?${qs.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`TMDB request failed (${response.status}): ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }

    return setCached(cacheKey, await response.json());
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('TMDB request timed out.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeItem(item, typeHint) {
  if (!item) return null;

  const mediaType = item.media_type && item.media_type !== 'person'
    ? item.media_type
    : typeHint || (item.title ? 'movie' : 'tv');

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
  return (
    videos.find((video) => video.site === 'YouTube' && video.type === 'Trailer' && video.official) ||
    videos.find((video) => video.site === 'YouTube' && video.type === 'Trailer') ||
    videos.find((video) => video.site === 'YouTube' && video.type === 'Teaser') ||
    videos.find((video) => video.site === 'YouTube') ||
    null
  );
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
      {
        id: 'trending',
        title: 'Trending Now',
        subtitle: 'Live picks from across film and television',
        items: (trending.results || []).filter((item) => item.media_type !== 'person').map((item) => normalizeItem(item, item.media_type)).filter(Boolean)
      },
      {
        id: 'top-movies',
        title: 'Top Movies',
        subtitle: 'Critically loved feature films',
        items: (topMovies.results || []).map((item) => normalizeItem(item, 'movie')).filter(Boolean)
      },
      {
        id: 'now-playing',
        title: 'Now Playing',
        subtitle: 'Fresh theatrical releases and current buzz',
        items: (nowPlaying.results || []).map((item) => normalizeItem(item, 'movie')).filter(Boolean)
      },
      {
        id: 'top-tv',
        title: 'Prestige Television',
        subtitle: 'Award-winning series and must-watch shows',
        items: (topTV.results || []).map((item) => normalizeItem(item, 'tv')).filter(Boolean)
      },
      {
        id: 'coming-soon',
        title: 'Coming Soon',
        subtitle: 'Upcoming releases worth tracking',
        items: (upcoming.results || []).map((item) => normalizeItem(item, 'movie')).filter(Boolean)
      }
    ],
    genres: {
      movie: genresMovie.genres || [],
      tv: genresTv.genres || []
    }
  };
}

async function titleResponse(mediaType, id) {
  const details = await tmdb(`/${mediaType}/${id}`, {
    append_to_response: 'credits,videos,recommendations,similar,release_dates,content_ratings'
  });

  const cast = (details.credits?.cast || []).slice(0, 14).map((member) => ({
    id: member.id,
    name: member.name,
    character: member.character,
    profile_path: member.profile_path
  }));
  const crew = (details.credits?.crew || [])
    .filter((member) => ['Director', 'Writer', 'Screenplay', 'Creator', 'Executive Producer'].includes(member.job))
    .slice(0, 10);

  return {
    ...details,
    media_type: mediaType,
    display_title: details.title || details.name || 'Untitled',
    display_date: details.release_date || details.first_air_date || '',
    trailer: findTrailer(details),
    cast,
    crew,
    rating: certificationFor(details, mediaType),
    recommendations: (details.recommendations?.results || []).slice(0, 18).map((item) => normalizeItem(item, mediaType)).filter(Boolean),
    similar: (details.similar?.results || []).slice(0, 18).map((item) => normalizeItem(item, mediaType)).filter(Boolean),
    poster_url: details.poster_path ? `${IMAGE_BASE}/w500${details.poster_path}` : null,
    backdrop_url: details.backdrop_path ? `${IMAGE_BASE}/w1280${details.backdrop_path}` : null
  };
}

async function handleApi(req, res, url) {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    return;
  }

  if (url.pathname === '/api/health') {
    json(res, 200, {
      ok: true,
      name: 'Payson’s Movies',
      configured: Boolean(TMDB_API_KEY),
      version: '1.1.0'
    }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (url.pathname === '/api/config') {
    json(res, 200, {
      appName: 'Payson’s Movies',
      imageBase: IMAGE_BASE,
      logo: '/assets/logo.svg'
    }, { 'Cache-Control': 'public, max-age=3600' });
    return;
  }

  if (url.pathname === '/api/home') {
    try {
      json(res, 200, await homeResponse(), { 'Cache-Control': 'public, max-age=120, stale-while-revalidate=300' });
    } catch (error) {
      apiError(res, error, 'Failed to load home data');
    }
    return;
  }

  if (url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!query) {
      json(res, 200, { query: '', results: [] }, { 'Cache-Control': 'no-store' });
      return;
    }

    try {
      const data = await tmdb('/search/multi', { query, include_adult: 'false', page: '1' });
      const results = (data.results || [])
        .filter((item) => item.media_type !== 'person' && (item.poster_path || item.backdrop_path))
        .map((item) => normalizeItem(item, item.media_type))
        .filter(Boolean);
      json(res, 200, { query, results }, { 'Cache-Control': 'private, max-age=60' });
    } catch (error) {
      apiError(res, error, 'Search failed');
    }
    return;
  }

  const match = url.pathname.match(/^\/api\/title\/(movie|tv)\/(\d+)$/);
  if (match) {
    try {
      json(res, 200, await titleResponse(match[1], match[2]), { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' });
    } catch (error) {
      apiError(res, error, 'Failed to load title details');
    }
    return;
  }

  json(res, 404, { error: 'API route not found' }, { 'Cache-Control': 'no-store' });
}

async function serveStatic(res, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  try {
    requested = decodeURIComponent(requested);
  } catch {
    send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) && resolved !== path.join(publicDir, 'index.html')) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not-file');
    const extension = path.extname(resolved).toLowerCase();
    const cacheControl = requested === '/sw.js'
      ? 'no-cache'
      : extension === '.html'
        ? 'no-cache'
        : 'public, max-age=3600';
    send(res, 200, await readFile(resolved), {
      'Content-Type': MIME.get(extension) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cacheControl
    });
  } catch {
    if (path.extname(requested)) {
      send(res, 404, 'Not found', {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return;
    }

    const indexPath = path.join(publicDir, 'index.html');
    const body = await readFile(indexPath);
    send(res, 200, body, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error('[Payson’s Movies] Request failure:', error);
    json(res, 500, { error: 'Internal server error' }, { 'Cache-Control': 'no-store' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Payson’s Movies running on http://${HOST}:${PORT}`);
  if (!TMDB_API_KEY) console.warn('[Payson’s Movies] Set TMDB_API_KEY in Bonto, then restart the app.');
});
