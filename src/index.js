/**
 * TV Zone API — Cloudflare Worker
 * Fuentes:
 *  - Cable:  https://raw.githubusercontent.com/r1gox/ChannelsTV/refs/heads/main/tv.m3u
 *  - Países: iptv-org (https://iptv-org.github.io/iptv/)
 *
 * Solo devuelve canales que responden (filtro de vivos).
 * Usa ?all=1 para ver todos sin filtrar.
 * Usa ?force=1 para re-chequear ignorando cache de salud.
 *
 * Endpoints:
 *  GET /
 *  GET /tv
 *  GET /tv/cable
 *  GET /tv/countries
 *  GET /tv/countries/:code
 *  GET /tv/search?q=...
 *  GET /tv/health?url=...
 *  GET /proxy?url=...
 */

const CABLE_M3U =
  'https://raw.githubusercontent.com/r1gox/ChannelsTV/refs/heads/main/tv.m3u';
const IPTV_ORG_BASE = 'https://iptv-org.github.io/iptv';
const IPTV_COUNTRIES_INDEX = `${IPTV_ORG_BASE}/index.country.m3u`;

const CACHE_TTL_MS = 30 * 60 * 1000; // listas M3U: 30 min
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000; // vivo/muerto: 6 h
const CHECK_TIMEOUT_MS = 4500;
const CHECK_CONCURRENCY = 12;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const cache = new Map();

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      return json({ success: false, error: e.message || 'Error interno' }, 500);
    }
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const origin = url.origin;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ---------- PROXY ----------
  if (parts[0] === 'proxy') {
    const target = url.searchParams.get('url') || '';
    if (!target || !/^https?:\/\//i.test(target)) {
      return json(
        { success: false, error: 'Falta url válida. Uso: /proxy?url={m3u8}' },
        400
      );
    }
    return proxyStream(request, target);
  }

  // ---------- HOME ----------
  if (path === '/') {
    return json({
      success: true,
      service: 'TV Zone API',
      version: '1.1.0',
      nota: 'Por defecto solo se devuelven canales vivos. Usa ?all=1 para ver todos.',
      endpoints: {
        tv: origin + '/tv',
        cable: origin + '/tv/cable',
        countries: origin + '/tv/countries',
        country: origin + '/tv/countries/{code}',
        search: origin + '/tv/search?q={texto}&country={opcional}',
        health: origin + '/tv/health?url={m3u8}',
        proxy: origin + '/proxy?url={m3u8}',
      },
      ejemplos: {
        cable: origin + '/tv/cable',
        cable_all: origin + '/tv/cable?all=1',
        mexico: origin + '/tv/countries/mx',
        spain: origin + '/tv/countries/es',
        search: origin + '/tv/search?q=espn',
      },
    });
  }

  // ---------- /tv ----------
  if (parts[0] === 'tv' && parts.length === 1) {
    return json({
      success: true,
      fuentes: [
        {
          id: 'cable',
          nombre: 'ChannelsTV (cable)',
          endpoint: origin + '/tv/cable',
        },
        {
          id: 'countries',
          nombre: 'IPTV-org por países',
          endpoint: origin + '/tv/countries',
        },
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
    const showAll = url.searchParams.get('all') === '1';
    const force = url.searchParams.get('force') === '1';

    const data = await getCableChannels();
    let canales = data.canales;

    if (group) {
      const g = group.toLowerCase();
      canales = canales.filter((c) => (c.grupo || '').toLowerCase() === g);
    }

    const totalOriginal = canales.length;

    if (!showAll) {
      canales = await filterAliveChannels(canales, { force });
    }

    const grupos = [
      ...new Set(canales.map((c) => c.grupo).filter(Boolean)),
    ].sort();

    return json({
      success: true,
      fuente: 'cable',
      filtered: !showAll,
      total: canales.length,
      total_original: totalOriginal,
      grupos,
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
    const showAll = url.searchParams.get('all') === '1';
    const force = url.searchParams.get('force') === '1';

    const data = await getCountryChannels(code);
    if (!data) {
      return json(
        { success: false, error: `País no encontrado: ${code}` },
        404
      );
    }

    let canales = data.canales;
    const totalOriginal = canales.length;

    if (!showAll) {
      canales = await filterAliveChannels(canales, { force });
    }

    const grupos = [
      ...new Set(canales.map((c) => c.grupo).filter(Boolean)),
    ].sort();

    return json({
      success: true,
      fuente: 'iptv-org',
      country: code,
      filtered: !showAll,
      total: canales.length,
      total_original: totalOriginal,
      grupos,
      canales,
    });
  }

  // ---------- /tv/search ----------
  if (parts[0] === 'tv' && parts[1] === 'search') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 2) {
      return json(
        {
          success: false,
          error: 'Usa /tv/search?q=texto (mínimo 2 caracteres)',
        },
        400
      );
    }
    const country = (url.searchParams.get('country') || '').toLowerCase() || null;
    const showAll = url.searchParams.get('all') === '1';
    const force = url.searchParams.get('force') === '1';

    let results = await searchChannels(q, country);

    if (!showAll) {
      results = await filterAliveChannels(results, { force });
    }

    return json({
      success: true,
      query: q,
      country: country || 'all',
      filtered: !showAll,
      total: results.length,
      canales: results,
    });
  }

  return json({ success: false, error: 'Ruta no encontrada' }, 404);
}

// ============================================================
// CABLE (ChannelsTV - GitHub)
// ============================================================
async function getCableChannels() {
  const key = 'cable';
  const cached = getCache(key);
  if (cached) return cached;

  const text = await fetchText(CABLE_M3U);
  const canales = parseM3U(text, 'cable');
  const grupos = [
    ...new Set(canales.map((c) => c.grupo).filter(Boolean)),
  ].sort();
  const data = { canales, grupos };
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
      { code: 'mx', name: 'Mexico' },
      { code: 'es', name: 'Spain' },
      { code: 'ar', name: 'Argentina' },
      { code: 'co', name: 'Colombia' },
      { code: 'cl', name: 'Chile' },
      { code: 'pe', name: 'Peru' },
      { code: 'us', name: 'United States' },
      { code: 'br', name: 'Brazil' },
      { code: 've', name: 'Venezuela' },
      { code: 'ec', name: 'Ecuador' },
      { code: 'uy', name: 'Uruguay' },
      { code: 'bo', name: 'Bolivia' },
      { code: 'py', name: 'Paraguay' },
      { code: 'cr', name: 'Costa Rica' },
      { code: 'pa', name: 'Panama' },
      { code: 'do', name: 'Dominican Republic' },
      { code: 'gt', name: 'Guatemala' },
      { code: 'hn', name: 'Honduras' },
      { code: 'sv', name: 'El Salvador' },
      { code: 'ni', name: 'Nicaragua' },
      { code: 'cu', name: 'Cuba' },
      { code: 'pr', name: 'Puerto Rico' },
    ].map((c) => ({
      ...c,
      url: `${IPTV_ORG_BASE}/countries/${c.code}.m3u`,
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

  const m3uUrl = `${IPTV_ORG_BASE}/countries/${code}.m3u`;
  try {
    const text = await fetchText(m3uUrl);
    if (!text || !text.includes('#EXTINF')) return null;
    const canales = parseM3U(text, 'iptv-org', code);
    const grupos = [
      ...new Set(canales.map((c) => c.grupo).filter(Boolean)),
    ].sort();
    const data = { canales, grupos };
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
// HEALTH CHECK (vivo / muerto)
// ============================================================
async function isStreamAlive(streamUrl) {
  if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    let res = await fetch(streamUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
      cf: { cacheTtl: 0 },
    });

    if (res.status === 405 || res.status === 501 || res.status === 400) {
      res = await fetch(streamUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          Range: 'bytes=0-2047',
        },
        cf: { cacheTtl: 0 },
      });
    }

    if (!(res.status >= 200 && res.status < 400)) return false;

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (
      ct.includes('mpegurl') ||
      ct.includes('m3u') ||
      ct.includes('application/vnd.apple.mpegurl') ||
      ct.includes('video/') ||
      ct.includes('application/octet-stream')
    ) {
      return true;
    }

    if (res.body) {
      const text = await res.text();
      const head = (text || '').slice(0, 200).trim();
      if (
        head.startsWith('#EXTM3U') ||
        head.includes('#EXTINF') ||
        head.includes('#EXT-X-')
      ) {
        return true;
      }
      if (
        head.startsWith('{') ||
        head.startsWith('<!DOCTYPE') ||
        head.startsWith('<html')
      ) {
        return false;
      }
      return res.status >= 200 && res.status < 300;
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

      if (alive) {
        results.push({ ...ch, alive: true });
      }
    }
  }

  const n = Math.min(CHECK_CONCURRENCY, canales.length);
  const workers = [];
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);

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
      if (comma !== -1) {
        current.nombre = line.slice(comma + 1).trim();
      }
    } else if (current && !line.startsWith('#')) {
      current.url = line;
      if (current.nombre && current.url) {
        canales.push(current);
      }
      current = null;
    }
  }

  return canales;
}

// ============================================================
// FETCH + CACHE
// ============================================================
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

// ============================================================
// PROXY HLS
// ============================================================
async function proxyStream(request, target) {
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  const res = await fetch(target, { headers });
  const outHeaders = new Headers(corsHeaders());
  const ct = res.headers.get('Content-Type') || 'application/octet-stream';
  outHeaders.set('Content-Type', ct);
  outHeaders.set('Access-Control-Allow-Origin', '*');

  if (res.headers.get('Content-Length')) {
    outHeaders.set('Content-Length', res.headers.get('Content-Length'));
  }
  if (res.headers.get('Content-Range')) {
    outHeaders.set('Content-Range', res.headers.get('Content-Range'));
  }
  if (res.headers.get('Accept-Ranges')) {
    outHeaders.set('Accept-Ranges', res.headers.get('Accept-Ranges'));
  }

  if (
    ct.includes('mpegurl') ||
    ct.includes('m3u') ||
    target.includes('.m3u8')
  ) {
    const body = await res.text();
    return new Response(body, { status: res.status, headers: outHeaders });
  }

  return new Response(res.body, { status: res.status, headers: outHeaders });
}

// ============================================================
// UTILS
// ============================================================
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges',
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
