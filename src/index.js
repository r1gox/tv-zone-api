/**
 * TV Zone API — Cloudflare Worker (sin proxy)
 *
 * Fuentes:
 *  - Cable:  https://raw.githubusercontent.com/r1gox/ChannelsTV/refs/heads/main/tv.m3u
 *  - Países: iptv-org
 *
 * Por defecto: TODOS los canales
 * Filtro opcional: ?alive=1
 *
 * Endpoints:
 *  GET /
 *  GET /tv
 *  GET /tv/cable
 *  GET /tv/countries
 *  GET /tv/countries/:code
 *  GET /tv/search?q=
 *  GET /tv/health?url=
 */

const CABLE_M3U =
  'https://raw.githubusercontent.com/r1gox/ChannelsTV/refs/heads/main/tv.m3u';
const IPTV_ORG_BASE = 'https://iptv-org.github.io/iptv';
const IPTV_COUNTRIES_INDEX = `${IPTV_ORG_BASE}/index.country.m3u`;

const CACHE_TTL_MS = 30 * 60 * 1000;
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8000;
const CHECK_CONCURRENCY = 10;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const cache = new Map();

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (e) {
      return json({ success: false, error: e.message || 'Error interno' }, 500);
    }
  },
};

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const origin = url.origin;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }


  // ---------- PROXY HLS ----------
  if (parts[0] === 'proxy') {
    const target = url.searchParams.get('url') || '';
    if (!target || !/^https?:\/\//i.test(decodeSafe(target))) {
      return json({ success: false, error: 'Falta url' }, 400);
    }
    return proxyHls(request, target, origin);
  }
  
  // ---------- HOME ----------
  if (path === '/') {
    return json({
      success: true,
      service: 'TV Zone API',
      version: '1.4.0',
      nota: 'Sin proxy. Usa la url directa del canal en el player. ?alive=1 filtra (permisivo).',
      endpoints: {
        tv: origin + '/tv',
        cable: origin + '/tv/cable',
        countries: origin + '/tv/countries',
        country: origin + '/tv/countries/{code}',
        search: origin + '/tv/search?q={texto}',
        health: origin + '/tv/health?url={m3u8}',
      },
      ejemplos: {
        cable: origin + '/tv/cable',
        mexico: origin + '/tv/countries/mx',
        search: origin + '/tv/search?q=espn',
      },
    });
  }

  // ---------- /tv ----------
  if (parts[0] === 'tv' && parts.length === 1) {
    return json({
      success: true,
      fuentes: [
        { id: 'cable', nombre: 'ChannelsTV (cable)', endpoint: origin + '/tv/cable' },
        { id: 'countries', nombre: 'IPTV-org por países', endpoint: origin + '/tv/countries' },
      ],
    });
  }

  // ---------- /tv/health ----------
  if (parts[0] === 'tv' && parts[1] === 'health') {
    const u = url.searchParams.get('url') || '';
    if (!u || !/^https?:\/\//i.test(u)) {
      return json({ success: false, error: 'Falta url válida' }, 400);
    }
    const alive = await isStreamAlive(u);
    return json({ success: true, url: u, alive });
  }

  // ---------- /tv/cable ----------
  if (parts[0] === 'tv' && parts[1] === 'cable') {
    const group = url.searchParams.get('group') || null;
    const wantAlive = url.searchParams.get('alive') === '1';
    const force = url.searchParams.get('force') === '1';

    const data = await getCableChannels();
    let canales = data.canales;

    if (group) {
      const g = group.toLowerCase();
      canales = canales.filter((c) => (c.grupo || '').toLowerCase() === g);
    }

    const totalOriginal = canales.length;
    if (wantAlive) {
      canales = await filterAliveChannels(canales, { force });
    }

    return json({
      success: true,
      fuente: 'cable',
      filtered: wantAlive,
      total: canales.length,
      total_original: totalOriginal,
      grupos: uniqueGroups(canales),
      canales,
    });
  }

  // ---------- /tv/countries ----------
  if (parts[0] === 'tv' && parts[1] === 'countries' && !parts[2]) {
    const countries = await getCountriesList();
    return json({
      success: true,
      fuente: 'iptv-org',
      total: countries.length,
      countries,
    });
  }

  // ---------- /tv/countries/:code ----------
  if (parts[0] === 'tv' && parts[1] === 'countries' && parts[2]) {
    const code = parts[2].toLowerCase();
    const wantAlive = url.searchParams.get('alive') === '1';
    const force = url.searchParams.get('force') === '1';

    const data = await getCountryChannels(code);
    if (!data) {
      return json({ success: false, error: `País no encontrado: ${code}` }, 404);
    }

    let canales = data.canales;
    const totalOriginal = canales.length;

    if (wantAlive) {
      canales = await filterAliveChannels(canales, { force });
    }

    return json({
      success: true,
      fuente: 'iptv-org',
      country: code,
      filtered: wantAlive,
      total: canales.length,
      total_original: totalOriginal,
      grupos: uniqueGroups(canales),
      canales,
    });
  }

  // ---------- /tv/search ----------
  if (parts[0] === 'tv' && parts[1] === 'search') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 2) {
      return json(
        { success: false, error: 'Usa /tv/search?q=texto (mínimo 2 caracteres)' },
        400
      );
    }

    const country = (url.searchParams.get('country') || '').toLowerCase() || null;
    const wantAlive = url.searchParams.get('alive') === '1';
    const force = url.searchParams.get('force') === '1';

    let results = await searchChannels(q, country);
    if (wantAlive) {
      results = await filterAliveChannels(results, { force });
    }

    return json({
      success: true,
      query: q,
      country: country || 'all',
      filtered: wantAlive,
      total: results.length,
      canales: results,
    });
  }

  return json({ success: false, error: 'Ruta no encontrada' }, 404);
}

