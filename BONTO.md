# Bonto setup

Payson’s Movies is designed to run the custom frontend and the original CinePro Core backend inside one Bonto app.

## Required

Set one environment variable:

```env
TMDB_API_KEY=your_tmdb_v3_api_key_here
```

Then deploy the repository normally. Bonto installs the npm dependencies and runs:

```bash
npm start
```

## What starts

`start.mjs` launches the playback engine on a private `127.0.0.1` port and then starts the Payson’s Movies public server on Bonto’s assigned `PORT`.

Do not manually set the public `PORT` or `HOST`.

## Health check

Open:

```text
https://YOUR-BONTO-DOMAIN/api/health
```

A healthy deployment should report:

```json
{
  "ok": true,
  "name": "Payson’s Movies",
  "tmdb": "configured",
  "playback": "operational"
}
```

The `providers` count confirms that the playback backend discovered providers.

## Optional backend configuration

These are not required for the normal Bonto configuration, but remain supported:

```env
CACHE_TYPE=memory
STREMIO_ADDON=false
MCP_ENABLED=false
CORS_ORIGIN=*
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

Use Redis only if you intentionally configure an external Redis service.

## Troubleshooting

If metadata works but Watch Now does not, check `/api/health`. If `playback` is `down`, inspect the Bonto console for lines prefixed with `[Payson playback]`. The public site can remain online even if the child playback process is restarting.
