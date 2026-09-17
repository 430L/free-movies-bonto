# CinePro Core — Bonto Edition

A Bonto-specific launcher for [CinePro Core](https://github.com/cinepro-org/core) that removes the deployment configuration work that caused restart loops on Bonto.

## What you need to configure

Only one environment variable:

```text
TMDB_API_KEY=your_tmdb_api_key
```

Everything else is handled automatically:

- Uses Bonto's injected `PORT`
- Binds CinePro to `0.0.0.0`
- Uses in-memory caching, so Redis is not required
- Enables permissive CORS (`*`)
- Disables Stremio and MCP by default
- Runs the TypeScript server directly with `tsx`
- Does not compile to `dist/` at startup, avoiding Bonto's file-watcher restart loop
- Targets Node.js 20, Bonto's default runtime

## Deploy to Bonto

1. Upload these files to a GitHub repository.
2. Connect/import that repository into Bonto.
3. In Bonto, add one Environment Variable / Secret:

   ```text
   TMDB_API_KEY = <your TMDB v3 API key>
   ```

4. Let Bonto install dependencies and start the app.

Do not manually add `PORT`, `HOST`, Redis variables, `CACHE_TYPE`, or `NODE_ENV`.

Bonto detects `package.json`, runs `npm install`, runs the `start` script, and injects `PORT` automatically.

## Why this is structured as a launcher

The upstream CinePro repository's normal `start` command compiles TypeScript into `dist/` before launching. Bonto automatically restarts Node apps when project files change, so writing `dist/` during startup can produce a build/restart loop. This edition installs upstream CinePro Core as a dependency and starts its source directly, so startup does not modify watched project files.

The upstream package is intentionally kept separate so provider updates can continue coming from `cinepro-org/core` without maintaining a second copy of every provider.

## Upstream

CinePro Core: https://github.com/cinepro-org/core

CinePro Core is distributed under its upstream license and terms. This launcher does not host media itself; use it only in ways permitted by applicable law and provider terms.
