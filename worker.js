// ============================================================
// 1. CONFIGURACIÓN GLOBAL (Usa variables de entorno)
// ============================================================

// Estas variables se definen en el panel de Cloudflare Workers:
// - TMDB_API_KEY
// - STREAMTAPE_LOGIN
// - STREAMTAPE_API_KEY
// - VIDEO_CACHE (namespace KV)

// ============================================================
// 2. EXTRACTOR DE STREAMTAPE (Usa API oficial)
// ============================================================

async function extractStreamtape(fileId, login, apiKey) {
  // fileId: identificador del archivo en Streamtape (ej: "abc123")
  const url = `https://api.streamtape.com/file/dltoken?file=${fileId}&login=${login}&key=${apiKey}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Streamtape API error: ${resp.status}`);
  }
  const data = await resp.json();
  if (data.status !== 200 || !data.result?.dl_token) {
    throw new Error(`Streamtape: ${data.msg || 'Error desconocido'}`);
  }
  const token = data.result.dl_token;
  // El enlace directo (válido por tiempo limitado)
  return `https://streamtape.com/get/${fileId}/${token}`;
}

// ============================================================
// 3. MAPA DE EXTRACTORES (ampliable)
// ============================================================

const extractorsMap = {
  streamtape: extractStreamtape,
  // Aquí añadirás: doodstream, voe, mega, etc.
};

// ============================================================
// 4. FUNCIÓN PARA RESOLVER VIDEO CON CACHÉ
// ============================================================

async function resolveVideo(servers, videoId, env) {
  // 'servers' es un array de nombres de servidores (ej: ['streamtape'])
  // 'videoId' es el identificador del archivo en cada servicio (puede ser el mismo o diferente)
  const cacheKey = `video:${servers.join(',')}:${videoId}`;
  
  // Intentar desde caché KV
  if (env && env.VIDEO_CACHE) {
    const cached = await env.VIDEO_CACHE.get(cacheKey, 'json');
    if (cached) {
      console.log('✅ Resuelto desde caché');
      return cached;
    }
  }

  // Probar extractores en orden
  for (const serverName of servers) {
    const extractor = extractorsMap[serverName];
    if (!extractor) continue;
    try {
      console.log(`🔍 Intentando con ${serverName}...`);
      let videoUrl;
      if (serverName === 'streamtape') {
        videoUrl = await extractor(videoId, env.STREAMTAPE_LOGIN, env.STREAMTAPE_API_KEY);
      } else {
        // Para otros extractores, pasar solo videoId
        videoUrl = await extractor(videoId);
      }
      if (videoUrl) {
        const result = { url: videoUrl, server: serverName };
        // Guardar en caché por 6 horas (Streamtape tokens expiran)
        if (env && env.VIDEO_CACHE) {
          await env.VIDEO_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
        }
        return result;
      }
    } catch (err) {
      console.warn(`❌ Falló ${serverName}:`, err.message);
    }
  }
  throw new Error('No se pudo resolver el video con ningún servidor');
}

// ============================================================
// 5. WORKER PRINCIPAL
// ============================================================

export default {
  async fetch(request, env, ctx) {
    // CORS para peticiones OPTIONS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const tmdbId = url.searchParams.get('id');
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || '1';
    const episode = url.searchParams.get('episode') || '1';
    const server = url.searchParams.get('server');
    const page = url.searchParams.get('page') || '1';

    try {
      // --- Acción: Proxy de video (para evitar CORS y Referer) ---
      if (action === 'stream') {
        const streamUrl = url.searchParams.get('stream_url');
        if (!streamUrl) {
          return new Response(JSON.stringify({ error: 'Falta stream_url' }), { status: 400, headers: corsHeaders() });
        }
        const targetUrl = decodeURIComponent(streamUrl);
        const reqHeaders = new Headers({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://tu-dominio.com/' // Cambia por tu dominio
        });
        if (request.headers.has('Range')) {
          reqHeaders.set('Range', request.headers.get('Range'));
        }
        const videoRes = await fetch(targetUrl, { headers: reqHeaders, redirect: 'follow' });
        const responseHeaders = new Headers(corsHeaders());
        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(header => {
          if (videoRes.headers.has(header)) {
            responseHeaders.set(header, videoRes.headers.get(header));
          }
        });
        return new Response(videoRes.body, {
          status: videoRes.status,
          headers: responseHeaders
        });
      }

      // --- Acción: Catálogo (desde TMDB) ---
      if (action === 'catalog') {
        const tmdbRes = await fetch(
          `https://api.themoviedb.org/3/${type}/popular?api_key=${env.TMDB_API_KEY}&language=es-MX&page=${page}`
        );
        const tmdbData = await tmdbRes.json();
        return new Response(JSON.stringify(tmdbData), { status: 200, headers: corsHeaders() });
      }

      // --- Acción principal: Obtener video para un ID de TMDB ---
      if (!tmdbId) {
        return new Response(JSON.stringify({ error: 'Falta parámetro "id"' }), { status: 400, headers: corsHeaders() });
      }

      // Obtener metadatos de TMDB
      const tmdbDetail = await fetch(
        `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${env.TMDB_API_KEY}&language=es-MX`
      );
      if (!tmdbDetail.ok) {
        return new Response(JSON.stringify({ error: 'Error al obtener datos de TMDB' }), { status: 404, headers: corsHeaders() });
      }
      const meta = await tmdbDetail.json();

      // --- RELACIÓN ID DE TMDB → ID EN STREAMTAPE (y otros servicios) ---
      // Aquí necesitas una base de datos real. Por ahora usamos un ejemplo estático.
      // En producción, esto podría venir de una tabla en KV, un archivo JSON, o un scraper.
      const videoIds = {
        streamtape: 'abc123', // <-- REEMPLAZA CON EL ID REAL DE TU ARCHIVO EN STREAMTAPE
        // Ejemplo: 'doodstream': 'xyz789',
        // 'voe': 'voe123'
      };

      // Lista de servidores a probar (en orden de preferencia)
      let serversToTry = Object.keys(videoIds);
      if (server && videoIds[server]) {
        serversToTry = [server];
      }

      // Resolver el video
      const videoInfo = await resolveVideo(serversToTry, videoIds[serversToTry[0]], env);

      // Construir respuesta
      const payload = {
        success: true,
        title: meta.title || meta.name || 'Sin título',
        overview: meta.overview || '',
        poster: meta.poster_path ? `https://image.tmdb.org/t/p/w500${meta.poster_path}` : '',
        backdrop: meta.backdrop_path ? `https://image.tmdb.org/t/p/w1280${meta.backdrop_path}` : '',
        server: videoInfo.server,
        stream_url: `${url.protocol}//${url.host}/?action=stream&stream_url=${encodeURIComponent(videoInfo.url)}`,
        direct_url: videoInfo.url,
        available_servers: Object.keys(videoIds)
      };

      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: corsHeaders()
      });

    } catch (err) {
      return new Response(JSON.stringify({
        error: 'Error interno',
        details: err.message
      }), {
        status: 500,
        headers: corsHeaders()
      });
    }
  }
};

// ============================================================
// 6. CABECERAS CORS
// ============================================================

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}
