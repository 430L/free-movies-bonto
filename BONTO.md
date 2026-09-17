# Bonto setup

Payson’s Movies is configured for a simple Bonto deployment.

## Required secret

```env
TMDB_API_KEY=your_tmdb_v3_api_key_here
```

## Optional direct playback catalog

Direct HLS/MP4 playback uses media sources that you own, host, or are authorized to stream. You can supply them in either of two ways:

1. Commit a `playback-sources.json` file based on `playback-sources.example.json` **if the URLs are safe to keep in the repository**.
2. Put the same JSON in a Bonto environment variable named `PLAYBACK_SOURCES_JSON` if the URLs should stay private.

The only required credential remains `TMDB_API_KEY`; playback source configuration is optional.

## Do not manually set

- `PORT`
- `HOST`
- Redis variables
- Docker settings
- build output paths

Bonto supplies `PORT`, and the server automatically binds to `0.0.0.0`.

## Start command

Use the repository default:

```bash
npm start
```

Bonto should run dependency installation before startup. The only npm runtime dependency is `hls.js`, served locally to the browser at `/vendor/hls.min.js`.

## Health check

After deployment, open:

```text
https://YOUR-BONTO-DOMAIN/api/health
```

A correctly configured deployment returns JSON similar to:

```json
{
  "ok": true,
  "name": "Payson’s Movies",
  "configured": true,
  "playbackConfigured": true,
  "version": "1.2.0"
}
```

`playbackConfigured` is `false` when no direct media catalog has been supplied; discovery, metadata, trailers, and TMDB watch-provider links still work in that state.

## Performance behavior

For every configured title/episode, Payson’s Movies:

- probes registered servers with a short timeout,
- ranks online servers ahead of offline servers,
- factors server latency and recent failures into ranking,
- remembers real browser startup latency,
- selects the best server automatically,
- rotates to another healthy server after fatal playback errors,
- lets the viewer override server, quality, audio, subtitles, and playback speed.
