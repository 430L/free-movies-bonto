# Payson’s Movies

Payson’s Movies is a custom movie and TV discovery site with a premium cinematic glass interface. It is designed to deploy cleanly on Bonto with **one secret** and no runtime npm dependencies.

## Current build

- Original Payson’s Movies branding and film-reel glass logo
- Responsive desktop + mobile glass UI
- Rotating featured marquee
- Trending, top movies, now playing, prestige TV, and coming soon shelves
- Movie / TV browsing filters
- Live TMDB search
- Full title detail view
- Cast, metadata, ratings, recommendations, and similar titles
- YouTube trailer playback
- Local My List watchlist
- Local Recently Viewed history
- Keyboard-accessible cards and controls
- Installable PWA shell
- Zero-dependency Node 20+ backend
- Bonto-safe dynamic `PORT` handling
- Server-side TMDB key protection
- API response caching and request timeouts
- Basic security headers and CSP

## Bonto deployment

1. Import this repository in Bonto.
2. Add one environment variable:

```env
TMDB_API_KEY=your_tmdb_v3_api_key_here
```

3. Use the default start script:

```bash
npm start
```

That runs `node server.js`. You do **not** need to configure `PORT`, `HOST`, Redis, Docker, a database, or a build command.

## Local development

Create `.env` from `.env.example`, set `TMDB_API_KEY`, then run:

```bash
npm start
```

Open `http://localhost:3000`.

## Validation

```bash
npm run check
```

The project has no external Node runtime dependencies.

## Playback scope

This build uses TMDB for discovery metadata/images and YouTube for trailers. It does not bundle or proxy third-party copyrighted movie streams. Licensed or self-hosted playback can be connected later through a dedicated backend playback route.
