# Payson’s Movies

Payson’s Movies is a custom movie and TV interface built on top of the original **CinePro Core** playback engine. The goal of this repository is to replace the stock frontend experience while keeping the backend provider/resolver functionality intact.

## Architecture

```text
Browser
  │
  ├─ Payson’s Movies UI
  │    ├─ TMDB discovery / metadata
  │    ├─ custom full-screen player
  │    ├─ server / quality / audio / subtitle controls
  │    └─ playback history + resume
  │
  └─ same-origin playback API
       │
       └─ CinePro Core (private localhost child process)
            └─ OMSS providers / source resolution
```

CinePro Core runs on a private loopback port. The public Bonto port is owned by Payson’s Movies, which exposes the custom UI plus same-origin playback routes. The browser does not need a second backend URL.

## Features

- Payson’s Movies custom glass-era branding and UI
- TMDB-powered discovery, search, artwork, cast, recommendations, seasons, and episodes
- CinePro Core provider discovery and OMSS movie/TV source resolution
- all streamable sources returned by the backend remain available in the server picker
- automatic source ranking using quality plus measured startup latency and recent reliability
- automatic failover when a source fails
- one automatic source-list refresh after every current source fails
- manual server selection
- HLS.js playback plus native-HLS fallback
- direct browser-supported video playback
- HLS adaptive quality selection
- HLS audio-track selection
- WebVTT and basic SRT subtitle support
- playback speed control
- season / episode selection and automatic next episode
- resume position saved locally
- separate Watch Now and Trailer actions
- provider availability fallback when no playable source is returned
- PWA shell caching that explicitly avoids caching media/proxy traffic

## Bonto deployment

The only required secret is:

```env
TMDB_API_KEY=your_tmdb_v3_api_key_here
```

Bonto runs:

```bash
npm start
```

which starts `start.mjs`. The supervisor launches CinePro Core privately, waits for it to become available, then starts the Payson’s Movies public server.

You do not need to configure a second Bonto project or manually set `PORT`.

## Optional CinePro settings

The supervisor passes through the normal CinePro settings. These are optional:

```env
CACHE_TYPE=memory
STREMIO_ADDON=false
MCP_ENABLED=false
CORS_ORIGIN=*
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

Memory cache is used by default, so Redis is not required.

## Endpoints

Payson’s Movies endpoints:

```text
GET  /api/health
GET  /api/home
GET  /api/search?q=...
GET  /api/title/:type/:tmdbId
GET  /api/tv/:tmdbId/season/:season
GET  /api/playback/providers
GET  /api/playback/resolve?type=movie&id=...
GET  /api/playback/resolve?type=tv&id=...&season=...&episode=...
POST /api/playback/refresh
```

The underlying OMSS interface is also proxied on the same origin under `/v1/*`. If enabled, Stremio routes are proxied under `/stremio/*`.

## Validation

```bash
npm run check
```

## Third-party software

This project depends on CinePro Core and hls.js. Their original licenses and upstream attribution remain applicable. Payson’s Movies branding applies to this repository’s own UI and integration layer; it does not change third-party authorship or licensing.
