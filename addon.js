// addon.js
// TugaMovies by Ze — external-player Stremio add-on
// • External players only (YouTube filtered out)
// • Posters/Backgrounds: TMDB (if TMDB_API_KEY set) else IMDb (suggest fast → HTML fallback), cached on disk
// • Description: EXACT first <p> inside the first <div> immediately after <h2> that contains "Sinopse"
// • Configurable IMDb rate limit + poster concurrency
//
// Env (optional):
//   TMDB_API_KEY=...        -> prefer TMDB art (HQ)
//   IMDB_MAX_RPS=20         -> IMDb requests per second (default 10; 0 disables limiting)
//   POSTER_CONCURRENCY=12   -> parallel poster lookups (default 8)
//
// Requires: npm i stremio-addon-sdk cheerio

const { addonBuilder } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ───────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────
const SITE = 'https://osteusfilmestuga.online';
const CATALOG_URL = `${SITE}/filmes/`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const IMDB_MAX_RPS = Number(process.env.IMDB_MAX_RPS ?? '10'); // 0 = no limit
const POSTER_CONCURRENCY = Number(process.env.POSTER_CONCURRENCY ?? '8');

const EXCLUDE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'youtu.be']);

// Persistent cache file
const CACHE_FILE = path.join(__dirname, 'cache-posters.json');

// In-memory + persistent caches
const imdbFindCache = new Map();   // title(lower) -> imdb title URL
const posterCache = new Map();     // title(lower) -> poster URL (TMDB or IMDb)

// ───────────────────────────────────────────────────────────
// Cache load/save
// ───────────────────────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        const p = data.posterCache || {};
        const f = data.imdbFindCache || {};
        for (const [k, v] of Object.entries(p)) posterCache.set(k, v);
        for (const [k, v] of Object.entries(f)) imdbFindCache.set(k, v);
        log('CACHE loaded', `posters=${posterCache.size}`, `finds=${imdbFindCache.size}`);
      }
    }
  } catch (e) {
    console.error('[ADDON] CACHE load error:', e.message);
  }
}
let saveTimer = null;
function scheduleSaveCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj = {
        posterCache: Object.fromEntries(posterCache.entries()),
        imdbFindCache: Object.fromEntries(imdbFindCache.entries()),
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
      log('CACHE saved', `posters=${posterCache.size}`, `finds=${imdbFindCache.size}`);
    } catch (e) {
      console.error('[ADDON] CACHE save error:', e.message);
    }
  }, 400);
}
process.on('SIGINT', () => { if (saveTimer) clearTimeout(saveTimer); scheduleSaveCache(); setTimeout(() => process.exit(0), 150); });
process.on('SIGTERM', () => { if (saveTimer) clearTimeout(saveTimer); scheduleSaveCache(); setTimeout(() => process.exit(0), 150); });

// ───────────────────────────────────────────────────────────
// Manifest
// ───────────────────────────────────────────────────────────
const manifest = {
  id: 'org.tugamovies.ze',
  version: '1.6.0',
  name: 'TugaMovies by Ze',
  description:
    'Catalog + external players from osteusfilmestuga.online. HQ art via TMDB/IMDb (cached). Portuguese sinopse as description.',
  catalogs: [
    { type: 'movie', id: 'osteus-filmes', name: 'TugaMovies by Ze', extra: [{ name: 'skip' }, { name: 'search' }] },
  ],
  resources: ['catalog', 'stream', 'meta'],
  types: ['movie'],
  idPrefixes: ['tuga:'],
};

const builder = new addonBuilder(manifest);

// ───────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────
const log = (...a) => console.log('[ADDON]', ...a);

function toIdFromSlug(slug) { return `tuga:${slug}`; }
function fromIdToSlug(id) { return id.replace(/^tuga:/, ''); }
function normalizeURL(href, base = SITE) { try { return new URL(href, base).toString(); } catch { return ''; } }
function isFilmPath(u) { try { return new URL(u).pathname.startsWith('/filmes/'); } catch { return false; } }
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

