# Bonto settings

The repository is preconfigured for Bonto.

Required secret:

```text
TMDB_API_KEY=<your TMDB v3 API key>
```

No other environment variables are required.

Expected startup sequence:

```text
npm install
npm start
[cinepro-bonto] Starting CinePro Core on 0.0.0.0:<Bonto PORT>
```

If Bonto shows an install in progress, wait for it to finish and restart once. You should not see the old repeating `tsc` / `nodemon restarting due to changes` loop because this launcher does not run `tsc` at startup.
