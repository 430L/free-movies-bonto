# Payson’s Movies

Payson’s Movies is a custom movie and TV discovery site with a premium cinematic glass interface and a first-party playback layer for **authorized HLS/MP4 media sources**.

## Current build

- Original Payson’s Movies branding and film-reel glass logo
- Responsive desktop + mobile glass UI
- Rotating featured marquee
- Trending, top movies, now playing, prestige TV, and coming soon shelves
- Movie / TV browsing filters
- Live TMDB search
- Full title detail view
- Cast, metadata, ratings, recommendations, and similar titles
- Dedicated **Watch Now** flow plus separate trailers
- HLS playback with `hls.js` and native HLS fallback
- Direct MP4 playback
- Automatic fastest/healthy server selection
- Automatic server failover after playback errors
- Manual server selector
- HLS quality selection
- HLS audio-track selection
- External WebVTT subtitle selection
- Playback speed controls
- Season + episode navigation for TV
- Resume position and episode autoplay
- Client-side startup latency memory for smarter future server selection
- Server-side source health probing and failure penalties
- TMDB watch-provider fallback when no direct source is configured
- Local My List watchlist and Recently Viewed history
- Keyboard-accessible cards and controls
- Installable PWA shell
- Bonto-safe dynamic `PORT` handling
- Server-side TMDB key protection
- API response caching and request timeouts
- Basic security headers and CSP

## Bonto deployment

1. Import this repository in Bonto.
2. Add the required environment variable:

```env
TMDB_API_KEY=your_tmdb_v3_api_key_here
```

3. Use the repository default start command:

```bash
npm start
```

Bonto supplies `PORT`; the app binds to `0.0.0.0` automatically. `npm install` installs the single browser playback dependency, `hls.js`.

## Direct playback sources

Direct playback is intentionally source-agnostic. Add media that you own, host, or are authorized to stream by creating a local `playback-sources.json` using `playback-sources.example.json` as the schema, or by supplying the same JSON through `PLAYBACK_SOURCES_JSON`.

Keys use TMDB IDs:

```text
movie:<tmdbId>
tv:<tmdbId>:<season>:<episode>
```

Example:

```json
{
  "movie:12345": [
    {
      "id": "primary",
      "name": "Payson Server 1",
      "url": "https://media.example.com/movie/master.m3u8",
      "type": "hls",
      "quality": "Auto"
    },
    {
      "id": "backup",
      "name": "Payson Server 2",
      "url": "https://backup.example.com/movie.mp4",
      "type": "mp4",
      "quality": "1080p"
    }
  ]
}
```

The backend probes each registered source, ranks healthy sources by latency and recent failures, and returns the ordered list. The browser also remembers real startup latency and can rotate automatically when a source fails.

For HLS, the media origin should allow browser CORS access. This application does not implement a generic open proxy or bypass access controls on third-party hosts.

## Playback API

```text
GET  /api/playback/resolve?type=movie&id=<tmdbId>
GET  /api/playback/resolve?type=tv&id=<tmdbId>&season=<n>&episode=<n>
POST /api/playback/report
GET  /api/tv/<tmdbId>/season/<season>
GET  /api/watch/<movie|tv>/<tmdbId>
```

`/api/playback/report` feeds success/failure and startup latency back into the in-memory ranking system.

## Local development

Create `.env` from `.env.example`, set `TMDB_API_KEY`, then run:

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Validation

```bash
npm run check
```

## Branding

All application-owned user-facing playback, server, UI, and health surfaces are branded as **Payson’s Movies**. Third-party license and attribution requirements must remain intact for any dependency you use.
