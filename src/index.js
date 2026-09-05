/**
 * TV Zone API — Cloudflare Worker
 * Fuentes:
 *  - Cable:  https://raw.githubusercontent.com/r1gox/ChannelsTV/refs/heads/main/tv.m3u
 *  - Países: iptv-org (https://iptv-org.github.io/iptv/)
 *
 * Endpoints:
 *  GET /                 → info + endpoints
 *  GET /tv               → resumen de fuentes
 *  GET /tv/cable         → canales de tu lista ChannelsTV
 *  GET /tv/countries     → lista de países disponibles
 *  GET /tv/countries/:code → canales de un país (ej: mx, es, ar, us)
 *  GET /tv/search?q=espn → búsqueda en cable + país (opcional ?country=mx)
 *  GET /proxy?url=...    → proxy CORS para m3u8 / segmentos
 */

const CABLE_M3U = 'https://raw.githubusercontent.com/r1gox/ChannelsTV/refs/heads/main/tv.m3u';
const IPTV_ORG_BASE = 'https://iptv-org.github.io/iptv';
const IPTV_COUNTRIES_INDEX = `${IPTV_ORG_BASE}/index.country.m3u`;

// Cache en memoria del isolate (se resetea al reiniciar el Worker)
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

  // ---------- PROXY (CORS para m3u8 / segmentos) ----------
  if (parts[0] === 'proxy') {
    const target = url.searchParams.get('url') || '';
    if (!target || !/^https?:\/\//i.test(target)) {
      return json({ success: false, error: 'Falta url válida. Uso: /proxy?url={m3u8}' }, 400);
    }
    return proxyStream(request, target);
  }

  // ---------- HOME ----------
  if (path === '/') {
    return json({
      success: true,
      service: 'TV Zone API',
      version: '1.0.0',
      endpoints: {
        tv: origin + '/tv',
        cable: origin + '/tv/cable',
        countries: origin + '/tv/countries',
        country: origin + '/tv/countries/{code}', // ej: /tv/countries/mx
        search: origin + '/tv/search?q={texto}&country={opcional}',
        proxy: origin + '/proxy?url={m3u8}',
      },
      ejemplos: {
        cable: origin + '/tv/cable',
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
        { id: 'cable', nombre: 'ChannelsTV (cable)', endpoint: origin + '/tv/cable' },
        { id: 'countries', nombre: 'IPTV-org por países', endpoint: origin + '/tv/countries' },
      ],
    });
  }

  // ---------- /tv/cable ----------
  if (parts[0] === 'tv' && parts[1] === 'cable') {
    const group = url.searchParams.get('group') || null;
    const data = await getCableChannels();
    let canales = data.canales;
    if (group) {
      const g = group.toLowerCase();
      canales = canales.filter((c) => (c.grupo || '').toLowerCase() === g);
    }
    return json({
      success: true,
      fuente: 'cable',
      total: canales.length,
      grupos: data.grupos,
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
    const data = await getCountryChannels(code);
    if (!data) {
      return json({ success: false, error: `País no encontrado: ${code}` }, 404);
    }
    return json({
      success: true,
      fuente: 'iptv-org',
      country: code,
      total: data.canales.length,
      grupos: data.grupos,
      canales: data.canales,
    });
  }

  // ---------- /tv/search?q= ----------
  if (parts[0] === 'tv' && parts[1] === 'search') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 2) {
      return json({ success: false, error: 'Usa /tv/search?q=texto (mínimo 2 caracteres)' }, 400);
    }
    const country = (url.searchParams.get('country') || '').toLowerCase() || null;
    const results = await searchChannels(q, country);
    return json({
      success: true,
      query: q,
      country: country || 'all',
      total: results.length,
      canales: results,
    });
  }

  return json({ success: false, error: 'Ruta no encontrada' }, 404);
}

// ============================================================
// CABLE (ChannelsTV)
// ============================================================
async function getCableChannels() {
  const key = 'cable';
  const cached = getCache(key);
  if (cached) return cached;

  const text = await fetchText(CABLE_M3U);
  const canales = parseM3U(text, 'cable');
  const grupos = [...new Set(canales.map((c) => c.grupo).filter(Boolean))].sort();
  const data = { canales, grupos };
  setCache(key, data);
  return data;
}

// ============================================================
// IPTV-ORG
// ============================================================
async function getCountriesList() {
  const key = 'countries_index';
  const cached = getCache(key);
  if (cached) return cached;

  // Intentamos el índice oficial; si falla, devolvemos lista fija útil
  let countries = [];
  try {
    const text = await fetchText(IPTV_COUNTRIES_INDEX);
    // El index.country.m3u tiene líneas con group-title = nombre del país
    // y la URL termina en /countries/xx.m3u
    const re = /#EXTINF:[^\n]*group-title="([^"]+)"[^\n]*\n(https?:\/\/[^\s]+countries\/([a-z]{2})\.m3u)/gi;
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
  } catch (e) {
    // fallback de países más usados
  }

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
  setCache(key, countries);
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
    const grupos = [...new Set(canales.map((c) => c.grupo).filter(Boolean))].sort();
    const data = { canales, grupos };
    setCache(key, data);
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

  // Cable
  try {
    const cable = await getCableChannels();
    for (const c of cable.canales) {
      if ((c.nombre || '').toLowerCase().includes(q) || (c.grupo || '').toLowerCase().includes(q)) {
        results.push(c);
      }
    }
  } catch (e) {}

  // País específico o varios comunes
  const codes = countryCode
    ? [countryCode]
    : ['mx', 'es', 'ar', 'co', 'us', 'cl', 'pe'];

  for (const code of codes) {
    try {
      const data = await getCountryChannels(code);
      if (!data) continue;
      for (const c of data.canales) {
        if ((c.nombre || '').toLowerCase().includes(q) || (c.grupo || '').toLowerCase().includes(q)) {
          results.push(c);
        }
      }
    } catch (e) {}
  }

  // Deduplicar por URL
  const seen = new Set();
  return results.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
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

      // tvg-logo="..."
      const logoM = line.match(/tvg-logo="([^"]*)"/i);
      if (logoM) current.logo = logoM[1] || null;

      // group-title="..."
      const groupM = line.match(/group-title="([^"]*)"/i);
      if (groupM) current.grupo = groupM[1] || null;

      // Nombre: después de la última coma
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
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
    },
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

function setCache(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ============================================================
// PROXY HLS (simple)
// ============================================================
async function proxyStream(request, target) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
  };

  // Reenviar Range si existe (útil para segmentos)
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

  // Si es playlist, reescribimos URLs relativas a absolutas vía proxy (opcional simple)
  if (ct.includes('mpegurl') || ct.includes('m3u') || target.includes('.m3u8')) {
    let body = await res.text();
    // Dejamos las URLs como están; el player suele resolverlas.
    // Si necesitas proxy total de segmentos, se puede reescribir aquí.
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