// ============================================================
// CABLE
// ============================================================
async function getCableChannels() {
  const key = 'cable';
  const cached = getCache(key);
  if (cached) return cached;

  const text = await fetchText(CABLE_M3U);
  const canales = parseM3U(text, 'cable');
  const data = { canales, grupos: uniqueGroups(canales) };
  setCache(key, data, CACHE_TTL_MS);
  return data;
}

// ============================================================
// IPTV-ORG
// ============================================================
async function getCountriesList() {
  const key = 'countries_index';
  const cached = getCache(key);
  if (cached) return cached;

  let countries = [];
  try {
    const text = await fetchText(IPTV_COUNTRIES_INDEX);
    const re =
      /#EXTINF:[^\n]*group-title="([^"]+)"[^\n]*\n(https?:\/\/[^\s]+countries\/([a-z]{2})\.m3u)/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(text)) !== null) {
      const code = m[3].toLowerCase();
      if (seen.has(code)) continue;
      seen.add(code);
      countries.push({
        code,
        name: m[1],
        url: `${IPTV_ORG_BASE}/countries/${code}.m3u`,
      });
    }
  } catch (e) {}

  if (!countries.length) {
    countries = [
      'mx', 'es', 'ar', 'co', 'cl', 'pe', 'us', 'br', 've', 'ec',
      'uy', 'bo', 'py', 'cr', 'pa', 'do', 'gt', 'hn', 'sv', 'ni', 'cu', 'pr',
    ].map((code) => ({
      code,
      name: code.toUpperCase(),
      url: `${IPTV_ORG_BASE}/countries/${code}.m3u`,
    }));
  }

  countries.sort((a, b) => a.name.localeCompare(b.name));
  setCache(key, countries, CACHE_TTL_MS);
  return countries;
}

async function getCountryChannels(code) {
  const key = `country_${code}`;
  const cached = getCache(key);
  if (cached) return cached;

  try {
    const text = await fetchText(`${IPTV_ORG_BASE}/countries/${code}.m3u`);
    if (!text || !text.includes('#EXTINF')) return null;
    const canales = parseM3U(text, 'iptv-org', code);
    const data = { canales, grupos: uniqueGroups(canales) };
    setCache(key, data, CACHE_TTL_MS);
    return data;
  } catch (e) {
    return null;
  }
}