async function fetchText(url, referer, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { 'user-agent': UA, accept };
    if (referer) headers.referer = referer;
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    log('FETCH OK', url, `(${text.length} bytes)`);
    return text;
  } finally { clearTimeout(timer); }
}
async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept': 'application/json,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function ellipsize(s, n = 500) {
  if (!s) return s;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function lowerKey(title) { return (title || '').trim().toLowerCase(); }

// ───────────────────────────────────────────────────────────
// IMDb rate limit
// ───────────────────────────────────────────────────────────
const imdbTimestamps = [];
function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isImdbHost(u) { try { return /(^|\.)imdb\.com$/i.test(new URL(u).hostname); } catch { return false; } }
async function maybeRateLimitIMDb(url) {
  if (IMDB_MAX_RPS <= 0) return; // disabled
  if (!isImdbHost(url)) return;
  while (true) {
    const t = nowMs();
    while (imdbTimestamps.length && t - imdbTimestamps[0] > 1000) imdbTimestamps.shift();
    if (imdbTimestamps.length < IMDB_MAX_RPS) { imdbTimestamps.push(t); return; }
    const wait = 1001 - (t - imdbTimestamps[0]);
    await sleep(wait > 5 ? wait : 5);
  }
}

// ───────────────────────────────────────────────────────────
// TMDB (preferred HQ art if key is set)
// ───────────────────────────────────────────────────────────
function tmdbImg(path, size = 'original') {
  if (!path) return undefined;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
async function tmdbSearchTitle(title) {
  if (!TMDB_KEY) return null;
  try {
    const q = encodeURIComponent(title.trim());
    const urlPT = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${q}&language=pt-PT`;
    const j = await fetchJSON(urlPT);
    if (j?.results?.length) return j.results[0];
    const urlAny = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${q}`;
    const k = await fetchJSON(urlAny);
    if (k?.results?.length) return k.results[0];
  } catch {}
  return null;
}
async function tmdbArtForTitle(title) {
  const hit = await tmdbSearchTitle(title);
  if (!hit) return { poster: undefined, backdrop: undefined };
  return {
    poster: tmdbImg(hit.poster_path, 'w500'),
    backdrop: tmdbImg(hit.backdrop_path, 'original') || tmdbImg(hit.poster_path, 'original'),
  };
}

// ───────────────────────────────────────────────────────────
// IMDb (fast path: suggestion API) + fallback: HTML find
// ───────────────────────────────────────────────────────────
function upscaleImdbImage(u) {
  // e.g. ..._V1_UX182_...jpg -> ..._V1_.jpg
  try {
    return u.replace(/\.(_V1_)[^\.]+(\.jpg|\.png)$/i, '._V1_$2');
  } catch { return u; }
}
async function imdbSuggest(title) {
  const q = title.normalize('NFKD').replace(/[^\w\s-]/g, ' ').trim();
  if (!q) return null;
  const first = q[0].toLowerCase();
  const url = `https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(first)}/${encodeURIComponent(q)}.json`;
  await maybeRateLimitIMDb(url);
  try {
    const j = await fetchJSON(url);
    const d = j?.d || [];
    const pick = d.find(it => it.id?.startsWith('tt')) || d[0];
    if (!pick) return null;
    return {
      id: pick.id,
      title: pick.l,
      year: pick.y,
      image: pick.i?.imageUrl ? upscaleImdbImage(pick.i.imageUrl) : undefined,
    };
  } catch { return null; }
}
async function imdbFindTitleUrl(rawTitle) {
  const key = lowerKey(rawTitle);
  if (imdbFindCache.has(key)) return imdbFindCache.get(key) || null;
  const q = encodeURIComponent(rawTitle.replace(/\s+/g, ' ').trim());
  if (!q) { imdbFindCache.set(key, null); scheduleSaveCache(); return null; }
  const searchUrl = `https://www.imdb.com/find/?q=${q}&s=tt`;
  await maybeRateLimitIMDb(searchUrl);
  try {
    const html = await fetchText(searchUrl, 'https://www.imdb.com/');
    const $ = cheerio.load(html);
    let href = $('a[href*="/title/tt"]').first().attr('href');
    if (!href) href = $('#main a[href*="/title/tt"]').first().attr('href');
    if (!href) { imdbFindCache.set(key, null); scheduleSaveCache(); return null; }
    const match = href.match(/\/title\/tt\d+/);
    const url = match ? `https://www.imdb.com${match[0]}/` : null;
    imdbFindCache.set(key, url);
    scheduleSaveCache();
    return url;
  } catch {
    imdbFindCache.set(key, null);
    scheduleSaveCache();
    return null;
  }
}
async function imdbDetailsByTitle(title) {
  // Try suggest first
  const s = await imdbSuggest(title);
  if (s?.image) return { image: s.image, description: undefined };

  // Fallback to HTML find → title page
  const url = await imdbFindTitleUrl(title);
  if (!url) return { image: undefined, description: undefined };
  await maybeRateLimitIMDb(url);
  try {
    const html = await fetchText(url, 'https://www.imdb.com/');
    const $ = cheerio.load(html);
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    return { image: ogImage || undefined, description: ogDesc || undefined };
  } catch {
    return { image: undefined, description: undefined };
  }
}

// Best poster: TMDB (if key) → IMDb (suggest fast, then HTML) → undefined
async function bestPosterForTitle(title) {
  const key = lowerKey(title);
  if (posterCache.has(key)) return posterCache.get(key) || undefined;

  // TMDB first
  if (TMDB_KEY) {
    try {
      const art = await tmdbArtForTitle(title);
      const chosen = art.poster || art.backdrop;
      if (chosen) {
        posterCache.set(key, chosen); scheduleSaveCache();
        return chosen;
      }
    } catch {}
  }
  // IMDb
  try {
    const det = await imdbDetailsByTitle(title);
    if (det.image) {
      posterCache.set(key, det.image); scheduleSaveCache();
      return det.image;
    }
  } catch {}

  posterCache.set(key, undefined); scheduleSaveCache();
  return undefined;
}

// ───────────────────────────────────────────────────────────
// Parse Portuguese "Sinopse" — strict rule you asked for:
// The FIRST <p> inside the FIRST <div> that is the immediate
// sibling AFTER an <h2> whose text contains "Sinopse" (case-insensitive).
// With graceful fallbacks for odd pages.
// ───────────────────────────────────────────────────────────
function extractSinopsePT_strict($) {
  // Find the <h2> with "Sinopse"
  const h2 = $('h2').filter((_, el) => /sinopse/i.test($(el).text().trim())).first();
  if (h2 && h2.length) {
    // Walk immediate siblings until we hit a tag; prefer the first <div>
    let node = h2.next();
    let hops = 0;
    while (node && node.length && hops < 8) {
      const n = node.get(0);
      if (n && n.type === 'tag') {
        // If it's the div right below h2, take its first <p>
        if (n.name === 'div') {
          const txt = node.find('p').first().text().trim();
          if (txt) return ellipsize(txt);
        }
        // Some pages might place a <p> directly after <h2>
        if (n.name === 'p') {
          const txt = node.text().trim();
          if (txt) return ellipsize(txt);
        }
        // If it's another container, peek inside for a <div><p>
        const inner = node.find('div p').first().text().trim();
        if (inner) return ellipsize(inner);
      }
      node = node.next();
      hops++;
    }
  }

  // Fallbacks: first good paragraph in .entry-content, then meta desc
  const paragraphs = $('.entry-content p').map((_, el) => $(el).text().trim()).get();
  const good = paragraphs.find(t => t.length > 80) || paragraphs[0] || '';
  if (good) return ellipsize(good);

  const metaD = $('meta[name="description"]').attr('content') ||
                $('meta[property="og:description"]').attr('content') || '';
  return ellipsize(metaD || '');
}

// ───────────────────────────────────────────────────────────
// Concurrency helper
// ───────────────────────────────────────────────────────────
async function pMapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      try { results[idx] = await mapper(items[idx], idx); }
      catch { results[idx] = undefined; }
    }
  });
  await Promise.all(workers);
  return results;
}

