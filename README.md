# AI Recs (Gemini) — Stremio Add-on

This add-on shows **For You — Movies/Series** catalogs personalized from your **Trakt history** and ranked by **Gemini**.

## Run locally

```bash
# 1) Install dependencies
npm install

# 2) Set env vars (macOS/Linux)
export GEMINI_API_KEY=YOUR_KEY
export TRAKT_CLIENT_ID=YOUR_ID
export TRAKT_USERNAME=your_trakt_username
export PREFERRED_LOCALE=IN

# Windows PowerShell:
# $env:GEMINI_API_KEY="YOUR_KEY"
# $env:TRAKT_CLIENT_ID="YOUR_ID"
# $env:TRAKT_USERNAME="your_trakt_username"
# $env:PREFERRED_LOCALE="IN"

# 3) Start
node index.js
```

In Stremio → Add-ons → Community → Install via URL:
```
http://localhost:7080/manifest.json
```

## Deploy on Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. `vercel` to deploy.
3. Add env vars: `GEMINI_API_KEY`, `TRAKT_CLIENT_ID`, `TRAKT_USERNAME`, `PREFERRED_LOCALE`
4. Use the deployment URL `/manifest.json` in Stremio.