// ============================================================
// BÚSQUEDA
// ============================================================
async function searchChannels(q, countryCode) {
  const results = [];

  try {
    const cable = await getCableChannels();
    for (const c of cable.canales) {
      if (
        (c.nombre || '').toLowerCase().includes(q) ||
        (c.grupo || '').toLowerCase().includes(q)
      ) {
        results.push(c);
      }
    }
  } catch (e) {}

  const codes = countryCode
    ? [countryCode]
    : ['mx', 'es', 'ar', 'co', 'us', 'cl', 'pe'];

  for (const code of codes) {
    try {
      const data = await getCountryChannels(code);
      if (!data) continue;
      for (const c of data.canales) {
        if (
          (c.nombre || '').toLowerCase().includes(q) ||
          (c.grupo || '').toLowerCase().includes(q)
        ) {
          results.push(c);
        }
      }
    } catch (e) {}
  }

  const seen = new Set();
  return results.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

// ============================================================
// HEALTH CHECK (permisivo, solo si ?alive=1)
// ============================================================
async function isStreamAlive(streamUrl) {
  if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(streamUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Range: 'bytes=0-4095',
      },
      cf: { cacheTtl: 0 },
    });

    if (res.status === 404 || res.status === 410 || res.status === 451) return false;
    if (res.status >= 500) return false;
    if (res.status === 401 || res.status === 403) return true;

    if (res.status >= 200 && res.status < 400) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (
        ct.includes('mpegurl') ||
        ct.includes('m3u') ||
        ct.includes('video/') ||
        ct.includes('audio/') ||
        ct.includes('octet-stream')
      ) {
        return true;
      }

      let head = '';
      try {
        head = (await res.text()).slice(0, 300).trim();
      } catch (e) {
        return true;
      }

      if (!head) return true;
      if (head.startsWith('#EXTM3U') || head.includes('#EXT-X-')) return true;

      const low = head.toLowerCase();
      if (
        low.startsWith('<!doctype') ||
        low.startsWith('<html') ||
        (low.startsWith('{') && low.includes('error'))
      ) {
        return false;
      }
      return true;
    }

    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function filterAliveChannels(canales, { force = false } = {}) {
  if (!canales || !canales.length) return [];

  const results = [];
  let i = 0;

  async function worker() {
    while (i < canales.length) {
      const idx = i++;
      const ch = canales[idx];
      if (!ch || !ch.url) continue;

      const healthKey = 'health:' + ch.url;
      let alive = null;

      if (!force) {
        const cached = getCache(healthKey);
        if (cached != null) alive = cached;
      }

      if (alive == null) {
        alive = await isStreamAlive(ch.url);
        setCache(healthKey, alive, HEALTH_TTL_MS);
      }

      if (alive) results.push({ ...ch, alive: true });
    }
  }

  const n = Math.min(CHECK_CONCURRENCY, canales.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

// ============================================================
// PARSER M3U
// ============================================================
function parseM3U(text, fuente, country = null) {
  const lines = text.split(/\r?\n/);
  const canales = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      current = {
        nombre: '',
        logo: null,
        grupo: null,
        url: null,
        fuente,
        country: country || null,
      };

      const logoM = line.match(/tvg-logo="([^"]*)"/i);
      if (logoM) current.logo = logoM[1] || null;

      const groupM = line.match(/group-title="([^"]*)"/i);
      if (groupM) current.grupo = groupM[1] || null;

      const comma = line.lastIndexOf(',');
      if (comma !== -1) current.nombre = line.slice(comma + 1).trim();
    } else if (current && !line.startsWith('#')) {
      current.url = line;
      if (current.nombre && current.url) canales.push(current);
      current = null;
    }
  }

  return canales;
}

// ============================================================
// HELPERS
// ============================================================
function uniqueGroups(canales) {
  return [...new Set((canales || []).map((c) => c.grupo).filter(Boolean))].sort();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al bajar ${url}`);
  return res.text();
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, expires: Date.now() + ttl });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}


function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

async function proxyHls(request, target, workerOrigin) {
  let decoded = target;
  try {
    for (let i = 0; i < 3; i++) {
      const n = decodeURIComponent(decoded);
      if (n === decoded) break;
      decoded = n;
    }
  } catch (e) {}

  if (!/^https?:\/\//i.test(decoded)) {
    return json({ success: false, error: 'url inválida' }, 400);
  }

  let host = '';
  try { host = new URL(decoded).origin; } catch (e) {}

  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
  };
  if (host) {
    headers['Referer'] = host + '/';
    headers['Origin'] = host;
  }
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  let res;
  try {
    res = await fetch(decoded, { method: 'GET', headers, redirect: 'follow' });
  } catch (e) {
    return json({ success: false, error: String(e.message || e) }, 502);
  }

  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  const looksPlaylist =
    ct.includes('mpegurl') ||
    ct.includes('m3u') ||
    /\.m3u8?(?:\?|$)/i.test(decoded);

  const out = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-store',
  });

  if (looksPlaylist && res.ok) {
    const text = await res.text();
    if (text.includes('#EXT')) {
      const base = decoded.replace(/[^\/?#]+(\?.*)?$/, '');
      const originHost = host;
      const lines = text.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          if (/URI="/i.test(line)) {
            return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
              const abs = absUrl(uri, base, originHost);
              return `URI="${workerOrigin}/proxy?url=${encodeURIComponent(abs)}"`;
            });
          }
          return line;
        }
        const abs = absUrl(t, base, originHost);
        return `${workerOrigin}/proxy?url=${encodeURIComponent(abs)}`;
      });
      out.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return new Response(lines.join('\n'), { status: 200, headers: out });
    }
  }

  out.set('Content-Type', res.headers.get('Content-Type') || 'application/octet-stream');
  if (res.headers.get('Content-Length')) out.set('Content-Length', res.headers.get('Content-Length'));
  if (res.headers.get('Content-Range')) out.set('Content-Range', res.headers.get('Content-Range'));
  if (res.headers.get('Accept-Ranges')) out.set('Accept-Ranges', res.headers.get('Accept-Ranges'));
  return new Response(res.body, { status: res.status, headers: out });
}

function absUrl(uri, base, originHost) {
  uri = (uri || '').trim();
  if (/^https?:\/\//i.test(uri)) return uri;
  if (uri.startsWith('//')) return 'https:' + uri;
  if (uri.startsWith('/')) return (originHost || '') + uri;
  try { return new URL(uri, base).href; } catch (e) { return base + uri; }
}