// ───────────────────────────────────────────────────────────
// Catalog
// ───────────────────────────────────────────────────────────
async function parseCatalogPage(page = 1, query = '') {
  let url = CATALOG_URL;
  if (query && query.trim()) {
    const qs = new URLSearchParams({ s: query.trim() }).toString();
    url = `${SITE}/?${qs}`;
  } else if (page > 1) {
    url = `${CATALOG_URL}page/${page}/`;
  }

  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const metas = [];

  $('a[href]').each((_, a) => {
    const href = normalizeURL($(a).attr('href'));
    if (!isFilmPath(href)) return;

    const slug = new URL(href).pathname.replace(/^\/filmes\//, '').replace(/\/+$/, '');
    if (!slug) return;

    const title =
      $(a).attr('title') ||
      $(a).find('img[alt]').attr('alt') ||
      $(a).text().replace(/\s+/g, ' ').trim();

    const posterSite =
      $(a).find('img').attr('data-src') ||
      $(a).find('img').attr('src') ||
      (($(a).find('img').attr('srcset') || '').split(' ')[0] || '');

    metas.push({
      id: toIdFromSlug(slug),
      type: 'movie',
      name: title || slug.replace(/-/g, ' '),
      poster: posterSite || undefined, // will be upgraded below
    });
  });

  const seen = new Set();
  const clean = metas.filter((m) => {
    if (!m.name) return false;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  }).slice(0, 60);

  // Upgrade posters via TMDB/IMDb with persistent cache
  await pMapLimit(clean, POSTER_CONCURRENCY, async (m) => {
    const best = await bestPosterForTitle(m.name);
    if (best) m.poster = best;
  });

  log('CATALOG page', page, 'items:', clean.length);
  return clean;
}

// ───────────────────────────────────────────────────────────
// Meta + Streams (external only)
// ───────────────────────────────────────────────────────────
async function parseMoviePage(slug) {
  const pageUrl = `${SITE}/filmes/${slug}/`;
  const html = await fetchText(pageUrl);
  const $ = cheerio.load(html);

  const name =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    slug.replace(/-/g, ' ');

  // Portuguese description (strict spec)
  const sinopsePT = extractSinopsePT_strict($);

  const sitePoster =
    $('meta[property="og:image"]').attr('content') ||
    $('img.wp-post-image').attr('src') ||
    undefined;

  // External players (exclude YouTube)
  const embeds = [];
  $('iframe').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src) return;
    const u = normalizeURL(src, pageUrl);
    if (u && !EXCLUDE_HOSTS.has(hostOf(u))) embeds.push(u);
  });
  $('[data-src]').each((i, el) => {
    const ds = $(el).attr('data-src');
    if (!ds) return;
    const u = normalizeURL(ds, pageUrl);
    if (u && !EXCLUDE_HOSTS.has(hostOf(u))) embeds.push(u);
  });
  const seen = new Set();
  const uniqueEmbeds = embeds.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
  log('FOUND EMBEDS', uniqueEmbeds);

  const streams = uniqueEmbeds.map(u => ({ externalUrl: u, title: 'Open Player' }));

  // Best art (also stored in persistent cache)
  let poster = sitePoster;
  let background = sitePoster;
  try {
    if (TMDB_KEY) {
      const art = await tmdbArtForTitle(name);
      if (art.poster) poster = art.poster;
      if (art.backdrop) background = art.backdrop;
      if (art.poster) { posterCache.set(lowerKey(name), art.poster); scheduleSaveCache(); }
    } else {
      const det = await imdbDetailsByTitle(name);
      if (det.image) { poster = det.image; background = det.image; posterCache.set(lowerKey(name), det.image); scheduleSaveCache(); }
    }
  } catch {}

  const meta = {
    id: toIdFromSlug(slug),
    type: 'movie',
    name,
    poster: poster || undefined,
    background: background || undefined,
    description: sinopsePT || undefined, // Portuguese description
  };

  return { meta, streams };
}

