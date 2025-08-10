// index.js
const { addonBuilder } = require('stremio-addon-sdk');
const { fetch } = require('undici');

// ---------- Manifest ----------
const manifest = {
  id: 'org.yourname.ai.gemini.recs',
  version: '1.1.0',
  name: 'AI Recs (Gemini)',
  description: 'Personalized movie & series picks via Gemini, using your Trakt history.',
  logo: 'https://stremio.com/asset-src/img/icon.png',
  resources: ['catalog'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie',  id: 'ai_recs_movies',  name: '🎯 For You — Movies'  },
    { type: 'series', id: 'ai_recs_series',  name: '🎯 For You — Series'  }
  ],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: true, configurationRequired: true },
  config: [
    { key: 'geminiKey',     type: 'text',  secret: true, title: 'Gemini API Key' },
    { key: 'traktClientId', type: 'text',  title: 'Trakt Client ID' },
    { key: 'traktUser',     type: 'text',  title: 'Trakt Username' },
    { key: 'locale',        type: 'text',  title: 'Preferred country (e.g. IN, US)', default: 'IN' }
  ]
};

const builder = new addonBuilder(manifest);

// ---------- Small cache ----------
const cache = new Map();
const putCache = (k, v, ttlMs = 1000 * 60 * 60 * 3) => cache.set(k, { v, exp: Date.now() + ttlMs });
const getCache = (k) => {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.exp) { cache.delete(k); return null; }
  return hit.v;
};

