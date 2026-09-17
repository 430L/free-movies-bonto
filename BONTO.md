# Bonto setup

Payson’s Movies is configured so Bonto needs only one user-supplied secret.

## Required secret

```env
TMDB_API_KEY=your_tmdb_v3_api_key_here
```

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

No build command is required and there are no runtime npm dependencies to install.

## Health check

After deployment, open:

```text
https://YOUR-BONTO-DOMAIN/api/health
```

A correctly configured deployment returns JSON with `ok: true` and `configured: true`. Then open the root Bonto URL for the full UI.