// ───────────────────────────────────────────────────────────
// Handlers
// ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  log('HANDLER catalog', { type, id, extra });
  try {
    if (type !== 'movie' || id !== 'osteus-filmes') return { metas: [] };
    const skip = Number.parseInt((extra && extra.skip) || '0', 10);
    const page = Math.max(1, Math.floor(skip / 60) + 1);
    const search = (extra && extra.search) || '';
    const metas = await parseCatalogPage(page, search);
    return { metas };
  } catch (e) {
    console.error('catalog error:', e?.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  log('HANDLER meta', { type, id });
  try {
    if (type !== 'movie' || !id.startsWith('tuga:')) return { meta: {} };
    const { meta } = await parseMoviePage(fromIdToSlug(id));
    return { meta };
  } catch (e) {
    console.error('meta error:', e?.message);
    return { meta: {} };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  log('HANDLER stream', { type, id });
  try {
    if (type !== 'movie' || !id.startsWith('tuga:')) return { streams: [] };
    const { streams } = await parseMoviePage(fromIdToSlug(id));
    log('STREAMS OUT', streams.map(s => s.title || s.externalUrl));
    return { streams };
  } catch (e) {
    console.error('stream error:', e?.message);
    return { streams: [] };
  }
});

loadCache(); // load persistent cache on startup
module.exports = builder.getInterface();