// ---------- Trakt helpers ----------
async function getTraktJson(path, clientId) {
  const r = await fetch(`https://api.trakt.tv/${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId
    }
  });
  if (!r.ok) throw new Error(`Trakt ${path} -> ${r.status}`);
  return r.json();
}

function normalize(arr, key) {
  return (arr || []).map(x => {
    const o = key ? x[key] : x;
    return {
      title: o?.title,
      year: o?.year,
      imdb: o?.ids?.imdb,
      slug: o?.ids?.slug
    };
  }).filter(x => x.imdb);
}

async function getCandidatePool(kind, clientId) {
  const cacheKey = `pool:${kind}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const endpoints = [
    `${kind}/trending?limit=60`,
    `${kind}/popular?limit=60`,
    `${kind}/anticipated?limit=60`,
    `${kind}/played/weekly?limit=60`
  ];
  const res = await Promise.allSettled(endpoints.map(p => getTraktJson(p, clientId)));
  const chunks = res.flatMap((r, i) => {
    if (r.status !== 'fulfilled') return [];
    if (i === 0) return normalize(r.value, kind === 'movies' ? 'movie' : 'show');
    return normalize(r.value);
  });

  const seen = new Set();
  const pool = [];
  for (const it of chunks) if (!seen.has(it.imdb)) { seen.add(it.imdb); pool.push(it); }

  putCache(cacheKey, pool, 1000 * 60 * 60 * 2); // 2h
  return pool;
}

async function getWatchedUser(kind, username, clientId, limit = 200) {
  const cacheKey = `watched:${kind}:${username}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const path = `users/${encodeURIComponent(username)}/history/${kind === 'movies' ? 'movies' : 'shows'}?limit=${limit}`;
  const hist = await getTraktJson(path, clientId);
  const watched = (hist || [])
    .map(h => (kind === 'movies' ? h.movie : h.show))
    .map(o => o?.ids?.imdb)
    .filter(Boolean);

  putCache(cacheKey, watched, 1000 * 60 * 15); // 15m
  return watched;
}

// ---------- Gemini ranking ----------
const SCHEMA = {
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          imdb: { type: 'string' },
          score: { type: 'number' },
          reason: { type: 'string' }
        },
        required: ['imdb', 'score']
      }
    }
  },
  required: ['recommendations']
};

async function rankWithGemini({ key, kindLabel, watched, pool, locale = 'IN' }) {
  if (!key) return [];

  const profile = {
    locale,
    recentlyWatchedImdb: watched.slice(0, 250),
    pool: pool.slice(0, 150)
  };

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text:
`You are a recommender system for ${kindLabel}.
- Prefer high quality, discovery-friendly picks.
- STRICTLY exclude anything in recentlyWatchedImdb.
- Encourage variety: avoid same franchise/director back-to-back if possible.
- Return up to 30 results as JSON (schema provided).

DATA:
${JSON.stringify(profile)}`
          }]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
          temperature: 0.4,
          topP: 0.8
        }
      })
    }
  );

  if (!r.ok) return [];
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) return [];
  try { return JSON.parse(txt)?.recommendations || []; }
  catch { return []; }
}

function finalizeMetas(kind, ranked, pool, watched) {
  const byImdb = new Map(pool.map(p => [p.imdb, p]));
  const seenSlug = new Set();
  const skip = new Set(watched);

  const metas = [];
  for (const r of ranked.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    if (!r?.imdb || skip.has(r.imdb)) continue;
    const base = byImdb.get(r.imdb);
    if (!base) continue;
    if (base.slug && seenSlug.has(base.slug)) continue;
    seenSlug.add(base.slug);

    metas.push({
      id: r.imdb,
      type: kind === 'movies' ? 'movie' : 'series',
      name: base.title || r.imdb,
      posterShape: 'regular'
    });
    if (metas.length >= 30) break;
  }
  return metas;
}

// ---------- Catalog handler ----------
builder.defineCatalogHandler(async ({ config, type, id }) => {
  const isMovies = type === 'movie'  && id === 'ai_recs_movies';
  const isSeries = type === 'series' && id === 'ai_recs_series';
  if (!isMovies && !isSeries) return { metas: [] };

  const geminiKey     = process.env.GEMINI_API_KEY   || config?.geminiKey;
  const traktClientId = process.env.TRAKT_CLIENT_ID  || config?.traktClientId;
  const traktUser     = process.env.TRAKT_USERNAME   || config?.traktUser;
  const locale        = process.env.PREFERRED_LOCALE || config?.locale || 'IN';

  if (!geminiKey || !traktClientId || !traktUser) return { metas: [] };

  const kind = isMovies ? 'movies' : 'shows';
  const kindLabel = isMovies ? 'movies' : 'series';

  try {
    const [pool, watched] = await Promise.all([
      getCandidatePool(kind, traktClientId),
      getWatchedUser(kind, traktUser, traktClientId)
    ]);

    const ranked = await rankWithGemini({ key: geminiKey, kindLabel, watched, pool, locale });

    const metas = (ranked?.length ? finalizeMetas(kind, ranked, pool, watched)
                                  : pool.filter(p => !watched.includes(p.imdb))
                                        .slice(0, 30)
                                        .map(p => ({ id: p.imdb, type: isMovies ? 'movie' : 'series', name: p.title, posterShape: 'regular' })));

    return { metas };
  } catch (e) {
    console.error('Catalog error:', e.message);
    return { metas: [] };
  }
});

// ---------- HTTP server ----------
// ===== keep everything above as-is =====

// Create the Stremio interface ONCE
const iface = builder.getInterface();

// Single request handler used for both serverless and Node server
function requestHandler(req, res) {
  try {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      return res.end('ok');
    }

    if (req.url === '/manifest.json') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(manifest));
    }

    // Delegate to Stremio Addon SDK interface
    return iface(req, res);
  } catch (e) {
    console.error('Top-level handler error:', e && e.stack ? e.stack : e);
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    return res.end('Server error: ' + (e?.message || 'unknown'));
  }
}

// Export handler for serverless-like platforms
module.exports = requestHandler;

// Start HTTP server when run with `node index.js` (Render runs this)
if (require.main === module) {
  const http = require('http');
  const PORT = process.env.PORT || 7080; // Render provides PORT
  http.createServer(requestHandler)
      .listen(PORT, () => console.log(`AI Recs (Gemini) listening on http://localhost:${PORT}/manifest.json`));
}