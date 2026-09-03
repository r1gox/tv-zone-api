var __LAST_ORIGIN__ = "";
// src/index.js — MovieZone Worker (Lamovie + Hackstore + PelisPlusHD)
// Module worker (Wrangler moderno). El patrón addEventListener('fetch', ...)
// clásico se retiró: event.env no existe en ese modelo y es código muerto
// junto al export default de abajo.
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env || {});
    } catch (eTop) {
      // Red de seguridad: nunca dejar que una excepción no controlada
      // devuelva la página de error genérica de Cloudflare (1101) en vez de JSON.
      return json({ success: false, error: (eTop && eTop.message) || 'Error interno' }, 500);
    }
  }
};

var HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

var LAMOVIE_API = 'https://lamovie.org/wp-api/v1';
var LAMOVIE_BASE = 'https://lamovie.org';
var HACKSTORE_BASE = 'https://www.hackstore.fo';
var PELISPLUS_BASE = 'https://www.pelisplushd.la';
var ANIMEAV1_BASE = 'https://animeav1.com';
var DORAMASFLIX_BASE = 'https://doramasflix.io';
var DORAMASFLIX_GQL = 'https://user-api.fluxcedene.net/graphql';
// Metadatos TMDB vía worker público (no cambia el flujo de embeds/fuentes)
var TMDB_META_API = ''; // desactivado: meta solo de la página fuente (+ TMDB key si hay)

var REPRODUCTORES_PERMITIDOS = [
  'vimeos.net', 'player.vimeos',
  'goodstream', 'streamwish', 'filemoon', 'voe.',
  'doodstream', 'dood.', 'ds2play', 'doods.pro', 'dsvplay',
  'streamtape', 'mixdrop', 'upstream',
  'vidmoly', 'mp4upload', 'uqload',
  'vidhide', 'vidguard', 'lulustream', 'filelions',
  'yourupload', 'supervideo', 'krakenfiles', 'ok.ru',
  'videoapp.zip', 'videoapp', 'waaw.', 'hqq.', 'netu.'
];

var REPRODUCTORES_BLOQUEADOS = [
  'lamovie.org', 'lamovie', 'youtube.com', 'youtu.be',
  'youtube-nocookie', 'example.com',
  'sblongvu', 'sbfull', 'fembed', '4shared',
  'oembed', 'wp-json', 'hackstore.fo', 'hackstore'
];

var PALABRAS_BLOQUEADAS_BUSQUEDA = ['estrenos', 'populares', 'genero', 'categoria', 'pagina'];

// ======================================================
// ROUTER
// ======================================================
async function handleRequest(request, env) {
  // API key TMDB opcional (Cloudflare Worker secret / var)
  try {
    if (env && env.TMDB_API_KEY) __TMDB_KEY__ = env.TMDB_API_KEY;
    if (env && env.OMDB_API_KEY) __OMDB_KEY__ = env.OMDB_API_KEY;
  } catch (eEnv) { /* ok */ }

  var url = new URL(request.url);
  var path = url.pathname.replace(/\/+$/, '') || '/';
  var parts = path.split('/').filter(Boolean);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  var origin = url.origin;
  try { __LAST_ORIGIN__ = origin; } catch (eO) {}
  var seasonQ = url.searchParams.get('season');
  var episodeQ = url.searchParams.get('episode');
  var playersQ = url.searchParams.get('players') === '1';
  var maxCapsQ = parseInt(url.searchParams.get('maxCaps') || '5', 10);
  var sourceParam = normalizarSourceId(url.searchParams.get('source') || '');

  var commonOpts = {
    epFrom: url.searchParams.get('ep_from') || url.searchParams.get('epFrom') || null,
    epTo: url.searchParams.get('ep_to') || url.searchParams.get('epTo') || null,
    season: seasonQ ? parseInt(seasonQ, 10) : null,
    episode: episodeQ ? parseInt(episodeQ, 10) : null,
    players: playersQ,
    maxCaps: maxCapsQ,
    requestUrl: request.url
  };


  // ---------- PROXY HLS (reproduce m3u8 / segmentos con CORS) ----------
  // Solo /proxy?...  (NO confundir con &proxy=1 del endpoint /resolve)
  if (parts[0] === 'proxy') {
    var proxyTarget = url.searchParams.get('url') || '';
    if (!proxyTarget) {
      return json({ success: false, error: 'Falta url. Uso: /proxy?url={m3u8_o_segmento}' }, 400);
    }
    try {
      proxyTarget = decodeURIComponent(proxyTarget);
    } catch (eDec) {}
    if (!/^https?:\/\//i.test(proxyTarget)) {
      return json({ success: false, error: 'url debe ser http(s)' }, 400);
    }
    try {
      return await handleProxy(request, proxyTarget);
    } catch (errP) {
      return json({ success: false, error: errP.message || 'Error en proxy' }, 502);
    }
  }

  // ---------- RESOLVE embed → m3u8 (vimeos / streamwish) ----------
  // /resolve?url=...  |  /resolve/vimeos?url=...  |  /resolve/streamwish?url=...
  // &proxy=1 añade proxy_url listo para el player
  if (parts[0] === 'resolve' || url.searchParams.has('resolve')) {
    var resolveUrl = url.searchParams.get('url') || url.searchParams.get('resolve') || '';
    var provider = (parts[1] || url.searchParams.get('provider') || '').toLowerCase();
    var wantProxy = url.searchParams.get('proxy') === '1' || url.searchParams.get('proxy') === 'true';
    if (!resolveUrl) {
      return json({
        success: false,
        error: 'Falta url del embed',
        uso: {
          auto: origin + '/resolve?url={embed}&proxy=1',
          vimeos: origin + '/resolve/vimeos?url={embed}&proxy=1',
          streamwish: origin + '/resolve/streamwish?url={embed}&proxy=1'
        }
      }, 400);
    }
    try {
      resolveUrl = decodeURIComponent(resolveUrl);
    } catch (eR) {}
    if (!provider) provider = detectarProviderEmbed(resolveUrl) || 'vimeos';
    try {
      var resolved;
      // Soporta vimeos, streamwish, vidhide, voe, goodstream (auto-detect)
      var supported = ['vimeos', 'streamwish', 'vidhide', 'voe', 'goodstream'];
      if (!provider || supported.indexOf(provider) === -1) {
        provider = detectarProviderEmbedFull(resolveUrl) || detectarProviderEmbed(resolveUrl) || 'vimeos';
      }
      if (supported.indexOf(provider) === -1) {
        return json({ success: false, error: 'Provider no soportado: ' + provider + ' (usa vimeos|streamwish|vidhide|voe|goodstream)' }, 400);
      }
      resolved = await resolveByProvider(resolveUrl, provider, wantProxy ? origin : null);
      // Si pidieron proxy=1 y aún no hay proxy_url
      if (wantProxy && resolved && resolved.url && !resolved.proxy_url) {
        resolved.proxy_url = origin + '/proxy?url=' + encodeURIComponent(resolved.url);
        if (resolved.master) {
          resolved.proxy_master = origin + '/proxy?url=' + encodeURIComponent(resolved.master);
        }
      }
      return json(resolved);
    } catch (errR) {
      return json({ success: false, provider: provider || null, error: errR.message || 'Error resolviendo embed' }, 500);
    }
  }



  // ---------- Streamwish streamurl (JSON rico: hls, status, qualities + proxy) ----------
  // /wish/streamurl?url=https://streamwish.to/e/xxx
  // /streamurl?url=... (alias)
  // /wish/streamurl | /vidhide/streamurl | /voe/streamurl | /goodstream/streamurl | /streamurl?url=
  if (
    (parts[0] === 'wish' && parts[1] === 'streamurl') ||
    (parts[0] === 'vidhide' && parts[1] === 'streamurl') ||
    (parts[0] === 'voe' && parts[1] === 'streamurl') ||
    (parts[0] === 'goodstream' && parts[1] === 'streamurl') ||
    parts[0] === 'streamurl'
  ) {
    var swUrl = url.searchParams.get('url') || '';
    if (!swUrl) {
      return json({
        success: false,
        error: 'Falta url del embed',
        uso: {
          streamwish: origin + '/wish/streamurl?url=https://streamwish.to/e/XXXX',
          vidhide: origin + '/vidhide/streamurl?url=https://vidhidepro.com/v/XXXX',
          voe: origin + '/voe/streamurl?url=https://voe.sx/e/XXXX',
          goodstream: origin + '/goodstream/streamurl?url=https://goodstream.one/embed-XXXX.html',
          auto: origin + '/streamurl?url={embed}'
        }
      }, 400);
    }
    try { swUrl = decodeURIComponent(swUrl); } catch (eSw) {}
    var forceProv = '';
    if (parts[0] === 'wish') forceProv = 'streamwish';
    else if (parts[0] === 'vidhide') forceProv = 'vidhide';
    else if (parts[0] === 'voe') forceProv = 'voe';
    else if (parts[0] === 'goodstream') forceProv = 'goodstream';
    try {
      var rich = await buildProviderRichResponse(swUrl, origin, forceProv);
      return json(rich);
    } catch (errSw) {
      return json({ success: false, error: errSw.message || 'Error streamurl' }, 500);
    }
  }

  // ---------- Health ----------
  if (path === '/' && !url.searchParams.has('url') && !url.searchParams.has('q') && !url.searchParams.has('episodePostId')) {
    return json({
      status: 'ok',
      service: 'MovieZone Worker',
      sources: {
        '1': 'lamovie',
        '2': 'hackstore',
        '3': 'pelisplushd',
        '4': 'animeav1',
        '6': 'doramasflix'
      },
      endpoints: {
        search: origin + '/search?q={texto}',
        serie: origin + '/{id}/serie/{slug}',
        serie_episodio: origin + '/{id}/serie/{slug}/{temporada}/{episodio}',
        pelicula: origin + '/{id}/pelicula/{slug}',
        anime: origin + '/{id}/anime/{slug}',
        estrenos_peliculas: origin + '/3/peliculas/estrenos',
        estrenos_series: origin + '/3/series/estrenos',
        estrenos_animes: origin + '/3/animes/estrenos',
        estrenos_animeav1: origin + '/4/animes/estrenos',
        emision_animeav1: origin + '/4/animes/emision',
        proximamente_animeav1: origin + '/4/animes/proximamente',
        populares_peliculas: origin + '/3/peliculas/populares',
        por_url: origin + '/?url={url_completa}',
        resolve_vimeos: origin + '/resolve/vimeos?url={embed}&proxy=1',
        resolve_streamwish: origin + '/resolve/streamwish?url={embed}&proxy=1',
        resolve_vidhide: origin + '/resolve/vidhide?url={embed}&proxy=1',
        resolve_voe: origin + '/resolve/voe?url={embed}&proxy=1',
        resolve_goodstream: origin + '/resolve/goodstream?url={embed}&proxy=1',
        resolve_auto: origin + '/resolve?url={embed}&proxy=1',
        proxy_hls: origin + '/proxy?url={m3u8}',
        streamwish_streamurl: origin + '/wish/streamurl?url={embed_streamwish}',
        vidhide_streamurl: origin + '/vidhide/streamurl?url={embed}',
        voe_streamurl: origin + '/voe/streamurl?url={embed}',
        goodstream_streamurl: origin + '/goodstream/streamurl?url={embed}'
      },
      ejemplos: {
        buscar: origin + '/search?q=acaramelados',
        lamovie_serie: origin + '/1/serie/acaramelados-2026',
        lamovie_cap: origin + '/1/serie/acaramelados-2026/1/1',
        hackstore_serie: origin + '/2/serie/asi-aprenderas-2026',
        hackstore_cap: origin + '/2/serie/asi-aprenderas-2026/1/1',
        pelisplus_serie: origin + '/3/serie/acaramelados',
        pelisplus_cap: origin + '/3/serie/acaramelados/1/1',
        estrenos: origin + '/3/peliculas/estrenos'
      },
      nota: 'IDs de fuente: 1=lamovie, 2=hackstore, 3=pelisplushd, 4=animeav1. Van en la ruta: /{id}/anime/{slug}',
      meta: 'Búsqueda y detalle se enriquecen con TMDB (géneros, sinopsis, rating, poster, backdrop, temporadas)'
    });
  }

  // ---------- /search?q= ----------
  if (parts[0] === 'search' || url.searchParams.has('q')) {
    var query = url.searchParams.get('q') || parts[1] || '';
    if (!query) return json({ error: 'Falta q. Usa /search?q=texto' }, 400);
    try {
      var sourceFilter = sourceParam || 'all';
      var limit = parseInt(url.searchParams.get('limit') || '40', 10);
      if (!isFinite(limit) || limit < 1) limit = 40;
      if (limit > 80) limit = 80;
      var resultados = await buscarUniversal(query, sourceFilter, limit);
      if (resultados.resultados) {
        for (var ri = 0; ri < resultados.resultados.length; ri++) {
          var r = resultados.resultados[ri];
          var tipoPath = (r.tipo === 'Serie' || r.tipo === 'Anime')
            ? (r.tipo === 'Anime' ? 'anime' : 'serie')
            : 'pelicula';
          var sid = sourceIdFromName(r.fuente);
          r.titulo = limpiarTitulo(r.titulo || '');
          if (r.slug) {
            r.url_extract = origin + '/' + sid + '/' + tipoPath + '/' + r.slug;
            r.source_id = sid;
          }
          delete r.link;
          delete r.url;
        }
        // LISTADO/BÚSQUEDA: solo campos esenciales (meta completa va en detalle)
        try {
          for (var cj = 0; cj < resultados.resultados.length; cj++) {
            resultados.resultados[cj] = slimResultadoLista(resultados.resultados[cj], origin);
          }
          resultados.total = resultados.resultados.length;
        } catch (eSlim) { /* silencioso */ }
      }
      var pageNum = parseInt(url.searchParams.get('page') || '1', 10) || 1;
      var lista = (resultados && resultados.resultados) ? resultados.resultados : [];
      return json({
        query: query,
        page: pageNum,
        count: lista.length,
        results: lista
      });
    } catch (err) {
      return json({ success: false, error: err.message }, 500);
    }
  }

  // ---------- episodePostId (compat) ----------
  var episodePostId = url.searchParams.get('episodePostId');
  if (episodePostId) {
    try {
      var pd = await getPlayerLamovie(episodePostId);
      return json({
        success: true,
        fuente: 'lamovie',
        source_id: '1',
        tipo: 'Capitulo',
        postId: Number(episodePostId) || episodePostId,
        titulo: null,
        total: pd.embeds.length,
        embeds: pd.embeds.map(function (e) { return e.url; }),
        reproductores: pd.embeds,
        descargas: pd.downloads
      });
    } catch (err) {
      return json({ success: false, error: err.message }, 500);
    }
  }

  // ---------- Catálogos PelisPlus: /3/peliculas/estrenos, /3/series/estrenos, etc. ----------
  // parts: [3, peliculas, estrenos] o [pelisplushd, peliculas, estrenos]
  var catSource = normalizarSourceId(parts[0] || '');
  var catTipoIdx = catSource ? 1 : 0;
  var catSeccion = (parts[catTipoIdx] || '').toLowerCase(); // peliculas|series|animes
  var catFiltro = (parts[catTipoIdx + 1] || '').toLowerCase(); // estrenos|populares|''

  if ((catSeccion === 'peliculas' || catSeccion === 'series' || catSeccion === 'animes') &&
      (catFiltro === 'estrenos' || catFiltro === 'populares' || catFiltro === 'emision' || catFiltro === 'proximo' || catFiltro === 'proximamente' || catFiltro === '' || catFiltro === 'page')) {
    var pageNum = parseInt(url.searchParams.get('page') || '1', 10);
    if (catFiltro === 'page' && parts[catTipoIdx + 2]) {
      pageNum = parseInt(parts[catTipoIdx + 2], 10) || 1;
      catFiltro = '';
    }
    var srcCat = catSource || sourceParam || '';
    // AnimeAV1: /4/animes/estrenos o /4/animes/emision → catálogo en emisión
    var esAnimeAv1Cat =
      String(parts[0]) === '4' ||
      parts[0] === 'animeav1' ||
      parts[0] === 'av1' ||
      srcCat === 'animeav1' ||
      srcCat === '4' ||
      srcCat === 'av1';

    try {
      var catalogo = null;
      if (esAnimeAv1Cat && catSeccion === 'animes') {
        var filtroAv1 = 'emision';
        if (catFiltro === 'populares') filtroAv1 = 'populares';
        else if (catFiltro === 'proximo' || catFiltro === 'proximamente') filtroAv1 = 'proximo';
        else if (catFiltro === 'estrenos' || catFiltro === 'emision' || !catFiltro) filtroAv1 = 'emision';
        catalogo = await listarAnimeAv1Catalogo(filtroAv1, pageNum, origin);
      } else {
        // PelisPlus (flujo original)
        if (srcCat !== 'pelisplushd' && srcCat !== '3') {
          if (String(parts[0]) !== '3' && parts[0] !== 'pelisplushd' && parts[0] !== 'pp') {
            return json({
              success: false,
              error: 'Catalogos: PelisPlus /3/... o AnimeAV1 /4/animes/estrenos',
              ejemplos: {
                pelisplus: origin + '/3/peliculas/estrenos',
                animeav1: origin + '/4/animes/estrenos'
              }
            }, 400);
          }
        }
        catalogo = await listarPelisplusCatalogo(catSeccion, catFiltro || null, pageNum, origin);
      }
      if (catalogo && catalogo.resultados && catalogo.resultados.length) {
        try {
          if (catalogo && Array.isArray(catalogo.resultados)) {
            for (var ci = 0; ci < catalogo.resultados.length; ci++) {
              catalogo.resultados[ci] = slimResultadoLista(catalogo.resultados[ci], origin);
            }
            catalogo.total = catalogo.resultados.length;
          }
        } catch (eCat) { /* ok */ }
      }
      var catLista = (catalogo && catalogo.resultados) ? catalogo.resultados : [];
      return json({
        page: pageNum || 1,
        count: catLista.length,
        results: catLista,
        fuente: esAnimeAv1Cat ? 'animeav1' : 'pelisplushd'
      });
    } catch (err) {
      return json({ success: false, error: err.message }, 500);
    }
  }

  // ---------- Rutas con ID: /{id}/serie|pelicula|anime/{slug}[/{s}/{e}] ----------
  // parts[0] puede ser 1|2|3|lamovie|hackstore|pelisplushd
  var pathSource = normalizarSourceId(parts[0] || '');
  var tipoIdx = pathSource ? 1 : 0;
  var tipoRuta = parts[tipoIdx];

  if (tipoRuta === 'pelicula' || tipoRuta === 'serie' || tipoRuta === 'anime') {
    var slug = parts[tipoIdx + 1];
    if (!slug) {
      return json({ error: 'Falta el slug. Ej: /2/serie/nombre-titulo' }, 400);
    }
    // /2/serie/slug/1/2
    if (parts[tipoIdx + 2] && parts[tipoIdx + 3]) {
      commonOpts.season = parseInt(parts[tipoIdx + 2], 10);
      commonOpts.episode = parseInt(parts[tipoIdx + 3], 10);
    }

    var forcedSource = pathSource || sourceParam || '';

    try {
      var resultadoPath = await scrapearPorSlug(tipoRuta, slug, forcedSource, commonOpts, origin);
      var esReqCapitulo = !!(commonOpts.season && commonOpts.episode);

      // Capítulo: solo reproductores (la meta está en el detalle de la serie)
      if (esReqCapitulo || (resultadoPath && (resultadoPath.tipo === 'Capitulo' || resultadoPath.tipo === 'Capítulo'))) {
        resultadoPath = formatearCapituloRespuesta(resultadoPath, origin, {
          slug: slug,
          source_id: forcedSource || (resultadoPath && resultadoPath.source_id),
          season: commonOpts.season,
          episode: commonOpts.episode,
          tipoRuta: tipoRuta
        });
        return json(resultadoPath);
      }

      // Serie / película / anime (ficha completa)
      try {
        resultadoPath = await enriquecerDetalleConTmdb(resultadoPath, tipoRuta);
      } catch (eDet) { /* silencioso */ }
      if (resultadoPath && (!resultadoPath.portada || esPortadaSospechosa(resultadoPath.portada))) {
        if (resultadoPath.portada_imdb && esPortadaUrlValida(resultadoPath.portada_imdb)) {
          resultadoPath.portada = resultadoPath.portada_imdb;
          resultadoPath.poster_source = 'imdb';
        } else if (resultadoPath.portada_tmdb && esPortadaUrlValida(resultadoPath.portada_tmdb)) {
          resultadoPath.portada = resultadoPath.portada_tmdb;
          resultadoPath.poster_source = 'tmdb';
        }
      }
      if (resultadoPath) {
        normalizarCamposResultado(resultadoPath);
        resultadoPath = formatearDetalleRespuesta(resultadoPath, origin);
      }
      return json(resultadoPath);
    } catch (err) {
      return json({
        success: false,
        error: err.message || 'No se encontro el titulo',
        slug: slug,
        tipo: tipoRuta,
        source_id: forcedSource || null
      }, 404);
    }
  }

  // ---------- ?url= (compat completo) ----------
  var targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return json({
      error: 'Usa rutas con id de fuente',
      ejemplos: {
        serie: origin + '/1/serie/acaramelados-2026',
        capitulo: origin + '/1/serie/acaramelados-2026/1/1',
        hackstore: origin + '/2/serie/asi-aprenderas-2026/1/1',
        search: origin + '/search?q=matrix'
      },
      sources: { '1': 'lamovie', '2': 'hackstore', '3': 'pelisplushd', '4': 'animeav1',
        '6': 'doramasflix' }
    }, 400);
  }

  targetUrl = normalizarUrlEntrada(targetUrl);
  var source = sourceParam || detectarFuente(targetUrl);

  try {
    var resultado;
    if (source === 'pelisplushd') {
      resultado = await scrapearPelisplus(targetUrl, commonOpts);
    } else if (source === 'hackstore') {
      resultado = await scrapearHackstore(targetUrl, commonOpts);
    } else if (source === 'animeav1') {
      resultado = await scrapearAnimeAv1(targetUrl, commonOpts);
    } else if (source === 'doramasflix') {
      resultado = await scrapearDoramasflix(targetUrl, commonOpts);
    } else {
      resultado = await scrapearLamovie(targetUrl, commonOpts);
    }
    resultado = reescribirLinksCortos(resultado, origin, null, null, source);
    try {
      resultado = await enriquecerDetalleConTmdb(resultado, resultado.tipo || '');
    } catch (eUrl) { /* ok */ }
    if (resultado && (!resultado.portada || esPortadaSospechosa(resultado.portada))) {
      if (resultado.portada_imdb && esPortadaUrlValida(resultado.portada_imdb)) {
        resultado.portada = resultado.portada_imdb;
        resultado.poster_source = 'imdb';
      } else if (resultado.portada_tmdb && esPortadaUrlValida(resultado.portada_tmdb)) {
        resultado.portada = resultado.portada_tmdb;
        resultado.poster_source = 'tmdb';
      }
    }
    if (resultado) {
      normalizarCamposResultado(resultado);
      resultado = formatearDetalleRespuesta(resultado, origin);
    }
    return json(resultado);
  } catch (err) {
    return json({
      success: false,
      error: err.message || 'Error al scrapear',
      fuente: source
    }, 500);
  }
}

/** 1=lamovie, 2=hackstore, 3=pelisplushd, 4=animeav1, 6=doramasflix */
function normalizarSourceId(s) {
  s = String(s || '').toLowerCase().trim();
  if (s === '1' || s === 'lamovie' || s === 'lm') return 'lamovie';
  if (s === '2' || s === 'hackstore' || s === 'hs') return 'hackstore';
  if (s === '3' || s === 'pelisplushd' || s === 'pelisplus' || s === 'pp') return 'pelisplushd';
  if (s === '4' || s === 'animeav1' || s === 'av1' || s === 'aa1') return 'animeav1';
  if (s === '6' || s === 'doramasflix' || s === 'doramas' || s === 'dfx') return 'doramasflix';
  return '';
}

function sourceIdFromName(name) {
  name = String(name || '').toLowerCase();
  if (name === 'hackstore') return '2';
  if (name === 'pelisplushd') return '3';
  if (name === 'animeav1') return '4';
  if (name === 'doramasflix') return '6';
  return '1'; // lamovie default
}

function sourceNameFromId(id) {
  id = String(id || '').toLowerCase();
  if (id === '2' || id === 'hackstore' || id === 'hs') return 'hackstore';
  if (id === '3' || id === 'pelisplushd' || id === 'pp') return 'pelisplushd';
  if (id === '4' || id === 'animeav1' || id === 'av1') return 'animeav1';
  if (id === '6' || id === 'doramasflix' || id === 'dfx') return 'doramasflix';
  if (id === '1' || id === 'lamovie' || id === 'lm') return 'lamovie';
  return id || '';
}

/** Construye URLs candidatas por fuente y scrapea la primera que funcione */
async function scrapearPorSlug(tipoRuta, slug, sourceParam, opts, origin) {
  opts = opts || {};
  slug = decodeURIComponent(slug).replace(/\/$/, '');
  sourceParam = normalizarSourceId(sourceParam) || sourceParam;
  var seasonOnly = opts.season ? parseInt(opts.season, 10) : null;
  var episodeOnly = opts.episode ? parseInt(opts.episode, 10) : null;
  var esCapitulo = !!(seasonOnly && episodeOnly);
  var esPelicula = tipoRuta === 'pelicula';
  var esSerieListado = !esCapitulo && !esPelicula;

  var candidatos = [];
  var seenCand = Object.create(null);

  function add(src, fullUrl) {
    if (!fullUrl) return;
    var key = src + '|' + fullUrl;
    if (seenCand[key]) return;
    seenCand[key] = true;
    candidatos.push({
      fuente: src,
      url: fullUrl,
      preferred: !!(sourceParam && sourceParam === src)
    });
  }

  var slugBase = slug.replace(/-\d{4}$/, '');
  var slugsTry = [slug];
  if (slugBase !== slug) slugsTry.push(slugBase);

  for (var si = 0; si < slugsTry.length; si++) {
    var s = slugsTry[si];
    if (tipoRuta === 'pelicula') {
      // PELÍCULA: NUNCA animeav1 (contaminan con "Anime" el mismo slug)
      // Orden: pelisplus → lamovie → hackstore → doramasflix (cine)
      add('pelisplushd', PELISPLUS_BASE + '/pelicula/' + s + '/');
      add('lamovie', LAMOVIE_BASE + '/peliculas/' + s + '/');
      add('hackstore', HACKSTORE_BASE + '/peliculas/' + s + '/');
      add('doramasflix', DORAMASFLIX_BASE + '/peliculas/' + s);
    } else if (tipoRuta === 'anime') {
      // ANIME: fuentes de anime primero
      add('animeav1', ANIMEAV1_BASE + '/media/' + s);
      add('pelisplushd', PELISPLUS_BASE + '/anime/' + s + '/');
      add('lamovie', LAMOVIE_BASE + '/animes/' + s + '/');
      add('hackstore', HACKSTORE_BASE + '/animes/' + s + '/');
      // serie como último recurso (algunos animes solo en /serie/)
      add('pelisplushd', PELISPLUS_BASE + '/serie/' + s + '/');
      add('hackstore', HACKSTORE_BASE + '/series/' + s + '/');
    } else {
      // SERIE / dorama: NO poner animeav1 primero (mete películas live-action como Anime)
      add('doramasflix', DORAMASFLIX_BASE + '/doramas/' + s);
      add('pelisplushd', PELISPLUS_BASE + '/serie/' + s + '/');
      add('lamovie', LAMOVIE_BASE + '/series/' + s + '/');
      add('hackstore', HACKSTORE_BASE + '/series/' + s + '/');
      // anime solo al final y solo si no hay fuente forzada de serie
      add('pelisplushd', PELISPLUS_BASE + '/anime/' + s + '/');
      add('animeav1', ANIMEAV1_BASE + '/media/' + s);
      add('hackstore', HACKSTORE_BASE + '/animes/' + s + '/');
    }
  }

  /**
   * ¿El resultado scrapeado corresponde al slug pedido?
   * Evita unir one-piece-heroines con one-piece (obras distintas).
   * Solo acepta: slug exacto, variante season/part del MISMO slug, o título normalizado idéntico.
   */
  function resultadoCoincideSlug(requestedSlug, resultSlug, resultTitle) {
    var req = normalizarSlugKey(requestedSlug || '');
    var got = normalizarSlugKey(resultSlug || '');
    if (req && got && req === got) return true;
    // Variante de temporada del mismo slug: one-piece-season-2
    if (req && got && got.indexOf(req) === 0) {
      var rest = got.slice(req.length);
      if (!rest || /^(season|part|temporada|s)?\d{0,2}$/i.test(rest)) return true;
    }
    // Título normalizado idéntico (no prefijo: "one piece" ≠ "one piece heroines")
    var titleReq = normalizarTituloKey(String(requestedSlug || '').replace(/-/g, ' '));
    var titleGot = normalizarTituloKey(resultTitle || String(resultSlug || '').replace(/-/g, ' '));
    if (titleReq && titleGot && titleReq === titleGot) return true;
    return false;
  }

  // Resolver slug real de AnimeAV1 SOLO si pedimos anime (nunca en pelicula/serie live-action)
  var animeAv1Slugs = [];
  if (tipoRuta === 'anime') {
    try {
      var qAv1 = slug.replace(/-/g, ' ');
      var hitsAv1 = await buscarAnimeAv1(qAv1, 12);
      for (var ha = 0; ha < (hitsAv1 || []).length; ha++) {
        var hitAv = hitsAv1[ha];
        var hs = hitAv && hitAv.slug;
        if (!hs) continue;
        if (/-(?:season|temporada|part|parte)-\d+$/i.test(hs) ||
            /-\d+(?:st|nd|rd|th)-season$/i.test(hs)) continue;
        if (!resultadoCoincideSlug(slug, hs, hitAv.titulo || hitAv.title)) continue;
        if (animeAv1Slugs.indexOf(hs) === -1) animeAv1Slugs.push(hs);
        add('animeav1', ANIMEAV1_BASE + '/media/' + hs);
      }
    } catch (eAv1) { /* ok */ }
  }

  // Si es capítulo, URLs de episodio concretas por fuente
  if (esCapitulo) {
    for (var sc = 0; sc < slugsTry.length; sc++) {
      var ss = slugsTry[sc];
      add('pelisplushd', PELISPLUS_BASE + '/serie/' + ss + '/temporada/' + seasonOnly + '/capitulo/' + episodeOnly + '/');
      add('pelisplushd', PELISPLUS_BASE + '/anime/' + ss + '/temporada/' + seasonOnly + '/capitulo/' + episodeOnly + '/');
    }
    for (var as = 0; as < animeAv1Slugs.length; as++) {
      var avs = animeAv1Slugs[as];
      // AnimeAV1: T1 en slug base, T2+ en slug-season-N (episodio suele ser el número dentro de la temporada)
      if (seasonOnly <= 1) {
        add('animeav1', ANIMEAV1_BASE + '/media/' + avs + '/' + episodeOnly);
      } else {
        add('animeav1', ANIMEAV1_BASE + '/media/' + avs + '-season-' + seasonOnly + '/' + episodeOnly);
        add('animeav1', ANIMEAV1_BASE + '/media/' + avs + '/' + episodeOnly);
      }
    }
  }

  candidatos.sort(function (a, b) {
    // preferred (source forzado en ruta /1/ /3/ etc.) SIEMPRE primero
    var p = (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0);
    if (p !== 0) return p;
    // Orden según tipo pedido (no mezclar anime en películas)
    var order;
    if (tipoRuta === 'pelicula') {
      order = { pelisplushd: 0, lamovie: 1, hackstore: 2, doramasflix: 3 };
    } else if (tipoRuta === 'anime') {
      order = { animeav1: 0, pelisplushd: 2, lamovie: 3, hackstore: 4, doramasflix: 5 };
    } else {
      // serie
      order = { doramasflix: 0, pelisplushd: 1, lamovie: 2, hackstore: 3, animeav1: 8 };
    }
    return (order[a.fuente] != null ? order[a.fuente] : 9) - (order[b.fuente] != null ? order[b.fuente] : 9);
  });

  // Fuente forzada (/1/...) va primero (preferred), pero NO eliminamos el resto:
  // si lamovie falla, se prueba pelisplus/hackstore del MISMO tipo.
  // animeav1 ya no está en candidatos de pelicula.

  // Cascada: primera fuente que responda bien gana. Sin fusión entre fuentes.
  var lastErr = null;

  async function scrapeOne(c) {
    try {
      var r;
      var o2 = Object.assign({}, opts);
      if (c.fuente === 'pelisplushd') r = await scrapearPelisplus(c.url, o2);
      else if (c.fuente === 'animeav1') r = await scrapearAnimeAv1(c.url, o2);
      else if (c.fuente === 'doramasflix') r = await scrapearDoramasflix(c.url, o2);
      else if (c.fuente === 'hackstore') r = await scrapearHackstore(c.url, o2);
      else r = await scrapearLamovie(c.url, o2);
      if (r && r.success !== false) {
        if (esCapitulo && r.tipo === 'Capitulo' && (!r.reproductores || !r.reproductores.length)) {
          return null;
        }
        // No aceptar Anime cuando se pidió película (animeav1 contamina slugs live-action)
        var tipoRes = String(r.tipo || '').toLowerCase();
        if (tipoRuta === 'pelicula' && (tipoRes.indexOf('anime') !== -1 || c.fuente === 'animeav1' )) {
          return null;
        }
        // No aceptar Anime cuando se pidió serie con fuente forzada distinta de animeav1
        // (evita que la cascada "filtre" a animeav1 cuando pelisplushd falla en un slug)
        if (tipoRuta === 'serie' && (tipoRes.indexOf('anime') !== -1 || c.fuente === 'animeav1') &&
            sourceParam && sourceParam !== 'animeav1') {
          return null;
        }
        // No aceptar Película cuando se pidió anime (salvo que la fuente sea anime)
        if (tipoRuta === 'anime' && (tipoRes === 'pelicula' || tipoRes === 'película') && c.fuente !== 'animeav1' ) {
          // permitir: algunos animes vienen etiquetados raro
        }
        // Debe coincidir con el slug pedido
        if (!resultadoCoincideSlug(slug, r.slug, r.titulo || r.titulo_serie)) {
          if (normalizarSlugKey(r.slug) !== normalizarSlugKey(slug)) return null;
        }
        r.source_id = sourceIdFromName(c.fuente);
        r.fuente = c.fuente;
        r._fuente_scrape = c.fuente;
        r._slug_scrape = slug;
        // Respetar tipo de la RUTA para películas (no dejar que scrape diga Anime)
        if (tipoRuta === 'pelicula' && !esCapitulo) {
          r.tipo = 'Pelicula';
        }
        if (tipoRuta === 'serie' && !esCapitulo && tipoRes.indexOf('anime') === -1) {
          r.tipo = r.tipo || 'Serie';
        }
        return r;
      }
    } catch (e) {
      lastErr = e;
    }
    return null;
  }

  var resultadoFinal = null;
  for (var i = 0; i < candidatos.length; i++) {
    var one = await scrapeOne(candidatos[i]);
    if (one) {
      resultadoFinal = one;
      break;
    }
  }

  if (resultadoFinal) {
    resultadoFinal.slug = slug;
    if (esCapitulo) {
      resultadoFinal.tipo = 'Capitulo';
      resultadoFinal.temporada = seasonOnly;
      resultadoFinal.episodio = episodeOnly;
    }
    delete resultadoFinal._fuente_scrape;
    delete resultadoFinal._slug_scrape;
    return reescribirLinksCortos(resultadoFinal, origin, slug, tipoRuta, resultadoFinal.fuente);
  }

  // Fallback búsqueda universal — solo hits de la MISMA obra (slug/título exacto)
  var q = slug.replace(/-/g, ' ');
  var busqueda = await buscarUniversal(q, 'all', 12);
  var hits = (busqueda && busqueda.resultados) || [];
  for (var h = 0; h < hits.length; h++) {
    var hit = hits[h];
    // Debe coincidir con el slug/obra pedido (no hermanos de franquicia)
    if (!resultadoCoincideSlug(slug, hit.slug, hit.titulo)) continue;
    // También validar alternativas del hit
    var tipoOk =
      (tipoRuta === 'pelicula' && hit.tipo === 'Pelicula') ||
      (tipoRuta === 'serie' && (hit.tipo === 'Serie' || hit.tipo === 'Anime')) ||
      (tipoRuta === 'anime' && (hit.tipo === 'Anime' || hit.tipo === 'Serie' || hit.tipo === 'Pelicula')) ||
      normalizarSlugKey(hit.slug) === normalizarSlugKey(slug);
    if (!tipoOk) continue;

    // Sin alternativas: solo el hit de la fuente que ganó la cascada
    if (!hit.link || !resultadoCoincideSlug(slug, hit.slug, hit.titulo)) continue;

    try {
      var hf = hit.fuente;
      var hl = hit.link;
      var o3 = Object.assign({}, opts);
      if (esCapitulo && hf === 'pelisplushd' && hl && !/\/temporada\//i.test(hl)) {
        var mslug = hit.slug || slug;
        hl = PELISPLUS_BASE + (/anime/i.test(tipoRuta) ? '/anime/' : '/serie/') + mslug +
          '/temporada/' + seasonOnly + '/capitulo/' + episodeOnly + '/';
      }
      if (esCapitulo && hf === 'animeav1' && hit.slug) {
        var avslug = hit.slug;
        if (seasonOnly > 1) {
          hl = ANIMEAV1_BASE + '/media/' + avslug + '-season-' + seasonOnly + '/' + episodeOnly;
        } else {
          hl = ANIMEAV1_BASE + '/media/' + avslug + '/' + episodeOnly;
        }
      }
      var r2;
      if (hf === 'pelisplushd') r2 = await scrapearPelisplus(hl, o3);
      else if (hf === 'hackstore') r2 = await scrapearHackstore(hl, o3);
      else if (hf === 'animeav1') r2 = await scrapearAnimeAv1(hl, o3);
      else if (hf === 'doramasflix') r2 = await scrapearDoramasflix(hl, o3);
      else r2 = await scrapearLamovie(hl, o3);
      if (r2 && r2.success !== false) {
        if (!resultadoCoincideSlug(slug, r2.slug, r2.titulo || r2.titulo_serie)) continue;
        if (esCapitulo && (!r2.reproductores || !r2.reproductores.length)) continue;
        r2.fuente = hf;
        r2.source_id = sourceIdFromName(hf);
        r2.slug = slug;
        if (esCapitulo) {
          r2.tipo = 'Capitulo';
          r2.temporada = seasonOnly;
          r2.episodio = episodeOnly;
        }
        return reescribirLinksCortos(r2, origin, slug, tipoRuta, hf);
      }
    } catch (e2) {
      lastErr = e2;
    }
  }

  throw lastErr || new Error('No se encontro "' + slug + '" en ninguna fuente');
}

/** Normaliza URL de embed para deduplicar entre fuentes (misma URL = mismo player) */
function normalizarUrlEmbed(url) {
  if (!url) return '';
  var u = String(url).trim();
  try {
    u = u.replace(/^http:\/\//i, 'https://');
    u = u.replace(/\/+$/, '');
    // quitar tracking común
    u = u.replace(/([?&])(utm_[^=]+|ref|referrer)=[^&]*/gi, '');
    u = u.replace(/[?&]$/, '');
  } catch (e) { /* ok */ }
  return u.toLowerCase();
}

/**
 * Prioridad de un reproductor individual:
 * 1) fuente animeav1
 * 2) servidores preferidos (vimeos, streamwish, …)
 * 3) resto de fuentes
 */
function scoreReproductor(rep) {
  if (!rep) return 0;
  var s = 0;
  var f = String(rep.fuente || '').toLowerCase();
  if (f === 'animeav1') s += 100;
  else if (f === 'pelisplushd') s += 40;
  else if (f === 'lamovie') s += 30;
  else if (f === 'hackstore') s += 20;
  var srv = String(rep.servidor || '').toLowerCase();
  var url = String(rep.url || '').toLowerCase();
  if (srv.indexOf('vimeos') !== -1 || url.indexOf('vimeos') !== -1) s += 50;
  else if (srv.indexOf('streamwish') !== -1 || url.indexOf('streamwish') !== -1) s += 40;
  else if (srv.indexOf('vidhide') !== -1 || url.indexOf('vidhide') !== -1) s += 35;
  else if (srv.indexOf('voe') !== -1 || url.indexOf('voe') !== -1) s += 30;
  else if (srv.indexOf('goodstream') !== -1 || url.indexOf('goodstream') !== -1) s += 28;
  else if (srv.indexOf('filemoon') !== -1 || url.indexOf('filemoon') !== -1) s += 25;
  else if (srv.indexOf('dood') !== -1 || url.indexOf('dood') !== -1) s += 15;
  return s;
}

/**
 * Une reproductores de VARIAS FUENTES distintas (capítulo o película).
 * REGLA: dentro de una misma fuente no se “deduplican obras”; aquí solo se
 * eliminan la misma URL de embed si aparece en más de una fuente.
 * Prioridad de fuente base y orden de players: animeav1 → pelisplushd → lamovie → hackstore.
 */
function fusionarReproductoresFuentes(resultadosOk) {
  if (!resultadosOk || !resultadosOk.length) return {};

  // Ordenar resultados: animeav1 primero como base de metadatos
  var ordered = resultadosOk.slice().sort(function (a, b) {
    var fa = String(a._fuente_scrape || a.fuente || '');
    var fb = String(b._fuente_scrape || b.fuente || '');
    var pa = typeof prioridadFuente === 'function' ? prioridadFuente(fa) : 9;
    var pb = typeof prioridadFuente === 'function' ? prioridadFuente(fb) : 9;
    if (pa !== pb) return pa - pb;
    return (b.reproductores || []).length - (a.reproductores || []).length;
  });

  var base = {};
  var src0 = ordered[0];
  for (var k in src0) {
    if (Object.prototype.hasOwnProperty.call(src0, k)) base[k] = src0[k];
  }

  // Deduplicar por URL normalizada (misma URL entre fuentes = mismo player)
  var seenUrls = Object.create(null);
  var allReps = [];
  var allDesc = [];
  var fuentesUsadas = [];
  var seenFuente = Object.create(null);

  for (var ri = 0; ri < ordered.length; ri++) {
    var rr = ordered[ri];
    var fName = rr._fuente_scrape || rr.fuente || '';
    if (fName && !seenFuente[fName]) {
      seenFuente[fName] = true;
      fuentesUsadas.push(fName);
    }

    // Metadatos: rellenar huecos desde otras fuentes (portada, etc.)
    if (typeof mejorPortada === 'function') {
      base.portada = mejorPortada(base.portada, rr.portada);
    } else if ((!base.portada || /placeholder/i.test(String(base.portada))) && rr.portada) {
      base.portada = rr.portada;
    }
    if ((!base.descripcion || String(base.descripcion).length < 40) && rr.descripcion) base.descripcion = rr.descripcion;
    if (!base.titulo && rr.titulo) base.titulo = rr.titulo;
    if (!base.year && rr.year) base.year = rr.year;
    if (!base.calificacion && rr.calificacion) base.calificacion = rr.calificacion;

    var reps = rr.reproductores || [];
    // Dentro de la misma fuente: solo saltar URL exacta repetida (error de scrape)
    var seenInSource = Object.create(null);
    for (var pi = 0; pi < reps.length; pi++) {
      var pu = reps[pi] && reps[pi].url ? String(reps[pi].url) : '';
      if (!pu) continue;
      var key = normalizarUrlEmbed(pu);
      // Entre fuentes: misma URL = duplicado → no añadir de nuevo
      if (seenUrls[key]) continue;
      // Dentro de la misma fuente: URL idéntica repetida = ruido de scrape
      if (seenInSource[key]) continue;
      seenInSource[key] = true;
      seenUrls[key] = true;

      var repCopy = {};
      for (var pk in reps[pi]) {
        if (Object.prototype.hasOwnProperty.call(reps[pi], pk)) repCopy[pk] = reps[pi][pk];
      }
      if (!repCopy.fuente) repCopy.fuente = fName;
      if (!repCopy.servidor) repCopy.servidor = extraerServidor(pu);
      allReps.push(repCopy);
    }

    var dls = rr.descargas || [];
    for (var di = 0; di < dls.length; di++) {
      var du = dls[di] && dls[di].url ? String(dls[di].url) : '';
      if (!du) continue;
      var dkey = 'dl:' + normalizarUrlEmbed(du);
      if (seenUrls[dkey]) continue;
      seenUrls[dkey] = true;
      var dlCopy = {};
      for (var dk in dls[di]) {
        if (Object.prototype.hasOwnProperty.call(dls[di], dk)) dlCopy[dk] = dls[di][dk];
      }
      if (!dlCopy.fuente) dlCopy.fuente = fName;
      allDesc.push(dlCopy);
    }
  }

  // Ordenar players: animeav1 + mejores servidores primero
  allReps.sort(function (a, b) {
    return scoreReproductor(b) - scoreReproductor(a);
  });

  base.reproductores = allReps;
  base.embeds = allReps.map(function (r) { return r.url; });
  base.total = allReps.length;
  if (allDesc.length) base.descargas = allDesc;

  // Fuentes ordenadas por prioridad
  if (typeof ordenarFuentesLista === 'function') {
    base.fuentes = ordenarFuentesLista(fuentesUsadas);
  } else {
    base.fuentes = fuentesUsadas;
  }
  // Fuente principal: animeav1 si aportó players o está en la lista
  var fuentePref = base.fuentes[0] || base.fuente;
  if (base.fuentes.indexOf('animeav1') !== -1) fuentePref = 'animeav1';
  base.fuente = fuentePref;
  base.source_id = sourceIdFromName(fuentePref || '');

  if (base.fuentes.length > 1) {
    base.nota_fusion = 'Reproductores unidos de: ' + base.fuentes.join(', ') +
      ' (prioridad animeav1 → pelisplushd → lamovie → hackstore; sin duplicar misma URL)';
  }
  delete base._fuente_scrape;
  delete base._slug_scrape;
  return base;
}

/**
 * Fusiona listados de serie/anime:
 * - Temporadas de TODAS las fuentes (si AnimeAV1 tiene T2 y otras solo T1 → quedan T1+T2)
 * - Episodios por T+E
 * - Reproductores sumados por episodio
 */
function fusionarDetalleSerie(resultadosOk, tipoRuta) {
  // Preferir la fuente con MÁS episodios y temporadas (animeav1 suele ganar a hackstore)
  var scored = resultadosOk.slice().sort(function (a, b) {
    var ea = a.total_episodios || countEpsInResult(a);
    var eb = b.total_episodios || countEpsInResult(b);
    if (eb !== ea) return eb - ea;
    var ta = a.total_temporadas || (a.temporadas && a.temporadas.length) || 0;
    var tb = b.total_temporadas || (b.temporadas && b.temporadas.length) || 0;
    if (tb !== ta) return tb - ta;
    // Anime: animeav1 primero
    var fa = String(a._fuente_scrape || a.fuente || '');
    var fb = String(b._fuente_scrape || b.fuente || '');
    if (tipoRuta === 'anime') {
      if (fa === 'animeav1' && fb !== 'animeav1') return -1;
      if (fb === 'animeav1' && fa !== 'animeav1') return 1;
    }
    return scoreItemBusqueda(b) - scoreItemBusqueda(a);
  });

  var base = {};
  var s0 = scored[0];
  for (var k in s0) {
    if (Object.prototype.hasOwnProperty.call(s0, k)) base[k] = s0[k];
  }

  var fuentesUsadas = [];
  var maxTotalDeclarado = 0;
  var bestRangos = null;
  var bySeason = Object.create(null);

  function ensureSeason(n) {
    if (!bySeason[n]) bySeason[n] = Object.create(null);
    return bySeason[n];
  }

  function mergeEp(target, src, fName) {
    if (!target.titulo && src.titulo) target.titulo = src.titulo;
    if (!target.overview && src.overview) target.overview = src.overview;
    if (!target.still && src.still) target.still = src.still;
    if (!target.url_video && src.url_video) target.url_video = src.url_video;
    if (!target.link && src.link) target.link = src.link;
    if (!target.slug_media && src.slug_media) target.slug_media = src.slug_media;

    // Deduplicar players entre fuentes por URL normalizada (misma URL = mismo embed)
    var seen = Object.create(null);
    var reps = (target.reproductores || []).slice();
    for (var i = 0; i < reps.length; i++) {
      if (reps[i] && reps[i].url) seen[normalizarUrlEmbed(reps[i].url)] = true;
    }
    var add = src.reproductores || [];
    var seenInSrc = Object.create(null);
    for (var j = 0; j < add.length; j++) {
      var u = add[j] && add[j].url ? String(add[j].url) : '';
      if (!u) continue;
      var key = normalizarUrlEmbed(u);
      // Entre fuentes: misma URL → skip
      if (seen[key]) continue;
      // Dentro de la misma fuente: URL repetida → ruido de scrape
      if (seenInSrc[key]) continue;
      seenInSrc[key] = true;
      seen[key] = true;
      var copy = {};
      for (var pk in add[j]) {
        if (Object.prototype.hasOwnProperty.call(add[j], pk)) copy[pk] = add[j][pk];
      }
      if (!copy.fuente) copy.fuente = fName;
      if (!copy.servidor) copy.servidor = extraerServidor(u);
      reps.push(copy);
    }
    // Orden: animeav1 + mejores servidores primero
    reps.sort(function (a, b) { return scoreReproductor(b) - scoreReproductor(a); });
    target.reproductores = reps;
    target.embeds = reps.map(function (x) { return x.url; });
    if (reps[0]) target.reproductor = reps[0].url;
  }

  for (var ri = 0; ri < scored.length; ri++) {
    var rr = scored[ri];
    var fName = rr._fuente_scrape || rr.fuente || '';
    if (fName && fuentesUsadas.indexOf(fName) === -1) fuentesUsadas.push(fName);

    var decl = parseInt(rr.total_episodios, 10) || 0;
    if (decl > maxTotalDeclarado) maxTotalDeclarado = decl;
    // Conservar rangos del que declare más episodios (One Piece 1175+)
    if (Array.isArray(rr.rangos_episodios) && rr.rangos_episodios.length) {
      if (!bestRangos || decl >= (parseInt(base.total_episodios, 10) || 0)) {
        bestRangos = rr.rangos_episodios;
      }
    }

    if ((!base.portada || /placeholder/i.test(String(base.portada))) && rr.portada) base.portada = rr.portada;
    if ((!base.descripcion || String(base.descripcion).length < 40) && rr.descripcion) base.descripcion = rr.descripcion;
    if (!base.year && rr.year) base.year = rr.year;
    if (!base.calificacion && rr.calificacion) base.calificacion = rr.calificacion;

    var temps = rr.temporadas || [];
    for (var ti = 0; ti < temps.length; ti++) {
      var t = temps[ti];
      var sn = parseInt(t.temporada || t.season || (ti + 1), 10) || 1;
      var eps = t.episodios || t.capitulos || [];
      var seasonMap = ensureSeason(sn);
      if (t.slug_media && !seasonMap._slug_media) seasonMap._slug_media = t.slug_media;
      if (t.titulo && !seasonMap._titulo) seasonMap._titulo = t.titulo;

      for (var ei = 0; ei < eps.length; ei++) {
        var ep = eps[ei];
        var en = parseInt(ep.episodio || ep.episode || (ei + 1), 10) || (ei + 1);
        if (!seasonMap[en]) {
          seasonMap[en] = {
            temporada: sn,
            episodio: en,
            titulo: ep.titulo || ('Episodio ' + en),
            overview: ep.overview || '',
            still: ep.still || null,
            link: ep.link || ep.url_video || null,
            url_video: ep.url_video || ep.link || null,
            slug_media: ep.slug_media || t.slug_media || null,
            reproductores: [],
            embeds: [],
            reproductor: null
          };
        }
        mergeEp(seasonMap[en], ep, fName);
      }
    }

    if ((!temps || !temps.length) && Array.isArray(rr.episodios)) {
      var seasonMap1 = ensureSeason(1);
      for (var e2 = 0; e2 < rr.episodios.length; e2++) {
        var ep2 = rr.episodios[e2];
        var en2 = parseInt(ep2.episodio || (e2 + 1), 10) || (e2 + 1);
        if (!seasonMap1[en2]) {
          seasonMap1[en2] = {
            temporada: 1,
            episodio: en2,
            titulo: ep2.titulo || ('Episodio ' + en2),
            overview: ep2.overview || '',
            still: ep2.still || null,
            link: ep2.link || null,
            url_video: ep2.url_video || null,
            reproductores: [],
            embeds: [],
            reproductor: null
          };
        }
        mergeEp(seasonMap1[en2], ep2, fName);
      }
    }
  }

  var seasonNums = Object.keys(bySeason).map(Number).filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
  var temporadasOut = [];
  var totalEps = 0;
  for (var six = 0; six < seasonNums.length; six++) {
    var sn2 = seasonNums[six];
    var sm = bySeason[sn2];
    var epNums = Object.keys(sm).filter(function (k) { return k.charAt(0) !== '_'; }).map(Number).sort(function (a, b) { return a - b; });
    var epsOut = [];
    for (var ej = 0; ej < epNums.length; ej++) {
      epsOut.push(sm[epNums[ej]]);
      totalEps++;
    }
    var tObj = {
      temporada: sn2,
      total_episodios: epsOut.length,
      episodios: epsOut
    };
    if (sm._slug_media) tObj.slug_media = sm._slug_media;
    if (sm._titulo) tObj.titulo = sm._titulo;
    temporadasOut.push(tObj);
  }

  base.temporadas = temporadasOut;
  base.total_temporadas = Math.max(temporadasOut.length, parseInt(base.total_temporadas, 10) || 0);
  // total = max(listados fusionados, totales declarados por cualquier fuente)
  // Evita bajar de 1175 a 1125 o de 24 a 10
  base.total_episodios = Math.max(
    totalEps,
    parseInt(base.total_episodios, 10) || 0,
    maxTotalDeclarado
  );
  if (bestRangos && bestRangos.length) base.rangos_episodios = bestRangos;
  // Fuentes ordenadas por prioridad; animeav1 siempre primero si está
  if (typeof ordenarFuentesLista === 'function') {
    base.fuentes = ordenarFuentesLista(fuentesUsadas);
  } else {
    base.fuentes = fuentesUsadas;
  }
  var fuentePref = base.fuentes[0] || base.fuente;
  if (base.fuentes.indexOf('animeav1') !== -1) {
    fuentePref = 'animeav1';
  }
  base.fuente = fuentePref;
  base.source_id = sourceIdFromName(fuentePref || '');
  if (tipoRuta === 'anime') base.tipo = 'Anime';
  else if (base.tipo !== 'Anime') base.tipo = base.tipo || 'Serie';
  base.nota_fusion = 'Unido de: ' + base.fuentes.join(', ') +
    ' | Temporadas: ' + base.total_temporadas + ' | Episodios: ' + base.total_episodios +
    ' | Players: prioridad animeav1, sin duplicar misma URL entre fuentes';
  delete base._fuente_scrape;
  delete base._slug_scrape;
  delete base.episodios;
  return base;
}

function countEpsInResult(r) {
  if (!r) return 0;
  if (r.total_episodios) return parseInt(r.total_episodios, 10) || 0;
  var n = 0;
  var temps = r.temporadas || [];
  for (var i = 0; i < temps.length; i++) {
    var eps = temps[i].episodios || temps[i].capitulos || [];
    n += eps.length;
  }
  return n;
}


/** Links de episodios con ID de fuente: /{id}/serie/slug/T/E */
function reescribirLinksCortos(resultado, origin, slugHint, tipoHint, fuenteHint) {
  if (!resultado || !origin) return resultado;

  var slug = slugHint || '';
  if (!slug && resultado.link) {
    var m = String(resultado.link).match(/\/(?:series|serie|animes|anime|peliculas|pelicula)\/([^\/\?]+)/i);
    if (m) slug = m[1];
  }

  var tipoPath = tipoHint || 'serie';
  if (resultado.tipo === 'Anime' || /\/animes?\//i.test(resultado.link || '')) tipoPath = 'anime';
  if (resultado.tipo === 'Pelicula') tipoPath = 'pelicula';

  var fuente = fuenteHint || resultado.fuente || 'lamovie';
  var sid = sourceIdFromName(fuente);
  resultado.source_id = sid;

  if (resultado.temporadas && Array.isArray(resultado.temporadas)) {
    for (var t = 0; t < resultado.temporadas.length; t++) {
      var eps = resultado.temporadas[t].episodios || [];
      for (var e = 0; e < eps.length; e++) {
        var ep = eps[e];
        var s = ep.temporada || resultado.temporadas[t].temporada || 1;
        var n = ep.episodio || (e + 1);
        if (slug) {
          var uv = origin + '/' + sid + '/' + tipoPath + '/' + slug + '/' + s + '/' + n;
          ep.url_video = uv;
          ep.link = uv;
          ep.source_id = sid;
          delete ep.url;
          delete ep.source_link;
        }
      }
    }
  }

  if (resultado.tipo === 'Capitulo' && slug && resultado.temporada && resultado.episodio) {
    resultado.url_video = origin + '/' + sid + '/' + tipoPath + '/' + slug + '/' + resultado.temporada + '/' + resultado.episodio;
    delete resultado.url;
  }

  if (resultado.titulo) resultado.titulo = limpiarTitulo(resultado.titulo);

  return resultado;
}

function normalizarUrlEntrada(u) {
  u = String(u || '').trim();
  if (/^https?:\/\/\/+(series|animes|peliculas)\//i.test(u)) {
    u = u.replace(/^https?:\/\/\/+/i, LAMOVIE_BASE + '/');
  }
  if (/^\/(series|animes|peliculas)\//i.test(u)) {
    u = LAMOVIE_BASE + u;
  }
  return u;
}

function detectarFuente(u) {
  u = (u || '').toLowerCase();
  if (u.indexOf('animeav1') !== -1) return 'animeav1';
  if (u.indexOf('doramasflix') !== -1) return 'doramasflix';
  if (u.indexOf('pelisplushd') !== -1) return 'pelisplushd';
  if (u.indexOf('hackstore') !== -1) return 'hackstore';
  if (u.indexOf('lamovie') !== -1) return 'lamovie';
  if (/\/(pelicula|serie|anime)\//i.test(u)) return 'pelisplushd';
  if (/\/media\//i.test(u)) return 'animeav1';
  if (/\/doramas\//i.test(u) || /\/capitulos\//i.test(u)) return 'doramasflix';
  return 'lamovie';
}


// ======================================================
// ======================================================
// RESOLVERS HLS (Vimeos + Streamwish + Vidhide + VOE + Goodstream) + PROXY
// Mejorado: timeouts, respuesta uniforme, todas las calidades, proxy robusto, cache
// ======================================================

var STREAMWISH_MIRRORS = [
  'streamwish.to', 'flaswish.com', 'strwish.com', 'streamwish.top',
  'ahvsh.com', 'streamwish.site', 'streamhg.com'
];

var VIDHIDE_MIRRORS = [
  'vidhidepro.com', 'vidhide.com', 'vidhidepre.com', 'earnvids.com',
  'callistanise.com', 'smoothpre.com', 'filelions.com'
];

var VOE_MIRRORS = [
  'voe.sx', 'jilliandescribecompany.com', 'voe-unblock.com',
  'donaldlineelse.com', 'kathleenmemberhistory.com'
];

// Cache simple en memoria (por invocación del Worker)
var __RESOLVE_CACHE__ = Object.create(null);
var CACHE_TTL_MS = 45000; // 45 segundos

function cacheGet(key) {
  var e = __RESOLVE_CACHE__[key];
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    delete __RESOLVE_CACHE__[key];
    return null;
  }
  return e.data;
}
function cacheSet(key, data) {
  __RESOLVE_CACHE__[key] = { ts: Date.now(), data: data };
}

/** Fetch con timeout (ms) */
async function fetchWithTimeout(url, opts, timeoutMs) {
  timeoutMs = timeoutMs || 12000;
  var ctrl = new AbortController();
  var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
  try {
    var res = await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, headers, timeoutMs) {
  var res = await fetchWithTimeout(url, { headers: headers || HEADERS, redirect: 'follow' }, timeoutMs || 12000);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' en ' + url);
  return await res.text();
}

function toBaseN(n, base) {
  if (n === 0) return '0';
  var digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  var s = '';
  while (n > 0) {
    s = digits[n % base] + s;
    n = Math.floor(n / base);
  }
  return s || '0';
}

/** Desofusca packer tipo Dean Edwards */
function unpackPacker(html) {
  var start = html.indexOf('eval(function(p,a,c,k,e,d)');
  if (start < 0) throw new Error('Packer no encontrado');
  var end = html.indexOf('</script>', start);
  var packer = end > start ? html.slice(start, end) : html.slice(start);
  var idx = packer.lastIndexOf('}(');
  if (idx < 0) throw new Error('No se encontraron argumentos del Packer');
  var args = packer.slice(idx + 2);

  var m = args.match(/^'(.*)',\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*)'\.split\('\|'\)/s);
  if (!m) m = args.match(/^"(.*)",\s*(\d+)\s*,\s*(\d+)\s*,\s*"(.*)"\.split\("\|"\)/s);
  if (!m) m = args.match(/^'(.*)',\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*)'\.split\("\|"\)/s);
  if (!m) {
    m = args.match(/(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\(['"]\|['"]\)/);
    if (m) return unpackWithWords(m[2], parseInt(m[3], 10), m[6].split('|'));
    throw new Error('No se encontró la estructura interna del Packer');
  }
  var code = m[1];
  var radix = parseInt(m[2], 10);
  var count = parseInt(m[3], 10);
  var words = m[4].split('|');
  var p = code;
  for (var i = count - 1; i >= 0; i--) {
    if (i < words.length && words[i]) {
      var token = toBaseN(i, radix);
      p = p.replace(new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), words[i]);
    }
  }
  return p;
}

function unpackWithWords(code, radix, words) {
  return code.replace(/\b[0-9a-z]+\b/g, function (token) {
    try {
      var n = parseInt(token, radix || 36);
      if (!isNaN(n) && n < words.length && words[n]) return words[n];
    } catch (e) {}
    return token;
  });
}

function findStreamUrlsInDecoded(decoded) {
  var urls = [];
  var re1 = /"(hls\d+|file|src)"\s*:\s*"(https?:\/\/[^"]+)"/gi;
  var mm;
  while ((mm = re1.exec(decoded))) urls.push(mm[2]);
  var re2 = /file\s*:\s*["'](https?:\/\/[^"']+)["']/gi;
  while ((mm = re2.exec(decoded))) urls.push(mm[1]);
  var re3 = /https?:\/\/[^"'\s<>\\]+(?:\.m3u8|master\.txt)(?:\?[^"'\s<>\\]*)?/gi;
  while ((mm = re3.exec(decoded))) urls.push(mm[0]);
  var out = [];
  for (var i = 0; i < urls.length; i++) {
    var u = String(urls[i]).replace(/\\\//g, '/').trim().replace(/\\+$/g, '');
    if (u.indexOf('http') === 0 && out.indexOf(u) === -1) out.push(u);
  }
  return out;
}

function pickMasterUrl(urls) {
  for (var i = 0; i < urls.length; i++) {
    if (urls[i].indexOf('master.m3u8') !== -1 || urls[i].indexOf('.m3u8') !== -1) return urls[i];
  }
  for (var j = 0; j < urls.length; j++) {
    if (urls[j].indexOf('master.txt') !== -1 || /\.txt(\?|$)/.test(urls[j])) return urls[j];
  }
  return urls[0];
}

function parseHlsVariants(playlist, masterUrl) {
  var lines = playlist.split(/\r?\n/);
  var variants = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF:') === -1) continue;
    if (i + 1 >= lines.length) continue;
    var stream = lines[i + 1].trim();
    if (!stream || stream.charAt(0) === '#') continue;
    if (stream.indexOf('http') !== 0) {
      try { stream = new URL(stream, masterUrl).toString(); } catch (e) { continue; }
    }
    var resolution = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
    var bandwidth = lines[i].match(/BANDWIDTH=(\d+)/);
    variants.push({
      width: resolution ? parseInt(resolution[1], 10) : 0,
      height: resolution ? parseInt(resolution[2], 10) : 0,
      bandwidth: bandwidth ? parseInt(bandwidth[1], 10) : 0,
      url: stream
    });
  }
  return variants;
}

function selectVariant(variants, preferHeight) {
  preferHeight = preferHeight || 720;
  if (!variants || !variants.length) return null;
  var sel = null;
  for (var i = 0; i < variants.length; i++) {
    if (variants[i].height === preferHeight) { sel = variants[i]; break; }
  }
  if (!sel) {
    sel = variants.slice().sort(function (a, b) {
      return (b.height - a.height) || (b.bandwidth - a.bandwidth);
    })[0];
  }
  return sel;
}

/** Proxy URL helper */
function proxyUrlFor(origin, target, ref) {
  var u = origin + '/proxy?url=' + encodeURIComponent(target);
  if (ref) u += '&ref=' + encodeURIComponent(ref);
  return u;
}

/** Reescribe playlist m3u8 de forma robusta (master + variantes + segmentos + URI=) */
function rewriteM3u8(body, baseUrl, proxyBase) {
  var lines = body.split(/\r?\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trim = line.trim();
    if (!trim) { out.push(line); continue; }

    if (trim.charAt(0) === '#') {
      // Reescribir URI="..." en EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, etc.
      out.push(line.replace(/URI="([^"]+)"/gi, function (_, uri) {
        try {
          var abs = new URL(uri, baseUrl).toString();
          return 'URI="' + proxyBase + encodeURIComponent(abs) + '"';
        } catch (e) {
          return 'URI="' + uri + '"';
        }
      }));
      continue;
    }

    // Línea de URL (segmento o variante)
    try {
      var abs2 = new URL(trim, baseUrl).toString();
      out.push(proxyBase + encodeURIComponent(abs2));
    } catch (e2) {
      out.push(line);
    }
  }
  return out.join('\n');
}

async function handleProxy(request, targetUrl) {
  var headers = {
    'User-Agent': HEADERS['User-Agent'],
    'Accept': '*/*'
  };
  try {
    var reqUrl = new URL(request.url);
    var refParam = reqUrl.searchParams.get('ref') || '';
    var host = new URL(targetUrl).hostname || '';
    if (refParam) {
      headers['Referer'] = refParam;
      try { headers['Origin'] = new URL(refParam).origin; } catch (eR) {}
    } else if (host.indexOf('vimeos') !== -1) {
      headers['Referer'] = 'https://vimeos.net/';
    } else if (host) {
      headers['Referer'] = 'https://' + host + '/';
      headers['Origin'] = 'https://' + host;
    }
  } catch (e) {}

  var upstream = await fetchWithTimeout(targetUrl, { headers: headers, redirect: 'follow' }, 15000);
  var ct = (upstream.headers.get('content-type') || '').toLowerCase();
  var buf = await upstream.arrayBuffer();
  var isM3u8 = ct.indexOf('mpegurl') !== -1 || ct.indexOf('m3u8') !== -1 ||
    /\.m3u8(\?|$)/i.test(targetUrl) || /\.txt(\?|$)/i.test(targetUrl);

  var origin = new URL(request.url).origin;
  var proxyBase = origin + '/proxy?url=';
  try {
    var refKeep = new URL(request.url).searchParams.get('ref');
    if (refKeep) proxyBase = origin + '/proxy?ref=' + encodeURIComponent(refKeep) + '&url=';
  } catch (eRef) {}

  if (isM3u8) {
    var text = new TextDecoder().decode(buf);
    if (text.indexOf('#EXT') !== -1) {
      text = rewriteM3u8(text, targetUrl, proxyBase);
      return new Response(text, {
        status: 200,
        headers: Object.assign({}, corsHeaders(), {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache'
        })
      });
    }
  }

  var h = Object.assign({}, corsHeaders(), {
    'Content-Type': ct || 'application/octet-stream',
    'Cache-Control': 'public, max-age=60'
  });
  return new Response(buf, { status: upstream.status, headers: h });
}

/** HEAD/GET ligero para estado HLS (evita descargar cuerpos enormes) */
async function checkHlsStatus(streamUrl, referer) {
  var headers = {
    'User-Agent': HEADERS['User-Agent'],
    'Accept': '*/*'
  };
  if (referer) {
    headers['Referer'] = referer;
    try { headers['Origin'] = new URL(referer).origin; } catch (e) {}
  }
  try {
    // Primero HEAD
    var res = await fetchWithTimeout(streamUrl, { method: 'HEAD', headers: headers, redirect: 'follow' }, 8000);
    var status = res.status;
    if (status === 403) return { url: streamUrl, status: 'bloqueado 403' };
    if (status >= 400) return { url: streamUrl, status: 'error ' + status };

    // Si parece playlist, hacemos GET corto
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    var isPlaylist = ct.indexOf('mpegurl') !== -1 || ct.indexOf('m3u8') !== -1 ||
      /\.m3u8(\?|$)/i.test(streamUrl) || /\.txt(\?|$)/i.test(streamUrl);

    if (isPlaylist || status === 200) {
      var getRes = await fetchWithTimeout(streamUrl, {
        method: 'GET',
        headers: Object.assign({}, headers, { 'Range': 'bytes=0-4095' }),
        redirect: 'follow'
      }, 10000);
      var body = '';
      try { body = await getRes.text(); } catch (e2) {}
      if (body && body.indexOf('#EXT') !== -1) {
        return { url: streamUrl, status: 'activo', body: body };
      }
      if (getRes.status >= 200 && getRes.status < 300) {
        return { url: streamUrl, status: 'activo', body: body };
      }
    }
    return { url: streamUrl, status: 'activo' };
  } catch (e) {
    return { url: streamUrl, status: 'error: ' + (e.message || e) };
  }
}

function extractIdGeneric(url, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var m = String(url).match(patterns[i]);
    if (m) return m[1];
  }
  return String(url).replace(/\/$/, '').split('/').pop().split('?')[0].replace(/^embed-/, '').replace(/\.html$/, '');
}

async function fetchEmbedHtmlCandidates(url, hosts, pathTemplates, refererBase) {
  var id = extractIdGeneric(url, [
    /\/(?:e|v|f)\/([a-zA-Z0-9]+)/,
    /embed-([a-zA-Z0-9]+)/,
    /\/([a-zA-Z0-9]{10,})(?:\.html)?(?:\?|$)/
  ]);
  var candidates = [url];
  for (var h = 0; h < hosts.length; h++) {
    for (var t = 0; t < pathTemplates.length; t++) {
      var u = 'https://' + hosts[h] + pathTemplates[t].replace('{id}', id);
      if (candidates.indexOf(u) === -1) candidates.push(u);
    }
  }
  var lastErr = null;
  for (var i = 0; i < candidates.length; i++) {
    var u2 = candidates[i];
    var host = 'localhost';
    try { host = new URL(u2).hostname; } catch (e) {}
    var headers = {
      'User-Agent': HEADERS['User-Agent'],
      'Accept': HEADERS['Accept'],
      'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      'Referer': refererBase || ('https://' + host + '/'),
      'Origin': 'https://' + host
    };
    try {
      var res = await fetchWithTimeout(u2, { headers: headers, redirect: 'follow' }, 12000);
      var html = await res.text();
      if (res.ok && html.length > 500 && (
        html.indexOf('eval(function(p,a,c,k,e,d)') !== -1 ||
        html.indexOf('jwplayer') !== -1 ||
        html.indexOf('sources') !== -1 ||
        /\.m3u8/.test(html)
      )) {
        return { html: html, used: u2, host: host };
      }
      lastErr = 'HTTP ' + res.status + ' ' + u2 + ' len=' + html.length;
    } catch (e2) {
      lastErr = u2 + ': ' + (e2.message || e2);
    }
  }
  throw new Error(lastErr || 'No se pudo descargar el embed');
}

function extractLinksFromDecoded(decoded) {
  var urls = findStreamUrlsInDecoded(decoded);
  var reHls = /"(hls\d*|file|src)"\s*:\s*"(https?:\/\/[^"]+)"/gi;
  var mm;
  while ((mm = reHls.exec(decoded))) {
    if (urls.indexOf(mm[2]) === -1) urls.push(mm[2]);
  }
  var reM = /https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/gi;
  while ((mm = reM.exec(decoded))) {
    var u = mm[0].replace(/\\+$/g, '');
    if (urls.indexOf(u) === -1) urls.push(u);
  }
  return urls;
}

function extractDirectFromHtml(html) {
  var urls = [];
  var re = /https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/gi;
  var m;
  while ((m = re.exec(html))) {
    var u = m[0].replace(/\\\//g, '/');
    if (urls.indexOf(u) === -1) urls.push(u);
  }
  var re2 = /file\s*:\s*["'](https?:\/\/[^"']+)["']/gi;
  while ((m = re2.exec(html))) {
    if (urls.indexOf(m[1]) === -1) urls.push(m[1]);
  }
  return urls;
}

/** Resolver Vimeos → respuesta uniforme */
async function resolveVimeosEmbed(embedUrl, origin) {
  var cacheKey = 'vimeos:' + embedUrl;
  var cached = cacheGet(cacheKey);
  if (cached) {
    // Reconstruir proxy_url con el origin actual
    if (origin && cached.url && !cached.proxy_url) {
      cached = Object.assign({}, cached);
      cached.proxy_url = origin + '/proxy?url=' + encodeURIComponent(cached.url);
      if (cached.master) cached.proxy_master = origin + '/proxy?url=' + encodeURIComponent(cached.master);
    }
    return cached;
  }

  var headers = {
    'User-Agent': HEADERS['User-Agent'],
    'Referer': 'https://vimeos.net/',
    'Accept': HEADERS['Accept']
  };
  var html = await fetchText(embedUrl, headers, 12000);
  var decoded = unpackPacker(html);
  var urls = findStreamUrlsInDecoded(decoded);
  if (!urls.length) {
    var m3 = decoded.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/gi) || [];
    urls = m3.filter(function (u, i, a) { return a.indexOf(u) === i; });
  }
  if (!urls.length) throw new Error('No se encontró ninguna fuente HLS (vimeos)');

  var master = pickMasterUrl(urls);
  var playlist = '';
  var variants = [];
  try {
    playlist = await fetchText(master, headers, 10000);
    if (playlist.indexOf('#EXTM3U') !== -1) variants = parseHlsVariants(playlist, master);
  } catch (e) {}

  var selected = selectVariant(variants, 720);
  var finalUrl = selected ? selected.url : master;
  var quality = selected && selected.height ? selected.height + 'p' : null;
  var resolution = selected && selected.height ? (selected.width + 'x' + selected.height) : null;

  var out = {
    success: true,
    provider: 'vimeos',
    source: embedUrl,
    type: 'hls',
    quality: quality,
    resolution: resolution,
    url: finalUrl,
    master: master,
    all_sources: urls,
    variants: variants
  };
  if (origin) {
    out.proxy_url = origin + '/proxy?url=' + encodeURIComponent(finalUrl);
    out.proxy_master = origin + '/proxy?url=' + encodeURIComponent(master);
  }
  cacheSet(cacheKey, out);
  return out;
}

function extractStreamwishId(url) {
  var m = String(url).match(/\/(?:e|f)\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  return String(url).replace(/\/$/, '').split('/').pop().split('?')[0];
}

function streamwishCandidateUrls(original) {
  var vid = extractStreamwishId(original);
  var out = [original];
  for (var i = 0; i < STREAMWISH_MIRRORS.length; i++) {
    var h = STREAMWISH_MIRRORS[i];
    var a = 'https://' + h + '/e/' + vid;
    var b = 'https://' + h + '/' + vid;
    if (out.indexOf(a) === -1) out.push(a);
    if (out.indexOf(b) === -1) out.push(b);
  }
  return out;
}

async function fetchStreamwishHtml(url) {
  var candidates = streamwishCandidateUrls(url);
  var lastErr = null;
  for (var i = 0; i < candidates.length; i++) {
    var u = candidates[i];
    var host = 'streamwish.to';
    try { host = new URL(u).hostname || host; } catch (e) {}
    var headers = {
      'User-Agent': HEADERS['User-Agent'],
      'Accept': HEADERS['Accept'],
      'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      'Referer': 'https://' + host + '/',
      'Origin': 'https://' + host
    };
    try {
      var res = await fetchWithTimeout(u, { headers: headers, redirect: 'follow' }, 12000);
      var text = await res.text();
      if (res.ok && text.length > 800 && text.indexOf('eval(function(p,a,c,k,e,d)') !== -1) {
        return { html: text, used: u, host: host };
      }
      lastErr = 'HTTP ' + res.status + ' en ' + u + ' (len=' + text.length + ')';
    } catch (e) {
      lastErr = u + ': ' + (e.message || e);
    }
  }
  throw new Error(lastErr || 'No se pudo descargar el embed Streamwish');
}

async function resolveStreamwishEmbed(embedUrl, origin) {
  var cacheKey = 'sw:' + embedUrl;
  var cached = cacheGet(cacheKey);
  if (cached) {
    if (origin && cached.url && !cached.proxy_url) {
      cached = Object.assign({}, cached);
      cached.proxy_url = origin + '/proxy?url=' + encodeURIComponent(cached.url);
      if (cached.master) cached.proxy_master = origin + '/proxy?url=' + encodeURIComponent(cached.master);
    }
    return cached;
  }

  var got = await fetchStreamwishHtml(embedUrl);
  var decoded = unpackPacker(got.html);
  var urls = findStreamUrlsInDecoded(decoded);
  if (!urls.length) throw new Error('No se encontró ninguna fuente HLS en el packer (streamwish)');
  var master = pickMasterUrl(urls);
  var headers = {
    'User-Agent': HEADERS['User-Agent'],
    'Referer': 'https://' + got.host + '/',
    'Origin': 'https://' + got.host,
    'Accept': '*/*'
  };
  var variants = [];
  var finalUrl = master;
  var quality = null;
  var resolution = null;
  try {
    var playlist = await fetchText(master, headers, 10000);
    if (playlist.indexOf('#EXTM3U') !== -1) {
      variants = parseHlsVariants(playlist, master);
      var selected = selectVariant(variants, 720);
      if (selected) {
        finalUrl = selected.url;
        quality = selected.height ? selected.height + 'p' : null;
        resolution = selected.height ? (selected.width + 'x' + selected.height) : null;
      }
    }
  } catch (e) {}

  var out = {
    success: true,
    provider: 'streamwish',
    source: embedUrl,
    resolved_embed: got.used,
    type: 'hls',
    quality: quality,
    resolution: resolution,
    url: finalUrl,
    master: master,
    all_sources: urls,
    variants: variants
  };
  if (origin) {
    out.proxy_url = origin + '/proxy?url=' + encodeURIComponent(finalUrl);
    out.proxy_master = origin + '/proxy?url=' + encodeURIComponent(master);
  }
  cacheSet(cacheKey, out);
  return out;
}

async function resolveVidhideEmbed(embedUrl, origin) {
  var got = await fetchEmbedHtmlCandidates(
    embedUrl,
    VIDHIDE_MIRRORS,
    ['/v/{id}', '/f/{id}', '/e/{id}', '/embed-{id}.html'],
    'https://vidhidepro.com/'
  );
  var urls = [];
  try {
    var decoded = unpackPacker(got.html);
    urls = extractLinksFromDecoded(decoded);
  } catch (e) {
    urls = extractDirectFromHtml(got.html);
  }
  if (!urls.length) urls = extractDirectFromHtml(got.html);
  for (var i = 0; i < urls.length; i++) {
    if (urls[i].indexOf('http') !== 0) {
      try { urls[i] = new URL(urls[i], got.used).toString(); } catch (e2) {}
    }
  }
  urls = urls.filter(function (u) { return /\.m3u8|master\.txt|\.mp4/i.test(u); });
  if (!urls.length) throw new Error('Vidhide: no se encontró HLS');
  var master = pickMasterUrl(urls);
  var out = {
    success: true,
    provider: 'vidhide',
    source: embedUrl,
    resolved_embed: got.used,
    type: 'hls',
    url: master,
    master: master,
    all_sources: urls
  };
  if (origin) {
    out.proxy_url = origin + '/proxy?url=' + encodeURIComponent(master) + '&ref=' + encodeURIComponent(got.used);
  }
  return out;
}

async function resolveGoodstreamEmbed(embedUrl, origin) {
  var headers = {
    'User-Agent': HEADERS['User-Agent'],
    'Referer': 'https://goodstream.one/',
    'Accept': HEADERS['Accept']
  };
  var id = extractIdGeneric(embedUrl, [/embed-([a-zA-Z0-9]+)/, /\/([a-zA-Z0-9]{8,})(?:\.html)?(?:\?|$)/]);
  var candidates = [embedUrl];
  if (id) {
    candidates.push('https://goodstream.one/embed-' + id + '.html');
    candidates.push('https://goodstream.one/' + id);
  }
  var html = null, used = embedUrl;
  var lastErr = null;
  for (var i = 0; i < candidates.length; i++) {
    try {
      var res = await fetchWithTimeout(candidates[i], { headers: headers, redirect: 'follow' }, 12000);
      var t = await res.text();
      if (res.ok && t.length > 400) {
        html = t; used = candidates[i];
        if (/\.m3u8|sources|jwplayer/.test(t)) break;
      }
      lastErr = 'HTTP ' + res.status;
    } catch (e) { lastErr = e.message || e; }
  }
  if (!html) throw new Error('Goodstream: ' + (lastErr || 'sin HTML'));
  var urls = extractDirectFromHtml(html);
  try {
    if (html.indexOf('eval(function(p,a,c,k,e,d)') !== -1) {
      var decoded = unpackPacker(html);
      var more = extractLinksFromDecoded(decoded);
      for (var j = 0; j < more.length; j++) if (urls.indexOf(more[j]) === -1) urls.push(more[j]);
    }
  } catch (e2) {}
  urls = urls.filter(function (u) { return /\.m3u8|\.mp4/i.test(u); });
  if (!urls.length) throw new Error('Goodstream: no se encontró stream');
  var master = pickMasterUrl(urls);
  var out = {
    success: true,
    provider: 'goodstream',
    source: embedUrl,
    resolved_embed: used,
    type: 'hls',
    url: master,
    master: master,
    all_sources: urls
  };
  if (origin) {
    out.proxy_url = origin + '/proxy?url=' + encodeURIComponent(master) + '&ref=' + encodeURIComponent(used);
  }
  return out;
}

async function resolveVoeEmbed(embedUrl, origin) {
  var got;
  try {
    got = await fetchEmbedHtmlCandidates(
      embedUrl,
      VOE_MIRRORS,
      ['/e/{id}', '/{id}'],
      'https://voe.sx/'
    );
  } catch (e) {
    throw new Error('Voe: bloqueado o no accesible desde el worker (' + (e.message || e) + '). Prueba otro mirror o más tarde.');
  }
  var urls = extractDirectFromHtml(got.html);
  try {
    if (got.html.indexOf('eval(function(p,a,c,k,e,d)') !== -1) {
      var decoded = unpackPacker(got.html);
      var more = extractLinksFromDecoded(decoded);
      for (var i = 0; i < more.length; i++) if (urls.indexOf(more[i]) === -1) urls.push(more[i]);
    }
  } catch (e2) {}
  var b64 = got.html.match(/var\s+sources\s*=\s*JSON\.parse\(atob\(["']([A-Za-z0-9+/=]+)["']\)\)/);
  if (b64) {
    try {
      var jsonStr = atob(b64[1]);
      var obj = JSON.parse(jsonStr);
      var walk = function (o) {
        if (!o) return;
        if (typeof o === 'string' && /^https?:/.test(o)) {
          if (urls.indexOf(o) === -1) urls.push(o);
        } else if (Array.isArray(o)) o.forEach(walk);
        else if (typeof o === 'object') Object.keys(o).forEach(function (k) { walk(o[k]); });
      };
      walk(obj);
    } catch (e3) {}
  }
  urls = urls.filter(function (u) { return /\.m3u8|\.mp4|hls/i.test(u); });
  if (!urls.length) throw new Error('Voe: HTML obtenido pero sin fuentes HLS (posible challenge JS)');
  var master = pickMasterUrl(urls);
  var out = {
    success: true,
    provider: 'voe',
    source: embedUrl,
    resolved_embed: got.used,
    type: 'hls',
    url: master,
    master: master,
    all_sources: urls
  };
  if (origin) {
    out.proxy_url = origin + '/proxy?url=' + encodeURIComponent(master) + '&ref=' + encodeURIComponent(got.used);
  }
  return out;
}

function detectarProviderEmbed(u) {
  u = String(u || '').toLowerCase();
  if (u.indexOf('vimeos') !== -1) return 'vimeos';
  if (u.indexOf('streamwish') !== -1 || u.indexOf('flaswish') !== -1 ||
      u.indexOf('strwish') !== -1 || u.indexOf('ahvsh') !== -1 ||
      u.indexOf('streamhg') !== -1) return 'streamwish';
  return '';
}

function detectarProviderEmbedFull(u) {
  u = String(u || '').toLowerCase();
  if (u.indexOf('vimeos') !== -1) return 'vimeos';
  if (u.indexOf('streamwish') !== -1 || u.indexOf('flaswish') !== -1 ||
      u.indexOf('strwish') !== -1 || u.indexOf('ahvsh') !== -1 || u.indexOf('streamhg') !== -1) return 'streamwish';
  if (u.indexOf('vidhide') !== -1 || u.indexOf('earnvids') !== -1 ||
      u.indexOf('callistanise') !== -1 || u.indexOf('smoothpre') !== -1 || u.indexOf('filelions') !== -1) return 'vidhide';
  if (u.indexOf('voe') !== -1 || u.indexOf('jilliandescribe') !== -1) return 'voe';
  if (u.indexOf('goodstream') !== -1) return 'goodstream';
  return '';
}

async function resolveByProvider(embedUrl, provider, origin) {
  provider = provider || detectarProviderEmbedFull(embedUrl);
  if (provider === 'streamwish') return resolveStreamwishEmbed(embedUrl, origin);
  if (provider === 'vidhide') return resolveVidhideEmbed(embedUrl, origin);
  if (provider === 'goodstream') return resolveGoodstreamEmbed(embedUrl, origin);
  if (provider === 'voe') return resolveVoeEmbed(embedUrl, origin);
  if (provider === 'vimeos') return resolveVimeosEmbed(embedUrl, origin);
  throw new Error('Provider no soportado: ' + (provider || 'desconocido'));
}

/** Respuesta rica unificada para /streamurl y /wish/streamurl etc. */
async function buildProviderRichResponse(embedUrl, origin, forceProvider) {
  var provider = forceProvider || detectarProviderEmbedFull(embedUrl) || 'streamwish';
  var base;
  try {
    base = await resolveByProvider(embedUrl, provider, null);
  } catch (err) {
    return {
      success: false,
      provider: provider,
      source: embedUrl,
      error: err.message || 'Error resolviendo'
    };
  }

  var referer = base.resolved_embed || embedUrl;
  var hlsList = (base.all_sources || []).slice();
  if (base.master && hlsList.indexOf(base.master) === -1) hlsList.unshift(base.master);
  if (base.url && hlsList.indexOf(base.url) === -1) hlsList.unshift(base.url);

  hlsList.sort(function (a, b) {
    var sa = /\.txt(\?|$)/.test(String(a)) || String(a).indexOf('master.txt') !== -1 ? 0 : 1;
    var sb = /\.txt(\?|$)/.test(String(b)) || String(b).indexOf('master.txt') !== -1 ? 0 : 1;
    return sa - sb;
  });

  var hlsStatus = [];
  var activePlaylist = null;
  var activeMaster = null;
  for (var j = 0; j < Math.min(hlsList.length, 6); j++) {
    var st = await checkHlsStatus(hlsList[j], referer);
    hlsStatus.push({ url: st.url, status: st.status });
    if (!activePlaylist && st.status === 'activo' && st.body && st.body.indexOf('#EXT') !== -1) {
      activePlaylist = st.body;
      activeMaster = st.url;
    }
  }

  var qualities = [];
  if (activePlaylist && activeMaster) {
    var variants = parseHlsVariants(activePlaylist, activeMaster);
    if (!variants.length) {
      qualities.push({
        quality: 'auto',
        resolution: null,
        bandwidth: null,
        url: activeMaster,
        proxy_url: proxyUrlFor(origin, activeMaster, referer)
      });
    } else {
      variants.sort(function (a, b) { return (a.height || 0) - (b.height || 0); });
      for (var k = 0; k < variants.length; k++) {
        var v = variants[k];
        qualities.push({
          quality: v.height ? (v.height + 'p (' + v.width + 'x' + v.height + ')') : 'auto',
          resolution: v.height ? (v.width + 'x' + v.height) : null,
          bandwidth: v.bandwidth || null,
          url: v.url,
          proxy_url: proxyUrlFor(origin, v.url, referer)
        });
      }
    }
  }

  var best = qualities.length ? qualities[qualities.length - 1] : null;
  for (var q = 0; q < qualities.length; q++) {
    if (String(qualities[q].quality).indexOf('720') !== -1) { best = qualities[q]; break; }
  }

  return {
    success: true,
    provider: base.provider || provider,
    source: embedUrl,
    resolved_embed: referer,
    type: 'hls',
    videos: { hls: hlsList, hls_status: hlsStatus },
    qualities: qualities,
    play_url: best ? best.proxy_url : (activeMaster ? proxyUrlFor(origin, activeMaster, referer) : null),
    play_direct: best ? best.url : activeMaster,
    proxy_url: best ? best.proxy_url : (activeMaster ? proxyUrlFor(origin, activeMaster, referer) : null),
    url: best ? best.url : activeMaster,
    master: activeMaster || base.master
  };
}

async function buildStreamwishRichResponse(embedUrl, origin) {
  return buildProviderRichResponse(embedUrl, origin, 'streamwish');
}

function attachStreamUrl(origin, rep) {
  if (!rep || !rep.url) return rep;
  var s = String(rep.servidor || '').toLowerCase();
  var u = String(rep.url);
  // Ya es HLS directo
  if (/\.m3u8(\?|$)/i.test(u) || /master\.txt(\?|$)/i.test(u)) {
    rep.hls = u;
    rep.tipo = rep.tipo || 'hls';
    rep.stream_url = origin + '/proxy?url=' + encodeURIComponent(u);
    return rep;
  }
  var prov = null;
  try { prov = detectarProviderEmbedFull(u); } catch (e) {}
  if (!prov) {
    try { prov = detectarProviderEmbed(u); } catch (e2) {}
  }
  if (prov === 'streamwish' || s.indexOf('streamwish') !== -1) {
    rep.stream_url = origin + '/wish/streamurl?url=' + encodeURIComponent(u);
    rep.hls_resolve = rep.stream_url;
  } else if (prov === 'vidhide' || s.indexOf('vidhide') !== -1) {
    rep.stream_url = origin + '/vidhide/streamurl?url=' + encodeURIComponent(u);
    rep.hls_resolve = rep.stream_url;
  } else if (prov === 'voe' || s.indexOf('voe') !== -1) {
    rep.stream_url = origin + '/voe/streamurl?url=' + encodeURIComponent(u);
    rep.hls_resolve = rep.stream_url;
  } else if (prov === 'goodstream' || s.indexOf('goodstream') !== -1) {
    rep.stream_url = origin + '/goodstream/streamurl?url=' + encodeURIComponent(u);
    rep.hls_resolve = rep.stream_url;
  } else if (prov === 'vimeos' || s.indexOf('vimeos') !== -1) {
    rep.stream_url = origin + '/resolve/vimeos?url=' + encodeURIComponent(u) + '&proxy=1';
    rep.hls_resolve = rep.stream_url;
  } else {
    // Genérico: intentar /resolve automático → m3u8
    rep.stream_url = origin + '/resolve?url=' + encodeURIComponent(u) + '&proxy=1';
    rep.hls_resolve = rep.stream_url;
  }
  return rep;
}

function attachStreamUrlList(origin, list) {
  if (!Array.isArray(list)) return list;
  for (var i = 0; i < list.length; i++) attachStreamUrl(origin, list[i]);
  return list;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(data, status) {
  status = status || 200;
  try {
    if (data && typeof data === 'object' && __LAST_ORIGIN__) {
      if (Array.isArray(data.reproductores)) attachStreamUrlList(__LAST_ORIGIN__, data.reproductores);
      if (Array.isArray(data.embeds) && data.embeds[0] && data.embeds[0].url) {
        attachStreamUrlList(__LAST_ORIGIN__, data.embeds);
      }
      // episodios con reproductores
      if (Array.isArray(data.temporadas)) {
        for (var t = 0; t < data.temporadas.length; t++) {
          var caps = data.temporadas[t] && data.temporadas[t].capitulos;
          if (!Array.isArray(caps)) caps = data.temporadas[t] && data.temporadas[t].episodios;
          if (Array.isArray(caps)) {
            for (var c = 0; c < caps.length; c++) {
              if (caps[c] && Array.isArray(caps[c].reproductores)) {
                attachStreamUrlList(__LAST_ORIGIN__, caps[c].reproductores);
              }
            }
          }
        }
      }
      if (Array.isArray(data.episodios)) {
        for (var e = 0; e < data.episodios.length; e++) {
          if (data.episodios[e] && Array.isArray(data.episodios[e].reproductores)) {
            attachStreamUrlList(__LAST_ORIGIN__, data.episodios[e].reproductores);
          }
        }
      }
    }
  } catch (eAttach) {}
  var h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders());
  return new Response(JSON.stringify(data, null, 2), { status: status, headers: h });
}

function limpiarTexto(txt) {
  if (!txt) return '';
  var s = String(txt);
  // Corregir mojibake UTF-8 leído como Latin-1: "CÃ³digo" → "Código"
  // BUG previo: if (fixed && !/Ã.| /.test(fixed)) — el espacio hacía que
  // NUNCA se aplicara el fix a títulos con espacios ("CÃ³digo: Venganza").
  var badCount = function (t) {
    return (String(t).match(/Ã.|Â.|â.|ð.|\uFFFD/g) || []).length;
  };
  if (badCount(s) > 0) {
    try {
      for (var pass = 0; pass < 2; pass++) {
        if (badCount(s) === 0) break;
        var bytes = [];
        for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
        var fixed = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
        if (fixed && badCount(fixed) < badCount(s) && fixed.indexOf('\uFFFD') === -1) {
          s = fixed;
        } else {
          break;
        }
      }
    } catch (e) { /* keep s */ }
  }
  // Fallback manual si aún quedan secuencias típicas
  if (/Ã.|Â./.test(s)) {
    s = s
      .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í')
      .replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú').replace(/Ã±/g, 'ñ')
      .replace(/Ã/g, 'Á').replace(/Ã‰/g, 'É').replace(/Ã/g, 'Í')
      .replace(/Ã“/g, 'Ó').replace(/Ãš/g, 'Ú').replace(/Ã‘/g, 'Ñ')
      .replace(/Ã¼/g, 'ü').replace(/Ãœ/g, 'Ü')
      .replace(/Â¿/g, '¿').replace(/Â¡/g, '¡').replace(/Â/g, '');
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Quita basura de títulos: "Descargar serie", " - Hackstore.fo Oficial...", etc. */
function limpiarTitulo(txt) {
  if (!txt) return '';
  var t = limpiarTexto(String(txt));
  // Mojibake ya lo corrige limpiarTexto(); no mapear Ã suelto → Í (rompía textos)
  t = t.replace(/\s*[-|–—]\s*Hackstore\.fo Oficial.*$/i, '');
  t = t.replace(/\s*[-|–—]\s*Peliculas,?\s*Series y animes.*$/i, '');
  t = t.replace(/\s*[-|–—]\s*Pelisplus.*$/i, '');
  // Prefijos SEO: "VER Acaramelados Online Gratis HD"
  t = t.replace(/^(ver|watch)\s+/i, '');
  t = t.replace(/^(descargar|download)\s+(serie|pel[ií]cula|anime|movie)?\s*/i, '');
  t = t.replace(/^Ver\s+Serie:\s*/i, '');
  t = t.replace(/^Ver\s+Pel[ií]cula:\s*/i, '');
  t = t.replace(/^Serie\s+/i, '');
  t = t.replace(/^Pel[ií]cula\s+/i, '');
  t = t.replace(/\s*Online(\s+Gratis)?(\s+HD)?.*$/i, '');
  t = t.replace(/\s*Gratis(\s+HD)?\s*$/i, '');
  t = t.replace(/\s*Online Latino HD.*$/i, '');
  t = t.replace(/\s+HD\s*$/i, '');
  t = t.replace(/\s*:?\s*\d+x\d+(\s*[-–].*)?$/i, '');
  return limpiarTexto(t);
}

/**
 * Portadas Hackstore: wp-content/uploads/.../HASH.jpg suelen ser copias rotas de TMDB.
 * → https://image.tmdb.org/t/p/w500/HASH.jpg
 */
function normalizarPortadaUrl(url) {
  if (!url) return null;
  var u = String(url).trim();
  if (!u || u.indexOf('data:') === 0) return null;
  if (/image\.tmdb\.org/i.test(u)) {
    return u.replace(/\/w\d+\//, '/w500/');
  }
  var m = u.match(/\/(?:uploads\/\d{4}\/\d{2}\/|t\/p\/w\d+\/)([a-zA-Z0-9]{20,}\.(?:jpg|jpeg|png|webp))/i);
  if (m) {
    return 'https://image.tmdb.org/t/p/w500/' + m[1];
  }
  m = u.match(/\/([a-zA-Z0-9]{27,}\.(?:jpg|jpeg|png|webp))(?:\?|$)/i);
  if (m && /hackstore|wp-content/i.test(u)) {
    return 'https://image.tmdb.org/t/p/w500/' + m[1];
  }
  if (/media-amazon|amazon\.com/i.test(u)) return null;
  return u;
}

/** Portada Hackstore: preferir TMDB data-src del lazyload */
function extraerPortadaHackstore(html) {
  html = html || '';
  var m;
  m = html.match(/data-src=["'](https?:\/\/image\.tmdb\.org\/[^"']+)["']/i)
    || html.match(/data-lazy-src=["'](https?:\/\/image\.tmdb\.org\/[^"']+)["']/i)
    || html.match(/src=["'](https?:\/\/image\.tmdb\.org\/[^"']+)["']/i);
  if (m) return normalizarPortadaUrl(m[1]);
  m = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i);
  if (m) {
    var p = normalizarPortadaUrl(m[1]);
    if (p) return p;
  }
  m = html.match(/src=["'](https?:\/\/[^"']*hackstore[^"']*\/uploads\/[^"']+\.(?:jpg|png|webp))["']/i)
    || html.match(/src=["'](https?:\/\/[^"']*\/wp-content\/uploads\/[^"']+\.(?:jpg|png|webp))["']/i);
  if (m) return normalizarPortadaUrl(m[1]);
  return null;
}

/** Extrae titulo, descripcion completa, portada, géneros y año del HTML de la fuente */
function extraerMetas(html) {
  html = html || '';
  var titulo = '';
  var m;

  m = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i);
  if (m) titulo = m[1];
  if (!titulo) {
    m = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (m) titulo = m[1];
  }
  if (!titulo) {
    m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) titulo = m[1];
  }
  titulo = limpiarTitulo(titulo);

  // Año: título (2026), "Fecha de estreno: 2026", /year/2026
  var year = null;
  var ym = titulo.match(/\(((?:19|20)\d{2})\)/);
  if (ym) year = ym[1];
  if (!year) {
    ym = html.match(/Fecha\s+de\s+estreno\s*:?\s*<\/[^>]+>\s*((?:19|20)\d{2})/i)
      || html.match(/Fecha\s+de\s+estreno\s*:?\s*((?:19|20)\d{2})/i);
    if (ym) year = ym[1];
  }
  if (!year) {
    ym = html.match(/Ver\s+[^<(]+\(((?:19|20)\d{2})\)/i)
      || html.match(/<title[^>]*>[^<]*\(((?:19|20)\d{2})\)/i);
    if (ym) year = ym[1];
  }
  if (!year) {
    ym = html.match(/(?:Año|Year|Estreno|Released?)[:\s]*((?:19|20)\d{2})/i)
      || html.match(/href=["']\/year\/((?:19|20)\d{2})["']/i)
      || html.match(/itemprop=["']datePublished["'][^>]*content=["']((?:19|20)\d{2})/i);
    if (ym) year = ym[1];
  }
  if (!year) {
    ym = html.match(/class=["'][^"']*text-semibold[^"']*["'][^>]*>\s*((?:19|20)\d{2})\s*<\/span>\s*<small[^>]*>\s*Año/i)
      || html.match(/<span[^>]*class=["'][^"']*year[^"']*["'][^>]*>\s*((?:19|20)\d{2})/i);
    if (ym) year = ym[1];
  }

  // Rating de la página (ej. 8.7/10)
  var calificacionPagina = null;
  var rm = html.match(/ion-md-star[^>]*>\s*(\d+[.,]\d+)\s*\/\s*10/i)
    || html.match(/(\d+[.,]\d+)\s*\/\s*10\s*<\/span>\s*<small[^>]*>\s*Rating/i)
    || html.match(/(\d+[.,]\d+)\s*\/\s*10/i);
  if (rm) {
    calificacionPagina = normalizarCalificacion(String(rm[1]).replace(',', '.'));
  }

  // Sinopsis COMPLETA de la página (div.text-large tras "Sinopsis")
  var descripcion = '';
  m = html.match(/Sinopsis\s*:?\s*<\/(?:b|strong|span|p)[^>]*>\s*(?:<\/p>\s*)?<div[^>]*class=["'][^"']*text-large[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/Sinopsis[\s\S]{0,80}?class=["'][^"']*text-large[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/class=["'][^"']*text-large[^"']*["'][^>]*>\s*([\s\S]{40,}?)\s*<\/div>/i);
  if (m) {
    descripcion = limpiarTexto(m[1].replace(/<[^>]+>/g, ' '));
  }
  if (!descripcion || descripcion.length < 40) {
    m = html.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["']\s+property=["']og:description["']/i)
      || html.match(/name=["']description["']\s+content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["']\s+name=["']description["']/i);
    if (m) descripcion = limpiarTexto(m[1]);
  }
  descripcion = descripcion
    .replace(/^(Pel[ií]cula|Serie|Anime|Movie)\s*[^:]{0,80}:\s*/i, '')
    .replace(/\.\.\.\s*$/, '')
    .trim();
  descripcion = limpiarTexto(descripcion);
  // Mojibake típico (policÃ­as → policías)
  if (/Ã.|Â./.test(descripcion)) {
    descripcion = descripcion
      .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í')
      .replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú').replace(/Ã±/g, 'ñ')
      .replace(/Ã/g, 'Á').replace(/Ã‰/g, 'É').replace(/Ã/g, 'Í')
      .replace(/Ã“/g, 'Ó').replace(/Ãš/g, 'Ú').replace(/Ã‘/g, 'Ñ')
      .replace(/Â¿/g, '¿').replace(/Â¡/g, '¡');
  }

  // Portada: preferir poster del sitio o TMDB, NUNCA amazon media-amazon rotas
  var portada = '';
  m = html.match(/src=["'](https?:\/\/[^"']*\/poster\/[^"']+)["']/i)
    || html.match(/src=["'](\/?poster\/[^"']+)["']/i);
  if (m) {
    portada = m[1].indexOf('http') === 0 ? m[1] : PELISPLUS_BASE + (m[1].charAt(0) === '/' ? m[1] : '/' + m[1]);
  }
  if (!portada) {
    m = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i);
    if (m && !/media-amazon|amazon\.com/i.test(m[1])) portada = m[1];
  }
  if (!portada) {
    m = html.match(/data-src=["'](https?:\/\/image\.tmdb\.org\/[^"']+)["']/i)
      || html.match(/src=["'](https?:\/\/image\.tmdb\.org\/t\/p\/w(?:300|500|780)\/[^"']+)["']/i);
    if (m) portada = m[1];
  }
  if (portada) portada = normalizarPortadaUrl(portada) || portada;
  if (portada && /image\.tmdb\.org\/t\/p\/w300\//i.test(portada)) {
    portada = portada.replace('/w300/', '/w500/');
  }

  // Géneros: links /generos/ cerca de la ficha (tras Sinopsis / sectionDetail), no el menú lateral
  var generos = [];
  var genSeen = {};
  var zone = '';
  var zi = html.search(/Sinopsis/i);
  if (zi >= 0) zone = html.slice(zi, zi + 4000);
  else zone = html;
  var gre = /href=["']\/generos\/([^"'\/]+)["'][^>]*>([^<]+)</gi;
  var gm;
  while ((gm = gre.exec(zone)) !== null) {
    var gSlug = gm[1].toLowerCase();
    var gName = limpiarTexto(gm[2]);
    if (!gName || genSeen[gSlug]) continue;
    // filtrar entradas del menú genérico si aparecen
    if (gSlug === 'dorama' && generos.length === 0) continue;
    genSeen[gSlug] = true;
    generos.push(gName);
  }
  // fallback: keywords meta
  if (!generos.length) {
    m = html.match(/name=["']keywords["']\s+content=["']([^"']+)["']/i);
    // no suele traer géneros útiles
  }

  // Actores (opcional)
  var actores = [];
  var are = /href=["']\/actor\/[^"']+["'][^>]*>([^<]+)</gi;
  var am;
  var actorZone = zi >= 0 ? html.slice(zi, zi + 5000) : html;
  while ((am = are.exec(actorZone)) !== null && actores.length < 12) {
    var an = limpiarTexto(am[1]);
    if (an && actores.indexOf(an) === -1) actores.push(an);
  }

  return {
    titulo: titulo,
    descripcion: descripcion,
    portada: portada,
    year: year,
    calificacion: calificacionPagina,
    generos: generos,
    genero: generos.length ? generos.join(', ') : null,
    actores: actores
  };
}

/**
 * Para búsqueda: si PelisPlus no trajo año/sinopsis, leer la ficha (rápido)
 * ANTES de consultar IMDb, para no cruzar con otra película del mismo título.
 */
async function enriquecerDesdeFichaPelisplus(item) {
  if (!item || !item.slug) return item;
  var yaOk = item.year && item.descripcion && String(item.descripcion).length >= 40;
  if (yaOk) return item;
  var tipoPath = 'pelicula';
  if (item.tipo === 'Serie') tipoPath = 'serie';
  if (item.tipo === 'Anime') tipoPath = 'anime';
  var url = PELISPLUS_BASE + '/' + tipoPath + '/' + item.slug + '/';
  try {
    var res = await fetch(url, {
      headers: Object.assign({}, HEADERS, {
        Referer: PELISPLUS_BASE + '/',
        'Accept-Language': 'es-ES,es;q=0.9'
      })
    });
    if (!res.ok) return item;
    var html = await res.text();
    if (!html || html.length < 500) return item;
    var meta = extraerMetas(html);
    if (meta.year && !item.year) item.year = meta.year;
    if (meta.descripcion && (!item.descripcion || String(item.descripcion).length < 40)) {
      item.descripcion = meta.descripcion;
    }
    if (meta.calificacion != null && (item.calificacion == null || item.calificacion === '')) {
      item.calificacion = meta.calificacion;
    }
    if (meta.generos && meta.generos.length && (!item.generos || !item.generos.length)) {
      item.generos = meta.generos;
      item.genero = meta.genero;
    }
    if (meta.titulo && meta.titulo.length > 2) {
      // No pisar título si ya está limpio
      if (!item.titulo || item.titulo.length < 3) item.titulo = meta.titulo;
    }
  } catch (e) { /* ok */ }
  return item;
}

/** Extrae links de descarga (mega, mediafire, etc.) del HTML */
function extraerDescargas(html) {
  var out = [];
  var vistos = {};

  function add(u) {
    if (!u || vistos[u]) return;
    var low = String(u).toLowerCase();
    if (low.indexOf('favicon') !== -1 || low.indexOf('google.com/s2') !== -1) return;
    if (!esDescargaValida(u)) return;
    vistos[u] = true;
    out.push({
      url: u,
      servidor: extraerServidor(u),
      tipo: 'descarga'
    });
  }

  var reDom = /domain_url=(https?%3A%2F%2F[^&"'>\s]+|https?:\/\/[^&"'>\s]+)/gi;
  var m;
  while ((m = reDom.exec(html)) !== null) {
    var u = m[1];
    try { u = decodeURIComponent(u); } catch (e) { /* ignore */ }
    add(u);
  }

  var reHref = /href=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = reHref.exec(html)) !== null) add(m[1]);

  var rePlain = /https?:\/\/(?:www\.)?(?:mega\.nz|mediafire\.com|1fichier\.com|megaup\.net|gofile\.io)[^\s"'<>]*/gi;
  while ((m = rePlain.exec(html)) !== null) add(m[0]);

  return out;
}

function extraerServidor(url) {
  try {
    var host = new URL(url).hostname.replace('www.', '').toLowerCase();
    if (host.indexOf('streamwish') !== -1) return 'streamwish';
    if (host.indexOf('voe') !== -1) return 'voe';
    if (host.indexOf('vidhide') !== -1) return 'vidhide';
    if (host.indexOf('filemoon') !== -1) return 'filemoon';
    if (host.indexOf('dood') !== -1 || host.indexOf('dsvplay') !== -1) return 'dood';
    if (host.indexOf('mixdrop') !== -1) return 'mixdrop';
    if (host.indexOf('uqload') !== -1) return 'uqload';
    if (host.indexOf('streamtape') !== -1) return 'streamtape';
    if (host.indexOf('vimeos') !== -1) return 'vimeos';
    if (host.indexOf('goodstream') !== -1) return 'goodstream';
    if (host.indexOf('vidmoly') !== -1) return 'vidmoly';
    if (host.indexOf('vidguard') !== -1) return 'vidguard';
    if (host.indexOf('lulustream') !== -1) return 'lulustream';
    if (host.indexOf('videoapp') !== -1) return 'videoapp';
    if (host.indexOf('mega.nz') !== -1 || host.indexOf('mega.co') !== -1) return 'mega';
    if (host.indexOf('mediafire') !== -1) return 'mediafire';
    if (host.indexOf('1fichier') !== -1) return '1fichier';
    if (host.indexOf('megaup') !== -1) return 'megaup';
    return host.split('.')[0];
  } catch (e) {
    return 'desconocido';
  }
}

function esReproductorValido(url) {
  if (!url) return false;
  var u = String(url).toLowerCase().trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/\.(jpg|jpeg|png|webp|gif|svg|ico|css|woff2?)(\?|$)/i.test(u)) return false;
  if (u.indexOf('image.tmdb.org') !== -1 || u.indexOf('themoviedb.org') !== -1) return false;
  for (var i = 0; i < REPRODUCTORES_BLOQUEADOS.length; i++) {
    if (u.indexOf(REPRODUCTORES_BLOQUEADOS[i]) !== -1) return false;
  }
  for (var j = 0; j < REPRODUCTORES_PERMITIDOS.length; j++) {
    if (u.indexOf(REPRODUCTORES_PERMITIDOS[j]) !== -1) return true;
  }
  return false;
}

function esDescargaValida(url) {
  if (!url) return false;
  var u = String(url).toLowerCase();
  if (u.indexOf('google.com/s2/favicons') !== -1) return false;
  if (u.indexOf('acortalink') !== -1) return false;
  if (u.indexOf('favicon') !== -1) return false;
  var hosts = [
    'mega.nz', 'mega.co.nz', 'mediafire.com', '1fichier.com',
    'gofile.io', 'uptobox.com', 'pixeldrain.com', 'megaup.net'
  ];
  for (var i = 0; i < hosts.length; i++) {
    if (u.indexOf(hosts[i]) !== -1) return true;
  }
  return false;
}

// ======================================================
// BUSCADOR UNIVERSAL
// ======================================================
// ======================================================
// TMDB META (vía tvymas worker) — no altera embeds ni fuentes
// ======================================================
/**
 * FIX DUPLICACIÓN: antes solo quitaba el año "(2026)". Ahora también quita
 * notación de episodio/temporada, para que "Acaramelados S01E01",
 * "Acaramelados 1x01", "Acaramelados Capítulo 1" y "Acaramelados Episodio 1"
 * normalicen todos a "acaramelados" y se fusionen en un solo resultado en
 * vez de aparecer como obras distintas en /search.
 */
function normalizarTituloKey(t) {
  var s = String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(\d{4}\)/g, ''); // año entre paréntesis

  // Notación de episodio/temporada (en cualquier orden de aparición)
  s = s.replace(/\bs\d{1,2}\s*e\d{1,3}\b/g, '');                    // S01E01, s1e1
  s = s.replace(/\b\d{1,2}\s*x\s*\d{1,3}\b/g, '');                   // 1x01
  s = s.replace(/\b(cap(?:i?tulo)?|chapter)\.?\s*\d{1,4}\b/g, '');   // Cap 1, Capitulo 1
  s = s.replace(/\b(episodio|episode|ep)\.?\s*\d{1,4}\b/g, '');      // Episodio 1, Ep 1
  s = s.replace(/\b(temporada|season)\.?\s*\d{1,2}\b/g, '');         // Temporada 1

  return s
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Slug normalizado para deduplicar (quita año y variantes de temporada) */
function normalizarSlugKey(slug) {
  var s = String(slug || '').toLowerCase().trim();
  s = s.replace(/-\d{4}$/, '');
  s = s.replace(/-(?:season|temporada|part|parte)-\d+$/i, '');
  s = s.replace(/-\d+(?:st|nd|rd|th)-season$/i, '');
  s = s.replace(/-s\d+$/i, '');
  s = s.replace(/[^a-z0-9]+/g, '');
  return s;
}

function normalizarTipoKey(tipo) {
  var t = String(tipo || '').toLowerCase().trim();
  if (t === 'anime' || t === 'animes') return 'anime';
  if (t === 'serie' || t === 'series' || t === 'tv' || t === 'tvshows') return 'serie';
  if (t === 'pelicula' || t === 'película' || t === 'movie' || t === 'películas' || t === 'peliculas') return 'pelicula';
  if (t === 'capitulo' || t === 'capítulo' || t === 'episode') return 'capitulo';
  return t || 'otro';
}

/**
 * Tipos compatibles al deduplicar entre fuentes.
 * - Anime ↔ Serie: misma obra (catálogo distinto)
 * - Anime ↔ Pelicula: solo se permite en esMismaObra si el título es idéntico
 *   (algunas fuentes marcan especiales/OVA/films como Pelicula y otras como Anime)
 */
function tiposCompatibles(a, b) {
  var ta = normalizarTipoKey(a);
  var tb = normalizarTipoKey(b);
  if (ta === tb) return true;
  if ((ta === 'anime' && tb === 'serie') || (ta === 'serie' && tb === 'anime')) return true;
  // Anime/Serie vs Pelicula: se valida título exacto en esMismaObra
  if ((ta === 'anime' || ta === 'serie') && tb === 'pelicula') return true;
  if ((tb === 'anime' || tb === 'serie') && ta === 'pelicula') return true;
  return false;
}

/** Preferir tipo Anime si alguna fuente lo marca así */
/**
 * Elige tipo final del grupo de hits de la misma obra.
 * items (opcional): hits con .fuente y .tipo — evita que animeav1
 * convierta películas live-action en Anime.
 */
function preferirTipo(tipos, items) {
  var list = tipos || [];
  var cine = { pelisplushd: 1, pelisplus: 1, lamovie: 1, hackstore: 1 };
  var animeSrc = { animeav1: 1 };
  var doramaSrc = { doramasflix: 1 };

  var hasPeliculaCine = false;
  var hasSerieDorama = false;
  var hasAnime = false;
  var hasSerie = false;

  if (items && items.length) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      var f = String(it.fuente || '').toLowerCase();
      var t = normalizarTipoKey(it.tipo);
      if (t === 'pelicula' && cine[f]) hasPeliculaCine = true;
      if (t === 'serie' && doramaSrc[f]) hasSerieDorama = true;
      if (t === 'anime' && animeSrc[f]) hasAnime = true;
      if (t === 'serie') hasSerie = true;
      if (t === 'anime') hasAnime = true;
      if (t === 'pelicula') hasPeliculaCine = hasPeliculaCine || !!cine[f];
    }
  } else {
    for (var j = 0; j < list.length; j++) {
      var tk = normalizarTipoKey(list[j]);
      if (tk === 'anime') hasAnime = true;
      if (tk === 'serie') hasSerie = true;
      if (tk === 'pelicula') hasPeliculaCine = true;
    }
  }

  // Película de cine gana sobre "Anime" basura del mismo slug en animeav1
  if (hasPeliculaCine && !hasSerieDorama) return 'Pelicula';
  // Dorama/serie de doramasflix
  if (hasSerieDorama && !hasPeliculaCine) return 'Serie';
  // Anime real
  if (hasAnime && !hasPeliculaCine) return 'Anime';
  if (hasSerie) return 'Serie';
  if (hasPeliculaCine) return 'Pelicula';

  for (var a = 0; a < list.length; a++) {
    if (normalizarTipoKey(list[a]) === 'anime') return 'Anime';
  }
  for (var b = 0; b < list.length; b++) {
    if (normalizarTipoKey(list[b]) === 'serie') return 'Serie';
  }
  for (var c = 0; c < list.length; c++) {
    if (normalizarTipoKey(list[c]) === 'pelicula') return 'Pelicula';
  }
  return list[0] || 'Serie';
}

/** Fuente principal según tipo final (estrenos cine → pelisplus) */
function elegirFuentePrincipal(items, tipoFinal) {
  if (!items || !items.length) return null;
  var t = normalizarTipoKey(tipoFinal);
  var order;
  if (t === 'pelicula') {
    // Pelisplus más actualizada en estrenos de película
    order = ['pelisplushd', 'lamovie', 'hackstore', 'doramasflix'];
  } else if (t === 'anime') {
    order = ['animeav1', 'pelisplushd', 'lamovie', 'hackstore'];
  } else {
    // serie / dorama
    order = ['doramasflix', 'pelisplushd', 'lamovie', 'hackstore', 'animeav1'];
  }
  for (var i = 0; i < order.length; i++) {
    for (var j = 0; j < items.length; j++) {
      if (String(items[j].fuente || '').toLowerCase() === order[i]) return order[i];
    }
  }
  return String(items[0].fuente || '').toLowerCase() || null;
}

/** Extrae año de título, slug o campo year */
function extraerYearItem(item) {
  if (item && item.year) {
    var y = String(item.year).match(/(\d{4})/);
    if (y) return y[1];
  }
  var t = String((item && item.titulo) || '');
  var m = t.match(/\((\d{4})\)/) || t.match(/\b(19\d{2}|20\d{2})\b/);
  if (m) return m[1];
  var slug = String((item && item.slug) || '');
  m = slug.match(/-(\d{4})$/);
  if (m) return m[1];
  return null;
}

/**
 * Clave de deduplicación:
 * 1) TMDB ID si existe
 * 2) título normalizado + tipo
 * (el año se valida al fusionar para no mezclar remakes)
 */
function claveDeduplicacion(item) {
  if (!item) return null;
  if (item.tmdb_id) {
    var tk = normalizarTipoKey(item.tipo);
    var tb = (tk === 'anime' || tk === 'serie') ? 'show' : tk;
    return 'tmdb:' + String(item.tmdb_id) + '|' + tb;
  }
  var tipo = normalizarTipoKey(item.tipo);
  // Anime y Serie comparten bucket "show" para no duplicar la misma obra
  var bucket = (tipo === 'anime' || tipo === 'serie') ? 'show' : tipo;
  var titulo = normalizarTituloKey(item.titulo || '');
  if (titulo && titulo.length >= 2) return 'tt:' + titulo + '|' + bucket;
  var slug = normalizarSlugKey(item.slug || '');
  if (slug) return 'sl:' + slug + '|' + bucket;
  return null;
}

/**
 * Prioridad de fuentes para búsqueda/fusión:
 * 1) animeav1 (4)  2) pelisplushd (3)  3) lamovie (1)  4) hackstore (2)
 * Si animeav1 tiene la obra, es la fuente principal; el resto va a alternativas.
 */
/**
 * Orden de fuentes (búsqueda / fusión / detalle):
 * 1 animeav1 → 2 doramasflix → 4 pelisplushd → 5 lamovie → 6 hackstore
 */
function prioridadFuente(nombre) {
  var f = String(nombre || '').toLowerCase();
  if (f === 'animeav1' || f === '4') return 0;
  if (f === 'doramasflix' || f === '6') return 2;
  if (f === 'pelisplushd' || f === 'pelisplus' || f === '3') return 3;
  if (f === 'lamovie' || f === '1') return 4;
  if (f === 'hackstore' || f === '2') return 5;
  return 9;
}

function ordenarFuentesLista(fuentes) {
  if (!fuentes || !fuentes.length) return [];
  return fuentes.slice().sort(function (a, b) {
    return prioridadFuente(a) - prioridadFuente(b);
  });
}

/** Puntuación para elegir el mejor resultado base al fusionar */
function scoreItemBusqueda(item) {
  if (!item) return 0;
  var s = 0;
  var f = String(item.fuente || '').toLowerCase();
  var t = normalizarTipoKey(item.tipo);

  // Score por fuente SEGÚN tipo (no animeav1 siempre arriba)
  if (t === 'pelicula') {
    if (f === 'pelisplushd') s += 200; // estrenos cine más actualizados
    else if (f === 'lamovie') s += 160;
    else if (f === 'hackstore') s += 140;
    else if (f === 'doramasflix') s += 80;
    else if (f === 'animeav1') s += 5; // casi basura para cine
  } else if (t === 'anime') {
    if (f === 'animeav1') s += 200; // emisión / estrenos anime
    else if (f === 'pelisplushd') s += 60;
    else if (f === 'lamovie') s += 40;
    else if (f === 'hackstore') s += 30;
  } else {
    // serie / dorama
    if (f === 'doramasflix') s += 200;
    if (f === 'pelisplushd') s += 140;
    if (f === 'lamovie') s += 100;
    if (f === 'hackstore') s += 80;
    if (f === 'animeav1') s += 50;
  }

  if (item.portada && !esPortadaSospechosa(item.portada)) s += 25;
  if (item.portada_imdb && esPortadaImdb(item.portada_imdb)) s += 12;
  if (item.portada_tmdb && !esPortadaSospechosa(item.portada_tmdb)) s += 8;
  if (item.descripcion && String(item.descripcion).length > 40) s += 15;
  if (item.tmdb_id) s += 25;
  if (item.calificacion) s += 10;
  if (item.year) s += 5;
  if (item.slug) s += 5;
  if (item.backdrop) s += 5;
  // Más episodios / temps = mejor (Wistoria animeav1 vs lamovie corto)
  var nEps = Number(item.total_episodios) || (Array.isArray(item.episodios) ? item.episodios.length : 0) || 0;
  var nTemp = Number(item.total_temporadas) || 0;
  if (nEps > 0) s += Math.min(40, nEps);
  if (nTemp > 1) s += nTemp * 8;
  return s;
}

/**
 * Fusiona resultados de varias fuentes en un solo ítem por obra.
 * - Une la misma película/serie aunque el slug sea distinto (acaramelados vs acaramelados-2026)
 * - Conserva alternativas por fuente
 * - No mezcla títulos con años distintos (ej. remakes)
 */

/**
 * ¿Misma obra o solo misma franquicia?
 * - Mismo título normalizado → sí
 * - Mismo slug base → sí
 * - Un título contenido en otro SOLO si el extra es año/season/part (no film/movie/heroines…)
 * - Película vs Serie/Anime: solo si título exacto
 * - Token JP/EN: palabra >= 7 chars compartida + slug la contiene (wistoria, acaramelados…)
 */
/**
 * ¿Misma obra entre DOS FUENTES DISTINTAS?
 * REGLA CLAVE: dentro de la misma fuente NUNCA son duplicados
 * (una página no lista la misma obra 4 veces; son entradas distintas).
 * Solo se fusionan cuando fuentes diferentes apuntan a la misma obra.
 *
 * Matching estricto:
 * 1) título normalizado idéntico
 * 2) slug normalizado idéntico
 * 3) slug prefijo solo si el resto es año/season (no "film-red", "heroines", "episode-of-…")
 */
function esMismaObra(a, b) {
  if (!a || !b) return false;

  // Misma fuente → NUNCA duplicado
  var fa = String(a.fuente || '').toLowerCase();
  var fb = String(b.fuente || '').toLowerCase();
  if (fa && fb && fa === fb) return false;

  if (!tiposCompatibles(a.tipo, b.tipo)) return false;

  var ta = normalizarTipoKey(a.tipo);
  var tb = normalizarTipoKey(b.tipo);
  var aIsMovie = ta === 'pelicula';
  var bIsMovie = tb === 'pelicula';

  var titleA = normalizarTituloKey(a.titulo || '');
  var titleB = normalizarTituloKey(b.titulo || '');
  var slugA = normalizarSlugKey(a.slug || '');
  var slugB = normalizarSlugKey(b.slug || '');

  // Anime/Serie vs Película: solo título exacto
  if (aIsMovie !== bIsMovie) {
    if (!titleA || !titleB || titleA !== titleB) return false;
    return true;
  }

  // Título idéntico
  if (titleA && titleB && titleA === titleB) return true;

  // Slug idéntico (sin año)
  if (slugA && slugB && slugA === slugB) return true;

  // Slug prefijo SOLO si el resto es season/part residual (no palabras de obra distinta)
  if (slugA && slugB && slugA.length >= 6 && slugB.length >= 6) {
    var longer = slugA.length >= slugB.length ? slugA : slugB;
    var shorter = slugA.length >= slugB.length ? slugB : slugA;
    if (longer.indexOf(shorter) === 0) {
      var rest = longer.slice(shorter.length);
      if (!rest || /^(season|part|temporada|s)?\d{0,2}$/i.test(rest)) return true;
    }
  }

  // Contención de título: SOLO año residual (nada de film/heroines/episode/…)
  if (titleA && titleB && titleA !== titleB) {
    var shortT = titleA.length <= titleB.length ? titleA : titleB;
    var longT = titleA.length <= titleB.length ? titleB : titleA;
    if (shortT.length >= 5 && longT.indexOf(shortT) === 0) {
      var extra = longT.slice(shortT.length).trim();
      // Solo permitir vacío o un año de 4 dígitos
      if (!extra || /^\d{4}$/.test(extra)) return true;
    }
  }

  // NO token matching suelto: provocaba unir "Episode of Sorajima" con
  // "Episode of East Blue" por la palabra compartida "episode".
  return false;
}

/** Deduplica alternativas por fuente+slug; conserva la que tenga portada */
function dedupeAlternativas(alts) {
  if (!alts || !alts.length) return [];
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < alts.length; i++) {
    var a = alts[i];
    if (!a) continue;
    var k = String(a.fuente || '').toLowerCase() + '|' + String(a.slug || '').toLowerCase();
    if (seen[k] !== undefined) {
      var prev = out[seen[k]];
      if (prev && (!prev.portada || prev.portada === null) && a.portada) {
        prev.portada = a.portada;
      }
      continue;
    }
    seen[k] = out.length;
    out.push({
      fuente: a.fuente || null,
      source_id: a.source_id || null,
      slug: a.slug || null,
      link: a.link || null,
      portada: a.portada || null
    });
  }
  return out;
}

/** Elige la mejor portada entre actual y candidata (prioridad: IMDb > no-sospechosa) */
function mejorPortada(actual, candidata) {
  if (!candidata) return actual || null;
  if (!actual) return candidata;
  try {
    // IMDb siempre gana
    if (typeof esPortadaImdb === 'function') {
      if (esPortadaImdb(candidata) && !esPortadaImdb(actual)) return candidata;
      if (esPortadaImdb(actual)) return actual;
    }
    if (typeof esPortadaSospechosa === 'function') {
      if (esPortadaSospechosa(actual) && !esPortadaSospechosa(candidata)) return candidata;
      if (!esPortadaSospechosa(actual) && esPortadaSospechosa(candidata)) return actual;
    }
  } catch (e) { /* ok */ }
  if (/placeholder/i.test(String(actual)) && candidata) return candidata;
  return actual;
}

function fusionarResultadosBusqueda(items) {
  if (!items || !items.length) return [];

  var grupos = Object.create(null);
  var orden = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    // Limpiar campos basura de fuentes (ej. success filtrado de animeav1)
    delete it.success;
    var key = claveDeduplicacion(it);
    if (!key) key = 'uniq:' + i + ':' + String(it.titulo || it.slug || Math.random());
    if (!grupos[key]) {
      grupos[key] = [];
      orden.push(key);
    }
    grupos[key].push(it);
  }

  var out = [];
  for (var oi = 0; oi < orden.length; oi++) {
    var group = grupos[orden[oi]];
    if (!group || !group.length) continue;

    // Separar por año si hay conflicto (remakes)
    var byYear = Object.create(null);
    var sinYear = [];
    for (var g = 0; g < group.length; g++) {
      var yr = extraerYearItem(group[g]);
      if (yr) {
        if (!byYear[yr]) byYear[yr] = [];
        byYear[yr].push(group[g]);
      } else {
        sinYear.push(group[g]);
      }
    }
    var years = Object.keys(byYear);
    var subgrupos = [];
    if (years.length <= 1) {
      subgrupos.push(group);
    } else {
      // Hay remakes/reboots con el mismo título. Los resultados sin año son
      // ambiguos y NO se deben pegar automáticamente al año más frecuente.
      for (var yj = 0; yj < years.length; yj++) {
        subgrupos.push(byYear[years[yj]].slice());
      }
      if (sinYear.length) subgrupos.push(sinYear.slice());
    }

    for (var si = 0; si < subgrupos.length; si++) {
      var sg = subgrupos[si];
      if (!sg || !sg.length) continue;
      // Preferir animeav1 como base
      sg.sort(function (a, b) { return scoreItemBusqueda(b) - scoreItemBusqueda(a); });

      // Solo 1 entrada por fuente: misma fuente = obras distintas (no duplicados)
      // Agrupar por fuente y quedarnos con el mejor de cada una
      var porFuente = Object.create(null);
      var ordenF = [];
      for (var j0 = 0; j0 < sg.length; j0++) {
        var it0 = sg[j0];
        var f0 = String(it0.fuente || 'unknown').toLowerCase();
        if (!porFuente[f0]) {
          porFuente[f0] = it0;
          ordenF.push(f0);
        } else {
          // Misma fuente: NO fusionar. Empujar el extra como resultado independiente
          // (se procesará solo: una entrada = una obra)
          out.push(Object.assign({}, it0, {
            fuentes: [f0],
            alternativas: [],
            success: undefined
          }));
          delete out[out.length - 1].success;
        }
      }

      // Reconstruir sg con 1 por fuente
      sg = [];
      for (var of = 0; of < ordenF.length; of++) sg.push(porFuente[ordenF[of]]);
      if (!sg.length) continue;

      sg.sort(function (a, b) { return scoreItemBusqueda(b) - scoreItemBusqueda(a); });
      var best = {};
      var src0 = sg[0];
      for (var k in src0) {
        if (Object.prototype.hasOwnProperty.call(src0, k)) best[k] = src0[k];
      }

      var fuentes = [];
      var seenF = Object.create(null);
      var alternativas = [];
      for (var j = 0; j < sg.length; j++) {
        var cur = sg[j];
        var f = String(cur.fuente || '').toLowerCase();
        if (f && !seenF[f]) {
          seenF[f] = true;
          fuentes.push(f);
        }
        // Solo fusionar datos de OTRAS fuentes (nunca de la misma)
        if (j === 0) continue;
        best.portada = mejorPortada(best.portada, cur.portada);
        if ((!best.descripcion || String(best.descripcion).length < 40) && cur.descripcion && String(cur.descripcion).length >= 40) {
          best.descripcion = cur.descripcion;
        }
        if (!best.year && cur.year) best.year = cur.year;
        if (!best.calificacion && cur.calificacion) best.calificacion = cur.calificacion;
        if (!best.tmdb_id && cur.tmdb_id) best.tmdb_id = cur.tmdb_id;
        if (!best.imdb_id && cur.imdb_id) best.imdb_id = cur.imdb_id;
        if (!best.portada_imdb && cur.portada_imdb) best.portada_imdb = cur.portada_imdb;
        if (!best.portada_tmdb && cur.portada_tmdb) best.portada_tmdb = cur.portada_tmdb;
        if (!best.poster_source && cur.poster_source) best.poster_source = cur.poster_source;
        if (!best.backdrop && cur.backdrop) best.backdrop = cur.backdrop;
        if (!best.genero && cur.genero) best.genero = cur.genero;
        if ((!best.generos || !best.generos.length) && cur.generos && cur.generos.length) best.generos = cur.generos;
        // Alternativa solo si fuente distinta
        if (f && f !== String(best.fuente || '').toLowerCase()) {
          alternativas.push({
            fuente: cur.fuente,
            source_id: cur.source_id || (typeof sourceIdFromName === 'function' ? sourceIdFromName(cur.fuente) : null),
            slug: cur.slug || null,
            link: cur.link || null,
            portada: cur.portada || null
          });
        }
      }
      var tiposFirst = [];
      for (var tf = 0; tf < sg.length; tf++) {
        if (sg[tf].tipo) tiposFirst.push(sg[tf].tipo);
      }
      best.tipo = preferirTipo(tiposFirst, sg);
      // Fuente principal según tipo (pelicula→pelisplus, anime→animeav1, serie→doramas)
      var fPrinc = elegirFuentePrincipal(sg, best.tipo);
      if (fPrinc) {
        best.fuente = fPrinc;
        for (var jp = 0; jp < sg.length; jp++) {
          if (String(sg[jp].fuente || '').toLowerCase() === fPrinc) {
            if (sg[jp].slug) best.slug = sg[jp].slug;
            if (sg[jp].descripcion && (!best.descripcion || String(best.descripcion).length < 40)) {
              best.descripcion = sg[jp].descripcion;
            }
            best.portada = mejorPortada(best.portada, sg[jp].portada);
            break;
          }
        }
        if (typeof sourceIdFromName === 'function') best.source_id = sourceIdFromName(fPrinc);
      }
      best.fuentes = ordenarFuentesLista(fuentes);
      if (!best.fuente && best.fuentes.length) best.fuente = best.fuentes[0];
      // Si es ANIME y animeav1 está en el grupo, preferir su slug/meta (más caps)
      if (normalizarTipoKey(best.tipo) === 'anime') {
        for (var ja = 0; ja < sg.length; ja++) {
          if (String(sg[ja].fuente || '').toLowerCase() === 'animeav1') {
            best.fuente = 'animeav1';
            if (sg[ja].slug) best.slug = sg[ja].slug;
            if (sg[ja].descripcion && (!best.descripcion || String(best.descripcion).length < 40)) {
              best.descripcion = sg[ja].descripcion;
            }
            best.portada = mejorPortada(best.portada, sg[ja].portada);
            if (typeof sourceIdFromName === 'function') best.source_id = sourceIdFromName('animeav1');
            break;
          }
        }
      }
      // Alternativas: solo otras fuentes (nunca la misma)
      if (alternativas.length) {
        best.alternativas = dedupeAlternativas(alternativas).filter(function (alt) {
          return String(alt.fuente || '').toLowerCase() !== String(best.fuente || '').toLowerCase();
        });
      }
      delete best.success;
      if (!best.year) {
        var ey = extraerYearItem(best);
        if (ey) best.year = ey;
      }
      out.push(best);
    }
  }

  // Segunda pasada: unir por slug base o título contenido (cubre ruido residual)
  if (out.length > 1) {
    var merged = [];
    var used = Object.create(null);
    for (var a = 0; a < out.length; a++) {
      if (used[a]) continue;
      var base = out[a];
      var baseTitle = normalizarTituloKey(base.titulo || '');
      var baseSlug = normalizarSlugKey(base.slug || '');
      var baseTipo = normalizarTipoKey(base.tipo);
      var baseYear = extraerYearItem(base);
      var group2 = [base];
      used[a] = true;
      for (var b = a + 1; b < out.length; b++) {
        if (used[b]) continue;
        var other = out[b];
        if (!tiposCompatibles(other.tipo, base.tipo)) continue;
        var oYear = extraerYearItem(other);
        if (baseYear && oYear && baseYear !== oYear) continue;
        var oTitle = normalizarTituloKey(other.titulo || '');
        var oSlug = normalizarSlugKey(other.slug || '');
        // Matching estricto: evita unir "One Piece" con "One Piece Film Red" / Heroines / especiales
        if (esMismaObra(base, other)) {
          group2.push(other);
          used[b] = true;
        }
      }
      if (group2.length === 1) {
        merged.push(base);
      } else {
        // Re-fusionar el subgrupo
        group2.sort(function (x, y) { return scoreItemBusqueda(y) - scoreItemBusqueda(x); });
        var best2 = {};
        var s0 = group2[0];
        for (var kk in s0) {
          if (Object.prototype.hasOwnProperty.call(s0, kk)) best2[kk] = s0[kk];
        }
        var fuentes2 = [];
        var seenF2 = Object.create(null);
        var alts2 = [];
        for (var g2 = 0; g2 < group2.length; g2++) {
          var cur2 = group2[g2];
          var f2 = String(cur2.fuente || '').toLowerCase();
          if (f2 && !seenF2[f2]) { seenF2[f2] = true; fuentes2.push(f2); }
          if (esFuentePelisplus(best2) && cur2.portada_imdb && esPortadaImdb(cur2.portada_imdb)) { best2.portada = cur2.portada_imdb; best2.poster_source = 'imdb'; }
          best2.portada = mejorPortada(best2.portada, cur2.portada);
          if ((!best2.descripcion || String(best2.descripcion).length < 40) && cur2.descripcion) best2.descripcion = cur2.descripcion;
          if (!best2.year && cur2.year) best2.year = cur2.year;
          if (!best2.calificacion && cur2.calificacion) best2.calificacion = cur2.calificacion;
          if (!best2.tmdb_id && cur2.tmdb_id) best2.tmdb_id = cur2.tmdb_id;
          if (!best2.imdb_id && cur2.imdb_id) best2.imdb_id = cur2.imdb_id;
          if (!best2.portada_imdb && cur2.portada_imdb) best2.portada_imdb = cur2.portada_imdb;
          if (!best2.portada_tmdb && cur2.portada_tmdb) best2.portada_tmdb = cur2.portada_tmdb;
          if (!best2.poster_source && cur2.poster_source) best2.poster_source = cur2.poster_source;
          if (!best2.slug && cur2.slug) best2.slug = cur2.slug;
          // alternativas SOLO de fuentes distintas (nunca la misma fuente)
          if (g2 > 0) {
            var fBest2 = String(best2.fuente || '').toLowerCase();
            if (f2 && f2 !== fBest2) {
              alts2.push({
                fuente: cur2.fuente,
                source_id: cur2.source_id || (typeof sourceIdFromName === 'function' ? sourceIdFromName(cur2.fuente) : null),
                slug: cur2.slug || null,
                link: cur2.link || null,
                portada: cur2.portada || null
              });
            }
          }
          if (Array.isArray(cur2.alternativas)) {
            for (var ax = 0; ax < cur2.alternativas.length; ax++) {
              var altX = cur2.alternativas[ax];
              if (!altX) continue;
              if (String(altX.fuente || '').toLowerCase() === String(best2.fuente || '').toLowerCase()) continue;
              alts2.push(altX);
            }
          }
        }
        // Preferir tipo Anime si alguna fuente lo dice
        var tiposG = [];
        for (var tg = 0; tg < group2.length; tg++) {
          if (group2[tg].tipo) tiposG.push(group2[tg].tipo);
        }
        best2.tipo = preferirTipo(tiposG, group2);
        best2.fuentes = ordenarFuentesLista(fuentes2);
        if (best2.fuentes.length) best2.fuente = best2.fuentes[0];
        for (var ja2 = 0; ja2 < group2.length; ja2++) {
          if (String(group2[ja2].fuente || '').toLowerCase() === 'animeav1') {
            best2.fuente = 'animeav1';
            if (group2[ja2].slug) best2.slug = group2[ja2].slug;
            if (group2[ja2].descripcion && (!best2.descripcion || String(best2.descripcion).length < 40)) {
              best2.descripcion = group2[ja2].descripcion;
            }
            best2.portada = mejorPortada(best2.portada, group2[ja2].portada);
            if (typeof sourceIdFromName === 'function') best2.source_id = sourceIdFromName('animeav1');
            break;
          }
        }
        if (alts2.length) {
          var fMain = String(best2.fuente || '').toLowerCase();
          best2.alternativas = dedupeAlternativas(alts2).filter(function (alt) {
            return String(alt.fuente || '').toLowerCase() !== fMain;
          });
        }
        delete best2.success;
        if (!best2.year) {
          var ey2 = extraerYearItem(best2);
          if (ey2) best2.year = ey2;
        }
        merged.push(best2);
      }
    }
    out = merged;
  }

  return out;
}

function imgTmdb(path, size) {
  if (!path) return null;
  if (String(path).indexOf('http') === 0) return path;
  return 'https://image.tmdb.org/t/p/' + (size || 'w500') + path;
}

/** tvymas desactivado — meta sale del scrape de cada página */
async function buscarMetaTmdb(query) {
  return [];
}

/** tvymas desactivado */
async function fetchDetalleTmdbMeta(slugOrTitle, tipoHint) {
  return null;
}

/** Completa tmdb_id / status / descripción / votos usando IMDb ID (find + detail). */
async function completarDesdeTmdbPorImdbId(imdbId, tipoHint) {
  var key = __TMDB_KEY__ || null;
  if (!key || !imdbId || String(imdbId).indexOf('tt') !== 0) return null;
  try {
    var findUrl = 'https://api.themoviedb.org/3/find/' + encodeURIComponent(imdbId)
      + '?api_key=' + encodeURIComponent(key)
      + '&external_source=imdb_id&language=es-ES';
    var res = await fetchWithTimeout(findUrl, { headers: { Accept: 'application/json' } }, 9000);
    if (!res || !res.ok) return null;
    var data = await res.json();
    var isTv = normalizarTipoKey(tipoHint) === 'serie' || normalizarTipoKey(tipoHint) === 'anime';
    var hit = null;
    var mediaType = null;
    if (isTv) {
      if (data.tv_results && data.tv_results.length) { hit = data.tv_results[0]; mediaType = 'tv'; }
      else if (data.movie_results && data.movie_results.length) { hit = data.movie_results[0]; mediaType = 'movie'; }
    } else {
      if (data.movie_results && data.movie_results.length) { hit = data.movie_results[0]; mediaType = 'movie'; }
      else if (data.tv_results && data.tv_results.length) { hit = data.tv_results[0]; mediaType = 'tv'; }
    }
    if (!hit || !hit.id) return null;

    var detUrl = 'https://api.themoviedb.org/3/' + mediaType + '/' + hit.id
      + '?api_key=' + encodeURIComponent(key) + '&language=es-ES';
    var res2 = await fetchWithTimeout(detUrl, { headers: { Accept: 'application/json' } }, 9000);
    if (!res2 || !res2.ok) {
      return {
        tmdb_id: hit.id,
        descripcion: hit.overview || null,
        votos: hit.vote_count || null,
        calificacion: hit.vote_average != null ? Number(hit.vote_average) : null,
        status: null,
        fecha_estreno: hit.release_date || hit.first_air_date || null,
        year: (hit.release_date || hit.first_air_date || '').slice(0, 4) || null
      };
    }
    var d = await res2.json();
    var release = d.release_date || d.first_air_date || null;
    return {
      tmdb_id: d.id || hit.id,
      descripcion: d.overview || hit.overview || null,
      votos: d.vote_count != null ? d.vote_count : (hit.vote_count || null),
      calificacion: d.vote_average != null ? Number(d.vote_average) : null,
      status: d.status || null,
      fecha_estreno: release,
      year: release ? String(release).slice(0, 4) : null,
      backdrop: d.backdrop_path ? ('https://image.tmdb.org/t/p/w780' + d.backdrop_path) : null,
      titulo_original: d.original_title || d.original_name || null
    };
  } catch (e) {
    return null;
  }
}

/** Extrae meta limpia desde un ítem de búsqueda tvymas (sin campos duplicados) */
function mapMetaFromSearchItem(it) {
  if (!it) return null;
  var poster = it.tmdb_poster || it.image || it.poster_tmdb || null;
  var overview = it.tmdb_overview || it.overview || it.description || null;
  var genres = it.tmdb_genres || it.genres || it.genres_tmdb || null;
  var rating = it.tmdb_rating || it.rating || null;
  var release = it.tmdb_release_date || it.release_date || null;
  return {
    tmdb_id: it.tmdb_id || null,
    titulo_tmdb: it.title || it.titulo || null,
    portada_tmdb: poster,
    backdrop: it.backdrop || null,
    calificacion: rating != null ? Number(rating) : null,
    descripcion: overview,
    generos: Array.isArray(genres) ? genres : (genres ? [genres] : []),
    fecha_estreno: release,
    year: release ? String(release).slice(0, 4) : null,
    titulo_original: it.original_title || null,
    votos: it.votes || null,
    duracion: it.runtime || null,
    status: it.status || null,
    tagline: it.tagline || null,
    imdb_id: it.imdb_id || null,
    slug_tmdb: it.slug || null
  };
}

/**
 * Aplica metadata al resultado.
 * Para PelisPlus, IMDb es la fuente preferida de portada; TMDB queda como
 * respaldo. Para las demás fuentes solo reemplaza portadas ausentes/sospechosas.
 */
/**
 * ¿La meta de IMDb/OMDb corresponde al ítem?
 * Evita poner el poster de "One Piece" en "One Piece Film: Red" / Heroines / 3D2Y.
 */
function metaCoincideConItem(item, meta) {
  if (!item || !meta) return false;
  var tItem = normalizarTituloKey(item.titulo || '');
  var tMeta = normalizarTituloKey(meta.titulo_tmdb || meta.titulo_original || '');
  if (!tItem || !tMeta) return false;

  var yItem = extraerYearItem(item);
  var yMeta = meta.year || (meta.fecha_estreno ? String(meta.fecha_estreno).slice(0, 4) : null);

  // Año de la fuente manda: si difiere, NO es la misma obra
  if (yItem && yMeta && String(yItem) !== String(yMeta)) return false;

  if (tItem === tMeta) {
    // Título idéntico + año OK (o sin año en ítem) → coincide
    return true;
  }

  var STOP = {
    one:1, piece:1, the:1, and:1, film:1, movie:1, special:1, episode:1,
    anime:1, series:1, season:1, part:1
  };
  function extras(t) {
    return t.split(/\s+/).filter(function (w) { return w.length >= 3 && !STOP[w]; });
  }
  var eItem = extras(tItem);
  var eMeta = extras(tMeta);

  if (eItem.length) {
    var shared = 0;
    for (var i = 0; i < eItem.length; i++) {
      if (tMeta.indexOf(eItem[i]) !== -1) shared++;
    }
    if (shared === 0) return false;
    if (shared < Math.ceil(eItem.length / 2)) return false;
  } else {
    if (eMeta.length > 0) return false;
  }

  return true;
}

function aplicarMetaAResultadoBusqueda(item, meta) {
  if (!item || !meta) return item;

  var coincide = metaCoincideConItem(item, meta);
  // Si IMDb ya filtró por año (year fuente = year meta) y trajo imdb_id,
  // confiar en el match aunque el título IMDb sea distinto ("La captura" vs "Facing El Chapo")
  var yIt0 = extraerYearItem(item);
  var yMt0 = meta.year || (meta.fecha_estreno ? String(meta.fecha_estreno).slice(0, 4) : null);
  if (!coincide && meta.imdb_id && yIt0 && yMt0 && String(yIt0) === String(yMt0)) {
    coincide = true;
  }
  var sinPortada = !item.portada || (typeof esPortadaSospechosa === 'function' && esPortadaSospechosa(item.portada));

  // Soft poster: solo si NO hay conflicto de año (evita portada 2012 en película 2026)
  if (!coincide) {
    var yItemSoft = extraerYearItem(item);
    var yMetaSoft = meta.year || (meta.fecha_estreno ? String(meta.fecha_estreno).slice(0, 4) : null);
    var yearSoftOk = !yItemSoft || !yMetaSoft || String(yItemSoft) === String(yMetaSoft);
    if (sinPortada && yearSoftOk) {
      var tA = normalizarTituloKey(item.titulo || '');
      var tB = normalizarTituloKey(meta.titulo_tmdb || meta.titulo_original || '');
      if (tA && tB && (tA === tB || tA.indexOf(tB) === 0 || tB.indexOf(tA) === 0)) {
        if (meta.portada_imdb && esPortadaUrlValida(meta.portada_imdb)) {
          item.portada = meta.portada_imdb;
          item.portada_imdb = meta.portada_imdb;
          item.poster_source = 'imdb';
        } else if (meta.portada_tmdb && esPortadaUrlValida(meta.portada_tmdb)) {
          item.portada = meta.portada_tmdb;
          item.portada_tmdb = meta.portada_tmdb;
          item.poster_source = 'tmdb';
        }
      }
    }
    return item;
  }

  // Evitar cruzar metadata de obras con años distintos (remakes)
  var itemYear = extraerYearItem(item);
  var metaYear = meta.year || (meta.fecha_estreno ? String(meta.fecha_estreno).slice(0, 4) : null);
  var yearConflict = itemYear && metaYear && String(itemYear) !== String(metaYear);
  if (yearConflict) {
    meta = {
      descripcion: meta.descripcion,
      generos: meta.generos,
      calificacion: null,
      votos: null,
      year: null,
      fecha_estreno: null,
      tmdb_id: null,
      imdb_id: null,
      portada_imdb: null,
      portada_tmdb: null,
      backdrop: null,
      titulo_tmdb: meta.titulo_tmdb,
      titulo_original: meta.titulo_original
    };
  }

  if (meta.tmdb_id) item.tmdb_id = meta.tmdb_id;
  if (meta.imdb_id) item.imdb_id = meta.imdb_id;
  if (meta.estado && !item.estado) item.estado = meta.estado;
  if (meta.en_emision != null && item.en_emision == null) item.en_emision = meta.en_emision;
  if (meta.finalizado != null && item.finalizado == null) item.finalizado = meta.finalizado;
  if (meta.status && !item.estado) {
    var stAp = normalizarEstadoEmision(meta.status);
    if (stAp.estado) {
      item.estado = stAp.estado;
      if (item.en_emision == null) item.en_emision = stAp.en_emision;
      if (item.finalizado == null) item.finalizado = stAp.finalizado;
    }
  }
  if (meta.titulo_tmdb) item.titulo_tmdb = meta.titulo_tmdb;
  if (meta.titulo_original) item.titulo_original = meta.titulo_original;

  // Portada: preferir IMDb cuando el match es válido (año OK)
  var yItemP = extraerYearItem(item);
  var yMetaP = meta.year || (meta.fecha_estreno ? String(meta.fecha_estreno).slice(0, 4) : null);
  var yearOkPoster = !yItemP || !yMetaP || String(yItemP) === String(yMetaP);
  if (coincide && yearOkPoster) {
    if (meta.portada_imdb && esPortadaUrlValida(meta.portada_imdb)) {
      item.portada_imdb = meta.portada_imdb;
      // IMDb portada prioritaria
      item.portada = meta.portada_imdb;
      item.poster_source = 'imdb';
    }
    if (meta.portada_tmdb && esPortadaUrlValida(meta.portada_tmdb) && !esPortadaSospechosa(meta.portada_tmdb)) {
      item.portada_tmdb = meta.portada_tmdb;
      if (!item.portada || esPortadaSospechosa(item.portada)) {
        item.portada = meta.portada_tmdb;
        item.poster_source = 'tmdb';
      }
    }
    if (!item.portada || esPortadaSospechosa(item.portada)) {
      var portadaPreferida = elegirPortadaPreferida(item, meta);
      if (portadaPreferida) {
        item.portada = portadaPreferida;
        item.poster_source = esPortadaImdb(portadaPreferida) ? 'imdb' :
          (/image\.tmdb\.org/i.test(portadaPreferida) ? 'tmdb' : String(item.fuente || 'fuente'));
      }
    }
  }

  if (meta.backdrop && esPortadaUrlValida(meta.backdrop) && !/media-amazon|amazon\.com/i.test(meta.backdrop)) {
    item.backdrop = meta.backdrop;
  }

  // Match OK → datos IMDb tienen prioridad (rating, votos, id)
  var yItemA = extraerYearItem(item);
  var yMetaA = meta.year || (meta.fecha_estreno ? String(meta.fecha_estreno).slice(0, 4) : null);
  var yearOkMeta = !yItemA || !yMetaA || String(yItemA) === String(yMetaA);
  var simOk = true;
  if (item.descripcion && meta.descripcion && String(item.descripcion).length > 50 && String(meta.descripcion).length > 50) {
    var simD = similitudDescripcion(item.descripcion, meta.descripcion);
    // Si hay año coincidente, ser más permisivo (título IMDb puede diferir)
    if (yearOkMeta && yItemA) simOk = simD >= 0.05 || !meta.descripcion;
    else if (simD < 0.12) simOk = false;
  }
  if (yearOkMeta && simOk) {
    // Calificación IMDb: preferir siempre la de IMDb cuando hay match
    if (meta.calificacion != null && !isNaN(Number(meta.calificacion))) {
      item.calificacion = normalizarCalificacion(meta.calificacion);
    }
    if (meta.votos) item.votos = meta.votos;
    if (meta.imdb_id) item.imdb_id = meta.imdb_id;
  }

  // Descripción: si la FUENTE tiene español válido → conservar.
  // Si no → IMDb ES / TMDB ES. Si no hay fuente usable, aceptar meta (aunque sea inglés).
  var descFuente = item.descripcion || '';
  var descFuenteEs = descFuente.length >= 40 && pareceEspanol(descFuente)
    && !/\.\.\.\s*$/.test(descFuente) && !/^(Pel[ií]cula|Serie|Anime)\s/i.test(descFuente);
  var descFuenteOk = descFuente.length >= 40 && !/\.\.\.\s*$/.test(descFuente)
    && !/^(Pel[ií]cula|Serie|Anime)\s/i.test(descFuente) && !pareceIngles(descFuente);
  if (descFuenteEs || descFuenteOk) {
    // conservar fuente
  } else if (meta.descripcion) {
    if (pareceEspanol(meta.descripcion)) {
      item.descripcion = meta.descripcion;
    } else if (!pareceIngles(meta.descripcion)) {
      item.descripcion = meta.descripcion;
    } else {
      // Fuente sin sinopsis usable: usar meta aunque sea inglés (antes se dejaba vacío)
      var descCortaOVacia = !descFuente || descFuente.length < 40
        || (typeof esDescripcionBasura === 'function' && esDescripcionBasura(descFuente));
      if (descCortaOVacia) {
        item.descripcion = meta.descripcion;
      }
    }
  }
  // Si la fuente era inglesa y meta trae español, reemplazar
  if (pareceIngles(descFuente) && meta.descripcion && pareceEspanol(meta.descripcion)) {
    item.descripcion = meta.descripcion;
  }

  // Géneros: preferir IMDb (ya en español) si el match es bueno
  if (yearOkMeta && simOk && meta.generos && meta.generos.length) {
    item.generos = meta.generos;
    item.genero = meta.generos.join(', ');
  } else if (meta.generos && meta.generos.length && (!item.generos || !item.generos.length) && !item.genero) {
    item.generos = meta.generos;
    item.genero = meta.generos.join(', ');
  }

  // Año: la FUENTE manda. Meta solo si falta.
  if (!item.year) {
    if (meta.fecha_estreno) {
      item.fecha_estreno = meta.fecha_estreno;
      item.year = String(meta.fecha_estreno).slice(0, 4);
    } else if (meta.year) {
      item.year = String(meta.year).slice(0, 4);
    } else {
      var yFlex = extraerYearFlexible(item.titulo, item.slug, null);
      if (yFlex) item.year = yFlex;
    }
  } else if (!item.fecha_estreno && meta.fecha_estreno) {
    // Conservar year fuente; opcionalmente fecha si el año coincide
    var my = String(meta.fecha_estreno).slice(0, 4);
    if (String(item.year) === my) item.fecha_estreno = meta.fecha_estreno;
  }

  if (meta.duracion && !item.duracion) item.duracion = meta.duracion;
  if (meta.duracion_texto && !item.duracion_texto) item.duracion_texto = meta.duracion_texto;
  if (meta.certificacion && !item.certificacion) item.certificacion = meta.certificacion;
  if (meta.status) item.status = meta.status;
  if (meta.tagline) item.tagline = meta.tagline;

  return item;
}

/**
 * Variantes de query para maximizar hits en IMDb/OMDb.
 * Títulos JP largos: "One Piece 3D2Y: Ace no Shi wo Koete!..."
 * → "One Piece 3D2Y", "3D2Y", primeras palabras latinas, etc.
 */
function variantesTitulo(titulo) {
  var base = String(titulo || '')
    .replace(/\(\d{4}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return [];
  var out = [];
  function add(v) {
    v = String(v || '').replace(/\s+/g, ' ').trim();
    if (!v || v.length < 2) return;
    if (out.indexOf(v) === -1) out.push(v);
  }
  add(base);
  add(base.replace(/[！!？?¡¿]/g, ' '));
  add(base.replace(/\./g, ''));
  add(base.replace(/\bvs\.?\b/gi, ' '));
  add(base.split(/[:：]/)[0].trim());
  add(base.replace(/^(el|la|los|las|the|a|an)\s+/i, ''));

  // Códigos / subtítulos conocidos de franquicia
  var codeM = base.match(/\b(3[Dd]2[Yy]|Film\s*:?\s*Red|Film\s*:?\s*Gold|Film\s*:?\s*Z|Stampede|Strong World|Heart of Gold|Episode of [A-Za-z]+|Fan Letter|Heroines|Estampida)\b/i);
  if (codeM) {
    add('One Piece ' + codeM[1]);
    add(codeM[1]);
    if (/3[Dd]2[Yy]/i.test(codeM[1])) {
      add('One Piece 3D2Y');
      add('One Piece: 3D2Y');
    }
  }

  var words = base.split(/\s+/).filter(Boolean);
  var latinWords = words.filter(function (w) {
    return /[A-Za-z0-9]/.test(w) && !/^(no|wo|to|ni|ga|wa|de|o|e|na|mo)$/i.test(w);
  });
  if (latinWords.length >= 2) {
    add(latinWords.slice(0, 4).join(' '));
    add(latinWords.slice(0, 6).join(' '));
  }
  if (words.length > 3) {
    add(words.slice(0, 3).join(' '));
    add(words.slice(0, 5).join(' '));
  }
  var ascii = base.replace(/[^\x00-\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ascii && ascii !== base) add(ascii);

  return out;
}

function elegirMejorMeta(metas, titulo) {
  if (!metas || !metas.length) return null;
  var key = normalizarTituloKey(titulo);
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < metas.length; i++) {
    var k = normalizarTituloKey(metas[i].title || metas[i].titulo || metas[i].Title || '');
    var score = 0;
    if (k === key) score = 100;
    else if (k.indexOf(key) !== -1 || key.indexOf(k) !== -1) score = 50;
    else {
      var a = key.split(' ');
      var b = k.split(' ');
      var common = 0;
      for (var ti = 0; ti < a.length; ti++) {
        if (a[ti].length > 2 && b.indexOf(a[ti]) !== -1) common++;
      }
      score = common * 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = metas[i];
    }
  }
  if (!best || bestScore < 10) return null;
  return best;
}

/** OMDb (fallback gratuito). Posters de Amazon se tratan como portada_imdb. */
async function buscarMetaOmdb(titulo) {
  var q = String(titulo || '').replace(/\(\d{4}\)/g, '').trim();
  if (!q) return null;
  try {
    var url = 'https://www.omdbapi.com/?t=' + encodeURIComponent(q) + '&apikey=' + encodeURIComponent(__OMDB_KEY__) + '&plot=full';
    var res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    var d = await res.json();
    if (!d || d.Response === 'False') return null;
    var genres = d.Genre ? d.Genre.split(',').map(function (g) { return g.trim(); }) : [];
    var year = d.Year ? String(d.Year).slice(0, 4) : null;
    var released = d.Released && d.Released !== 'N/A' ? d.Released : null;
    var fecha = null;
    if (released) {
      var dt = new Date(released);
      if (!isNaN(dt.getTime())) fecha = dt.toISOString().slice(0, 10);
    }
    var posterRaw = d.Poster && d.Poster !== 'N/A' ? d.Poster : null;
    var posterNorm = posterRaw ? (typeof normalizarPosterImdb === 'function' ? normalizarPosterImdb(posterRaw) : posterRaw) : null;
    var esAmazon = posterNorm && /media-amazon|amazon\.com/i.test(posterNorm);
    return {
      tmdb_id: null,
      imdb_id: d.imdbID || null,
      titulo_tmdb: d.Title || q,
      // Amazon poster = calidad IMDb
      portada_tmdb: esAmazon ? null : posterNorm,
      portada_imdb: esAmazon ? posterNorm : null,
      backdrop: null,
      calificacion: d.imdbRating && d.imdbRating !== 'N/A' ? Number(d.imdbRating) : null,
      descripcion: d.Plot && d.Plot !== 'N/A' ? d.Plot : null,
      generos: genres,
      fecha_estreno: fecha,
      year: year,
      titulo_original: d.Title || null,
      votos: d.imdbVotes && d.imdbVotes !== 'N/A' ? d.imdbVotes : null,
      duracion: d.Runtime && d.Runtime !== 'N/A' ? parseInt(d.Runtime, 10) || null : null,
      status: null,
      tagline: null,
      slug_tmdb: null
    };
  } catch (e) {
    return null;
  }
}

/**
 * Mejora URL de poster IMDb/Amazon a tamaño usable (~500px de alto).
 */
function normalizarPosterImdb(url) {
  if (!url || typeof url !== 'string') return null;
  var u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  // Quitar parámetros de tamaño rotos y forzar versión limpia
  u = u.replace(/\._V1_.*?(?=\.jpg|\.png|\.webp|$)/i, '._V1_');
  if (/\._V1_\.(jpg|png|webp)/i.test(u)) {
    u = u.replace(/\._V1_\.(jpg|png|webp)/i, '._V1_UX380_CR0,0,380,562_.$1');
  } else if (!/\._V1_/i.test(u) && /media-amazon\.com\/images/i.test(u)) {
    u = u.replace(/\.(jpg|png|webp)(\?|$)/i, '._V1_UX380_CR0,0,380,562_.$1');
  }
  return u;
}

/** Similitud simple entre sinopsis (0–1) para cruzar la obra correcta en IMDb */
function similitudDescripcion(a, b) {
  var sa = normalizarTituloKey(String(a || '').replace(/[^\wáéíóúñü\s]/gi, ' '));
  var sb = normalizarTituloKey(String(b || '').replace(/[^\wáéíóúñü\s]/gi, ' '));
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  var wa = sa.split(/\s+/).filter(function (w) { return w.length >= 4; });
  var wb = sb.split(/\s+/).filter(function (w) { return w.length >= 4; });
  if (!wa.length || !wb.length) return 0;
  var setB = {};
  for (var i = 0; i < wb.length; i++) setB[wb[i]] = true;
  var shared = 0;
  for (var j = 0; j < wa.length; j++) if (setB[wa[j]]) shared++;
  return shared / Math.max(wa.length, wb.length);
}

/** Traduce géneros IMDb/OMDb al español */
function generosAEspanol(lista) {
  if (!Array.isArray(lista)) return [];
  var map = {
    action: 'Acción', adventure: 'Aventura', animation: 'Animación',
    biography: 'Biografía', comedy: 'Comedia', crime: 'Crimen',
    documentary: 'Documental', drama: 'Drama', family: 'Familia',
    fantasy: 'Fantasía', 'film-noir': 'Cine negro', history: 'Historia',
    horror: 'Terror', music: 'Música', musical: 'Musical',
    mystery: 'Misterio', romance: 'Romance', 'sci-fi': 'Ciencia ficción',
    sport: 'Deporte', thriller: 'Suspenso', war: 'Bélica', western: 'Western',
    'short': 'Cortometraje', news: 'Noticias', reality: 'Reality',
    'talk-show': 'Talk show', 'game-show': 'Concurso'
  };
  return lista.map(function (g) {
    var k = String(g || '').toLowerCase().trim();
    return map[k] || (g && String(g).charAt(0).toUpperCase() + String(g).slice(1)) || null;
  }).filter(Boolean);
}

/**
 * Ficha IMDb en español: https://www.imdb.com/es/title/ttXXXX/
 * Extrae: calificación, votos, duración (1h 31min), certificado (B15), géneros, sinopsis ES
 */
async function scrapeFichaImdbEs(imdbId) {
  if (!imdbId || String(imdbId).indexOf('tt') !== 0) return null;
  var urls = [
    'https://www.imdb.com/es/title/' + imdbId + '/',
    'https://www.imdb.com/title/' + imdbId + '/?languages=es-ES'
  ];
  var headersImdb = {
    'User-Agent': HEADERS['User-Agent'],
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
    'Accept': 'text/html,application/xhtml+xml',
    'Referer': 'https://www.imdb.com/es/'
  };
  for (var u = 0; u < urls.length; u++) {
    try {
      var res = await fetchWithTimeout(urls[u], { headers: headersImdb, redirect: 'follow' }, 10000);
      if (!res || !res.ok) continue;
      var html = await res.text();
      if (!html || html.length < 800) continue;

      var out = {
        imdb_id: imdbId,
        calificacion: null,
        votos: null,
        duracion: null,
        duracion_texto: null,
        certificacion: null,
        generos: [],
        descripcion: null,
        year: null,
        titulo_original: null,
        status: null
      };

      // JSON-LD
      var ldMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch) {
        try {
          var ld = JSON.parse(ldMatch[1]);
          if (Array.isArray(ld)) {
            for (var li = 0; li < ld.length; li++) {
              if (ld[li] && (ld[li]['@type'] === 'Movie' || ld[li]['@type'] === 'TVSeries' || ld[li].aggregateRating)) {
                ld = ld[li];
                break;
              }
            }
          }
          if (ld) {
            if (ld.aggregateRating) {
              if (ld.aggregateRating.ratingValue != null) {
                out.calificacion = normalizarCalificacion(ld.aggregateRating.ratingValue);
              }
              if (ld.aggregateRating.ratingCount != null) {
                out.votos = String(ld.aggregateRating.ratingCount);
              }
            }
            if (ld.duration) {
              // PT1H31M → minutos
              var dm = String(ld.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
              if (dm) {
                var mins = (parseInt(dm[1] || 0, 10) * 60) + parseInt(dm[2] || 0, 10);
                if (mins > 0) {
                  out.duracion = mins;
                  var h = Math.floor(mins / 60);
                  var m = mins % 60;
                  out.duracion_texto = h > 0 ? (h + 'h ' + m + 'min') : (m + 'min');
                }
              }
            }
            if (ld.contentRating) out.certificacion = String(ld.contentRating).trim();
            if (ld.genre) {
              var gens = Array.isArray(ld.genre) ? ld.genre : [ld.genre];
              out.generos = generosAEspanol(gens);
            }
            if (ld.description) out.descripcion = limpiarTexto(ld.description);
            if (ld.datePublished) {
              var yld = String(ld.datePublished).match(/(19|20)\d{2}/);
              if (yld) out.year = yld[0];
            }
            if (ld.alternateName) out.titulo_original = ld.alternateName;
            else if (ld.name) out.titulo_original = ld.name;
          }
        } catch (eLd) { /* ok */ }
      }

      // Rating visible: data-testid / hero-rating
      if (out.calificacion == null) {
        var rm = html.match(/hero-rating-bar__aggregate-rating__score[^>]*>[\s\S]*?<span[^>]*>\s*(\d+[.,]\d+)\s*</i)
          || html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)"?/i)
          || html.match(/aggregateRating[\s\S]{0,120}"ratingValue"\s*:\s*"?(\d+\.?\d*)"?/i);
        if (rm) out.calificacion = normalizarCalificacion(rm[1]);
      }
      if (!out.votos) {
        var vm = html.match(/"ratingCount"\s*:\s*"?(\d+)"?/i)
          || html.match(/([\d\.,]+)\s*(?:votos|votes)/i);
        if (vm) out.votos = String(vm[1]).replace(/[^\d]/g, '');
      }

      // Certificación: B15, PG-13, R, TV-MA…
      if (!out.certificacion) {
        var cm = html.match(/data-testid=["']storyline-certificate["'][^>]*>[\s\S]*?<a[^>]*>\s*([^<]+)/i)
          || html.match(/["']certificate["']\s*:\s*\{\s*["']rating["']\s*:\s*["']([^"']+)["']/i)
          || html.match(/class=["'][^"']*ipc-metadata-list-item__list-content-item[^"']*["'][^>]*>\s*((?:B\d+|AA|A|C|D|PG-?13?|R|NC-?17|TV-[\w-]+|G|NR))\s*</i);
        if (cm) out.certificacion = limpiarTexto(cm[1]);
      }

      // Duración texto: 1h 31min
      if (!out.duracion_texto) {
        var tm = html.match(/data-testid=["']title-techspec_runtime["'][\s\S]{0,200}?(\d+\s*h(?:oras?)?\s*\d+\s*min)/i)
          || html.match(/>(\d+\s*h\s*\d+\s*min)</i)
          || html.match(/"duration"\s*:\s*"PT(\d+)H(\d+)M"/i);
        if (tm) {
          if (tm[2] != null && tm[0].indexOf('PT') !== -1) {
            out.duracion = parseInt(tm[1], 10) * 60 + parseInt(tm[2], 10);
            out.duracion_texto = tm[1] + 'h ' + tm[2] + 'min';
          } else {
            out.duracion_texto = limpiarTexto(tm[1] || tm[0]);
            var pm = out.duracion_texto.match(/(\d+)\s*h.*?(\d+)\s*min/i);
            if (pm) out.duracion = parseInt(pm[1], 10) * 60 + parseInt(pm[2], 10);
          }
        }
      }

      // Géneros desde chips
      if (!out.generos.length) {
        var gre = /href=["']\/search\/title\/\?genres=([^"'&]+)[^"']*["'][^>]*>([^<]+)</gi;
        var gm;
        var seenG = {};
        while ((gm = gre.exec(html)) !== null && out.generos.length < 8) {
          var gn = limpiarTexto(gm[2]);
          var gk = gn.toLowerCase();
          if (!gn || seenG[gk]) continue;
          seenG[gk] = true;
          out.generos.push(gn);
        }
        if (out.generos.length) out.generos = generosAEspanol(out.generos);
      }

      // Plot / sinopsis en español
      if (!out.descripcion || pareceIngles(out.descripcion)) {
        var pm2 = html.match(/data-testid=["']plot-l["'][^>]*>([\s\S]*?)<\//i)
          || html.match(/data-testid=["']plot-xl["'][^>]*>([\s\S]*?)<\//i)
          || html.match(/class=["'][^"']*ipc-html-content-inner-div[^"']*["'][^>]*>([\s\S]{40,600}?)<\//i);
        if (pm2) {
          var plot = limpiarTexto(pm2[1].replace(/<[^>]+>/g, ' '));
          if (plot.length >= 40) out.descripcion = plot;
        }
      }


      // Estado serie (IMDb): "TV Series (2023– )" = en emisión; "(2023–2024)" = finalizado
      if (!out.status) {
        var stm = html.match(/TV Series\s*\(\s*((?:19|20)\d{2})\s*[–—\-]\s*((?:19|20)\d{2})?\s*\)/i)
          || html.match(/Serie de TV\s*\(\s*((?:19|20)\d{2})\s*[–—\-]\s*((?:19|20)\d{2})?\s*\)/i)
          || html.match(/Mini[\- ]?Serie(?:s)?\s*\(\s*((?:19|20)\d{2})\s*[–—\-]\s*((?:19|20)\d{2})?\s*\)/i);
        if (stm) {
          out.status = stm[2] ? 'Ended' : 'Returning Series';
        }
      }

      if (out.calificacion != null || out.descripcion || out.duracion || out.certificacion) {
        return out;
      }
    } catch (eSc) { /* next url */ }
  }
  return null;
}

/**
 * IMDb vía API de sugerencias (JSON público) + ficha ES + OMDb.
 * opts.descripcionHint: sinopsis de la fuente para elegir el tt correcto (homónimos).
 * Prioridad de portadas: imageUrl de suggestion → OMDb → ficha.
 */
/**
 * MyAnimeList vía Jikan (gratis, sin key). Solo se usa para tipo Anime,
 * como primer intento antes de IMDb, porque MAL indexa el título
 * romanizado japonés que usan las fuentes (animeav1/lamovie), mientras
 * que IMDb/TMDB suelen tener solo el título oficial en inglés.
 */
async function buscarMetaMal(titulo, yearHint) {
  var q = String(titulo || '').replace(/\(\d{4}\)/g, '').trim();
  if (!q) return null;
  try {
    var url = 'https://api.jikan.moe/v4/anime?q=' + encodeURIComponent(q) + '&limit=5';
    var res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 9000);
    if (!res.ok) return null;
    var data = await res.json();
    var results = Array.isArray(data.data) ? data.data : [];
    if (!results.length) return null;

    var wantedTitle = normalizarTituloKey(q);
    var wantedYearMatch = yearHint ? String(yearHint).match(/(19|20)\d{2}/) : null;
    var wantedYear = wantedYearMatch ? wantedYearMatch[0] : null;

    var best = null, bestScore = -999;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var candidatos = [r.title, r.title_english, r.title_japanese].filter(Boolean);
      var score = -999;
      for (var c = 0; c < candidatos.length; c++) {
        var ct = normalizarTituloKey(candidatos[c]);
        var s = 0;
        if (ct === wantedTitle) s = 100;
        else if (ct && (ct.indexOf(wantedTitle) !== -1 || wantedTitle.indexOf(ct) !== -1)) s = 50;
        if (s > score) score = s;
      }
      var ry = r.aired && r.aired.from ? String(r.aired.from).slice(0, 4) : (r.year ? String(r.year) : null);
      if (wantedYear && ry && wantedYear !== ry) score -= 60;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < 40) return null;

    var genres = (best.genres || []).map(function (g) { return g.name; }).filter(Boolean);
    var poster = best.images && best.images.jpg ? (best.images.jpg.large_image_url || best.images.jpg.image_url) : null;
    var fecha = best.aired && best.aired.from ? String(best.aired.from).slice(0, 10) : null;
    var year = fecha ? fecha.slice(0, 4) : (best.year ? String(best.year) : null);

    return {
      mal_id: best.mal_id || null,
      tmdb_id: null,
      imdb_id: null,
      titulo_tmdb: best.title || q,
      portada_tmdb: null,
      portada_imdb: poster,
      backdrop: null,
      calificacion: best.score != null ? Number(best.score) : null,
      descripcion: best.synopsis || null,
      generos: genres,
      fecha_estreno: fecha,
      year: year,
      titulo_original: best.title_japanese || best.title || null,
      votos: best.scored_by != null ? String(best.scored_by).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : null,
      duracion: null,
      duracion_texto: best.duration || null,
      certificacion: best.rating || null,
      status: best.status || null,
      tagline: null,
      slug_tmdb: null
    };
  } catch (e) {
    return null;
  }
}

async function buscarMetaImdb(titulo, tipoHint, yearHint, opts) {
  opts = opts || {};
  var descHint = opts.descripcionHint || opts.descripcion || null;
  var lightImdb = !!opts.light;
  var q = String(titulo || '').trim();
  if (!q) return null;

  var wantedTitle = normalizarTituloKey(q);
  var wantedYearMatch = yearHint ? String(yearHint).match(/(19|20)\d{2}/) : q.match(/\b(19|20)\d{2}\b/);
  var wantedYear = wantedYearMatch ? wantedYearMatch[0] : null;
  var wantedType = normalizarTipoKey(tipoHint);
  var wantedIsTv = wantedType === 'serie' || wantedType === 'anime';

  // Tokens de franquicia genéricos: NO bastan para asignar portada
  var FRANQUICIA_STOP = {
    one:1, piece:1, the:1, and:1, film:1, movie:1, special:1, episode:1,
    anime:1, series:1, season:1, part:1, vol:1, volume:1
  };

  function tokensDistintivos(t) {
    return String(t || '').split(/\s+/).filter(function (w) {
      return w.length >= 3 && !FRANQUICIA_STOP[w];
    });
  }

  function scoreSug(item) {
    if (!item || !item.id || String(item.id).indexOf('tt') !== 0) return -999;
    var ct = normalizarTituloKey(item.l || item.titulo || '');
    if (!ct) return -999;
    var score = 0;
    var y = item.y ? String(item.y) : null;

    // Título exacto
    if (ct === wantedTitle) {
      score += 200;
      // Sin año pedido: preferir estrenos recientes (evita remakes viejos tipo "La captura" 2012 vs 2026)
      if (!wantedYear && y) {
        var yNum = parseInt(y, 10);
        if (yNum >= 2020) score += 40;
        else if (yNum >= 2010) score += 10;
        else score -= 30;
      }
    } else {
      var wantExtra = tokensDistintivos(wantedTitle);
      var candExtra = tokensDistintivos(ct);

      // Si el pedido tiene palabras distintivas (red, heroines, 3d2y, stampede…)
      // el candidato DEBE compartirlas; si no → rechazo fuerte
      if (wantExtra.length) {
        var shared = 0;
        for (var wi = 0; wi < wantExtra.length; wi++) {
          if (ct.indexOf(wantExtra[wi]) !== -1) shared++;
        }
        if (shared === 0) {
          // Ej: pedido "one piece film red" vs candidato "one piece" → NO
          return -500;
        }
        score += shared * 50;
        // Penalizar si el candidato tiene extras que el pedido no tiene
        for (var ci = 0; ci < candExtra.length; ci++) {
          if (wantedTitle.indexOf(candExtra[ci]) === -1) score -= 25;
        }
      } else {
        // Pedido genérico "one piece": preferir candidato SIN extras de obra
        if (candExtra.length === 0 && ct === wantedTitle) score += 200;
        else if (candExtra.length === 0 || ct === wantedTitle) score += 120;
        else {
          // Candidato es un special/film → no usar para el título base
          score -= 80;
        }
      }

      // Prefijo solo si es casi el mismo título (diferencia mínima)
      if (ct.indexOf(wantedTitle) === 0 || wantedTitle.indexOf(ct) === 0) {
        var longer = ct.length >= wantedTitle.length ? ct : wantedTitle;
        var shorter = ct.length >= wantedTitle.length ? wantedTitle : ct;
        var rest = longer.slice(shorter.length).trim();
        if (!rest || /^\d{4}$/.test(rest)) score += 40;
        else score -= 30; // "one piece" vs "one piece film red"
      }
    }

    if (wantedYear && y) {
      if (wantedYear === y) score += 120;
      else return -999; // año distinto = otra obra (La captura 2012 ≠ 2026)
    }
    var qid = String(item.qid || item.q || '').toLowerCase();
    var isTv = /tvseries|tvminiseries|tvspecial|tvmovie/.test(qid);
    var isMovie = /movie|feature|video|short/.test(qid);
    if (wantedIsTv && isTv) score += 30;
    if (wantedIsTv && isMovie) score -= 60;
    if (wantedType === 'pelicula' && isMovie) score += 30;
    if (wantedType === 'pelicula' && isTv) score -= 60;
    if (item.rank && item.rank < 5000) score += 10;
    return score;
  }

  // --- 1) API de sugerencias IMDb (rápida y fiable) ---
  try {
    var letter = (q.replace(/[^a-zA-Z0-9]/g, '') || 'x').charAt(0).toLowerCase();
    // Slug: minúsculas, espacios → _, solo alfanuméricos (formato oficial del typeahead)
    var slugSug = q.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'x';
    var sugUrl = 'https://v3.sg.media-imdb.com/suggestion/' + letter + '/' + slugSug + '.json';
    var resSug = await fetch(sugUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (resSug.ok) {
      var sugData = await resSug.json();
      var list = (sugData && Array.isArray(sugData.d)) ? sugData.d : [];
      var scored = [];
      for (var si = 0; si < list.length; si++) {
        var it = list[si];
        if (!it || !it.id || String(it.id).indexOf('tt') !== 0) continue;
        var sc = scoreSug(it);
        var sameYear = wantedYear && it.y && String(it.y) === String(wantedYear);
        // Título débil pero mismo año: incluir (ej. "La captura" → "Facing El Chapo" 2026)
        if (sc < 70 && !sameYear) continue;
        if (sc < -500 && !sameYear) continue;
        scored.push({ item: it, score: sameYear && sc < 70 ? Math.max(sc, 40) : sc, sameYear: !!sameYear });
      }
      scored.sort(function (a, b) { return b.score - a.score; });

      if (scored.length) {
        // Top por score + todos los del mismo año (homónimos / título distinto en IMDb)
        var topN = scored.slice(0, Math.min(6, scored.length));
        for (var sy = 0; sy < scored.length; sy++) {
          if (scored[sy].sameYear) {
            var already = false;
            for (var ak = 0; ak < topN.length; ak++) {
              if (topN[ak].item.id === scored[sy].item.id) { already = true; break; }
            }
            if (!already) topN.push(scored[sy]);
          }
        }
        var bestPick = null;
        var bestSim = 0;

        for (var ti = 0; ti < topN.length; ti++) {
          var cand = topN[ti];
          var cy = cand.item.y ? String(cand.item.y) : null;
          var adj = cand.score;
          if (wantedYear && cy && wantedYear !== cy) {
            cand._skip = true;
            continue;
          }
          var plotCand = null;
          var omdbCand = null;
          try {
            var oUrl = 'https://www.omdbapi.com/?i=' + encodeURIComponent(cand.item.id) + '&apikey=' + encodeURIComponent(__OMDB_KEY__) + '&plot=full';
            var oRes = await fetch(oUrl, { headers: { Accept: 'application/json' } });
            if (oRes.ok) {
              omdbCand = await oRes.json();
              if (omdbCand && omdbCand.Response !== 'False') {
                plotCand = omdbCand.Plot && omdbCand.Plot !== 'N/A' ? omdbCand.Plot : null;
              }
            }
          } catch (eOc) { /* ok */ }
          // Si OMDb falla, usar ficha ES para plot (omitir en modo light)
          if (!plotCand && !lightImdb) {
            try {
              var fTmp = await scrapeFichaImdbEs(cand.item.id);
              if (fTmp) {
                cand._ficha = fTmp;
                plotCand = fTmp.descripcion || null;
              }
            } catch (eFt) { /* ok */ }
          }
          cand._omdb = omdbCand;
          cand._plot = plotCand;

          if (descHint && plotCand) {
            var sim = similitudDescripcion(descHint, plotCand);
            cand._sim = sim;
            if (sim >= 0.25) adj += 100 + Math.round(sim * 50);
            else if (sim >= 0.12) adj += 40;
            else if (descHint.length > 50 && sim < 0.08) adj -= 40;
          }
          // Mismo año que la fuente: bonus (título local ≠ título IMDb)
          if (cand.sameYear) adj += 60;
          if (!wantedYear && cy && descHint) {
            var yn = parseInt(cy, 10);
            if (yn >= 2023) adj += 25;
            else if (yn < 2015) adj -= 20;
          }
          cand._adj = adj;
          if (!bestPick || adj > (bestPick._adj || -9999)) {
            bestPick = cand;
            bestSim = cand._sim || 0;
          }
        }

        if (bestPick && !bestPick._skip) {
          var best = bestPick.item;
          var extra = bestPick._omdb || null;
          var poster = null;
          if (best.i && best.i.imageUrl) poster = normalizarPosterImdb(best.i.imageUrl);
          if ((!poster || /N\/A/i.test(poster)) && extra && extra.Poster && extra.Poster !== 'N/A') {
            poster = normalizarPosterImdb(extra.Poster);
          }
          var y = best.y ? String(best.y) : (extra && extra.Year ? String(extra.Year).slice(0, 4) : null);

          // Ficha IMDb ES: rating oficial, B15, 1h 31min, géneros, plot español
          // En modo light (listados) se omite para no saturar el Worker
          var ficha = null;
          if (!lightImdb) {
            try {
              ficha = await scrapeFichaImdbEs(best.id);
            } catch (eF) { ficha = null; }
          }

          var generos = [];
          if (ficha && ficha.generos && ficha.generos.length) generos = ficha.generos;
          else if (extra && extra.Genre) {
            generos = generosAEspanol(extra.Genre.split(',').map(function (g) { return g.trim(); }));
          }

          var calif = null;
          if (ficha && ficha.calificacion != null) calif = ficha.calificacion;
          else if (extra && extra.imdbRating && extra.imdbRating !== 'N/A') calif = normalizarCalificacion(extra.imdbRating);

          var descOut = null;
          if (ficha && ficha.descripcion && pareceEspanol(ficha.descripcion)) descOut = ficha.descripcion;
          else if (ficha && ficha.descripcion) descOut = ficha.descripcion;
          else if (extra && extra.Plot && extra.Plot !== 'N/A') descOut = extra.Plot;

          // Si la fuente ya tiene sinopsis y no se parece al plot IMDb → no pisar datos de otra obra
          if (descHint && descOut && similitudDescripcion(descHint, descOut) < 0.12 && descHint.length > 60) {
            // Mantener rating/cert solo si year coincide; si yearHint no hay, desconfiar
            if (wantedYear && y && wantedYear === y) {
              /* ok mismo año */
            } else if (!wantedYear && bestSim < 0.12) {
              // Homónimo dudoso: devolver solo portada si hay, sin rating/year equivocado
              return {
                tmdb_id: null,
                imdb_id: best.id,
                titulo_tmdb: best.l || q,
                portada_tmdb: null,
                portada_imdb: poster,
                backdrop: null,
                calificacion: null,
                descripcion: null,
                generos: [],
                fecha_estreno: null,
                year: null,
                titulo_original: best.l || q,
                votos: null,
                duracion: null,
                duracion_texto: null,
                certificacion: null,
                status: null,
                tagline: null,
                slug_tmdb: null
              };
            }
          }

          return {
            tmdb_id: null,
            imdb_id: best.id,
            titulo_tmdb: best.l || q,
            portada_tmdb: null,
            portada_imdb: poster,
            backdrop: null,
            calificacion: calif,
            descripcion: descOut,
            generos: generos,
            fecha_estreno: (extra && extra.Released && extra.Released !== 'N/A')
              ? (function () {
                  var dt = new Date(extra.Released);
                  return !isNaN(dt.getTime()) ? dt.toISOString().slice(0, 10) : (y ? y + '-01-01' : null);
                })()
              : (y ? y + '-01-01' : null),
            year: (ficha && ficha.year) || y,
            titulo_original: (ficha && ficha.titulo_original) || best.l || q,
            votos: (ficha && ficha.votos) || (extra && extra.imdbVotes && extra.imdbVotes !== 'N/A' ? extra.imdbVotes : null),
            duracion: (ficha && ficha.duracion) || (extra && extra.Runtime && extra.Runtime !== 'N/A' ? parseInt(extra.Runtime, 10) || null : null),
            duracion_texto: (ficha && ficha.duracion_texto) || null,
            certificacion: (ficha && ficha.certificacion) || (extra && extra.Rated && extra.Rated !== 'N/A' ? extra.Rated : null),
            status: (ficha && ficha.status) || null,
            tagline: null,
            slug_tmdb: null
          };
        }
      }
    }
  } catch (eSug) { /* fallback HTML abajo */ }

  // --- 1b) OMDb por título + año (cubre "La captura" 2026 indexada con otro nombre) ---
  if (wantedYear) {
    try {
      var omdbByYear = 'https://www.omdbapi.com/?t=' + encodeURIComponent(q) +
        '&y=' + encodeURIComponent(wantedYear) + '&apikey=' + encodeURIComponent(__OMDB_KEY__) + '&plot=full';
      var oY = await fetch(omdbByYear, { headers: { Accept: 'application/json' } });
      if (oY.ok) {
        var odY = await oY.json();
        if (odY && odY.Response !== 'False' && odY.imdbID) {
          var yOd = odY.Year ? String(odY.Year).slice(0, 4) : null;
          if (!yOd || yOd === wantedYear) {
            var fichaY = null;
            try { fichaY = await scrapeFichaImdbEs(odY.imdbID); } catch (eFy) { fichaY = null; }
            var posterY = odY.Poster && odY.Poster !== 'N/A' ? normalizarPosterImdb(odY.Poster) : null;
            return {
              tmdb_id: null,
              imdb_id: odY.imdbID,
              titulo_tmdb: odY.Title || q,
              portada_tmdb: null,
              portada_imdb: posterY,
              backdrop: null,
              calificacion: (fichaY && fichaY.calificacion != null)
                ? fichaY.calificacion
                : (odY.imdbRating && odY.imdbRating !== 'N/A' ? normalizarCalificacion(odY.imdbRating) : null),
              descripcion: (fichaY && fichaY.descripcion) || (odY.Plot && odY.Plot !== 'N/A' ? odY.Plot : null),
              generos: (fichaY && fichaY.generos && fichaY.generos.length)
                ? fichaY.generos
                : generosAEspanol(odY.Genre ? odY.Genre.split(',').map(function (g) { return g.trim(); }) : []),
              fecha_estreno: null,
              year: yOd || wantedYear,
              titulo_original: odY.Title || null,
              votos: (fichaY && fichaY.votos) || (odY.imdbVotes && odY.imdbVotes !== 'N/A' ? odY.imdbVotes : null),
              duracion: (fichaY && fichaY.duracion) || (odY.Runtime && odY.Runtime !== 'N/A' ? parseInt(odY.Runtime, 10) || null : null),
              duracion_texto: (fichaY && fichaY.duracion_texto) || null,
              certificacion: (fichaY && fichaY.certificacion) || (odY.Rated && odY.Rated !== 'N/A' ? odY.Rated : null),
              status: null,
              tagline: null,
              slug_tmdb: null
            };
          }
        }
      }
      // Búsqueda listado OMDb filtrada por año
      var omdbSearch = 'https://www.omdbapi.com/?s=' + encodeURIComponent(q) + '&type=movie&apikey=' + encodeURIComponent(__OMDB_KEY__) + '';
      var oS = await fetch(omdbSearch, { headers: { Accept: 'application/json' } });
      if (oS.ok) {
        var odS = await oS.json();
        var listS = (odS && Array.isArray(odS.Search)) ? odS.Search : [];
        for (var si2 = 0; si2 < listS.length; si2++) {
          var row = listS[si2];
          if (!row || !row.imdbID) continue;
          var yr = row.Year ? String(row.Year).slice(0, 4) : null;
          if (yr && yr !== wantedYear) continue;
          var omdbUrl3 = 'https://www.omdbapi.com/?i=' + encodeURIComponent(row.imdbID) + '&apikey=' + encodeURIComponent(__OMDB_KEY__) + '&plot=full';
          var oR3 = await fetch(omdbUrl3, { headers: { Accept: 'application/json' } });
          if (!oR3.ok) continue;
          var od3 = await oR3.json();
          if (!od3 || od3.Response === 'False') continue;
          var ficha3 = null;
          try { ficha3 = await scrapeFichaImdbEs(row.imdbID); } catch (e3) { ficha3 = null; }
          var poster3 = od3.Poster && od3.Poster !== 'N/A' ? normalizarPosterImdb(od3.Poster) : null;
          return {
            tmdb_id: null,
            imdb_id: row.imdbID,
            titulo_tmdb: od3.Title || row.Title || q,
            portada_tmdb: null,
            portada_imdb: poster3,
            backdrop: null,
            calificacion: (ficha3 && ficha3.calificacion != null)
              ? ficha3.calificacion
              : (od3.imdbRating && od3.imdbRating !== 'N/A' ? normalizarCalificacion(od3.imdbRating) : null),
            descripcion: (ficha3 && ficha3.descripcion) || (od3.Plot && od3.Plot !== 'N/A' ? od3.Plot : null),
            generos: (ficha3 && ficha3.generos && ficha3.generos.length)
              ? ficha3.generos
              : generosAEspanol(od3.Genre ? od3.Genre.split(',').map(function (g) { return g.trim(); }) : []),
            fecha_estreno: null,
            year: yr || wantedYear,
            titulo_original: od3.Title || null,
            votos: (ficha3 && ficha3.votos) || (od3.imdbVotes && od3.imdbVotes !== 'N/A' ? od3.imdbVotes : null),
            duracion: (ficha3 && ficha3.duracion) || (od3.Runtime && od3.Runtime !== 'N/A' ? parseInt(od3.Runtime, 10) || null : null),
            duracion_texto: (ficha3 && ficha3.duracion_texto) || null,
            certificacion: (ficha3 && ficha3.certificacion) || (od3.Rated && od3.Rated !== 'N/A' ? od3.Rated : null),
            status: null,
            tagline: null,
            slug_tmdb: null
          };
        }
      }
    } catch (eOy) { /* ok */ }
  }

  // --- 2) Fallback HTML (puede fallar en Workers por bloqueo IMDb) ---
  var headersImdb = {
    'User-Agent': HEADERS['User-Agent'],
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
    'Accept': 'text/html,application/xhtml+xml'
  };

  function limpiarHtmlTexto(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  try {
    var findUrl = 'https://www.imdb.com/find/?q=' + encodeURIComponent(q) + '&s=tt';
    var resFind = await fetchWithTimeout(findUrl, { headers: headersImdb, redirect: 'follow' }, 8000);
    if (!resFind || !resFind.ok) return null;
    var htmlFind = await resFind.text();
    if (!htmlFind || htmlFind.length < 200) return null;

    var candidates = [];
    var seenIds = Object.create(null);
    var re = /\/title\/(tt\d+)\//gi;
    var m;
    while ((m = re.exec(htmlFind)) !== null && candidates.length < 15) {
      if (seenIds[m[1]]) continue;
      seenIds[m[1]] = true;
      candidates.push({ imdbId: m[1], titulo: q, year: null, isTv: null });
    }
    if (!candidates.length) return null;

    var cand = candidates[0];
    // Usar OMDb con el primer tt encontrado
    try {
      var omdbUrl2 = 'https://www.omdbapi.com/?i=' + encodeURIComponent(cand.imdbId) + '&apikey=' + encodeURIComponent(__OMDB_KEY__) + '&plot=full';
      var omdbRes2 = await fetch(omdbUrl2, { headers: { Accept: 'application/json' } });
      if (omdbRes2.ok) {
        var od2 = await omdbRes2.json();
        if (od2 && od2.Response !== 'False') {
          var poster2 = od2.Poster && od2.Poster !== 'N/A' ? normalizarPosterImdb(od2.Poster) : null;
          var y2 = od2.Year ? String(od2.Year).slice(0, 4) : null;
          if (wantedYear && y2 && wantedYear !== y2) return null;
          return {
            tmdb_id: null,
            imdb_id: od2.imdbID || cand.imdbId,
            titulo_tmdb: od2.Title || q,
            portada_tmdb: null,
            portada_imdb: poster2,
            backdrop: null,
            calificacion: od2.imdbRating && od2.imdbRating !== 'N/A' ? Number(od2.imdbRating) : null,
            descripcion: od2.Plot && od2.Plot !== 'N/A' ? od2.Plot : null,
            generos: od2.Genre ? od2.Genre.split(',').map(function (g) { return g.trim(); }) : [],
            fecha_estreno: null,
            year: y2,
            titulo_original: od2.Title || null,
            votos: od2.imdbVotes && od2.imdbVotes !== 'N/A' ? od2.imdbVotes : null,
            duracion: od2.Runtime && od2.Runtime !== 'N/A' ? parseInt(od2.Runtime, 10) || null : null,
            status: null,
            tagline: null,
            slug_tmdb: null
          };
        }
      }
    } catch (e2) { /* ok */ }
    return null;
  } catch (e) {
    return null;
  }
}

/** TMDB oficial si hay TMDB_API_KEY en el Worker */
async function buscarMetaTmdbApi(titulo, tipoHint, yearHint) {
  var key = __TMDB_KEY__ || null;
  if (!key) return null;
  var q = String(titulo || '').replace(/\(\d{4}\)/g, '').trim();
  if (!q) return null;

  try {
    var isTv = /serie|anime|tv/i.test(String(tipoHint || ''));
    var path = isTv ? 'search/tv' : 'search/movie';
    var url = 'https://api.themoviedb.org/3/' + path +
      '?api_key=' + encodeURIComponent(key) +
      '&language=es-ES&query=' + encodeURIComponent(q);
    var res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 9000);
    if (!res.ok) return null;
    var data = await res.json();
    var results = Array.isArray(data.results) ? data.results : [];

    // Si no encontró en el tipo esperado, probar el otro tipo.
    if (!results.length) {
      isTv = !isTv;
      path = isTv ? 'search/tv' : 'search/movie';
      url = 'https://api.themoviedb.org/3/' + path +
        '?api_key=' + encodeURIComponent(key) +
        '&language=es-ES&query=' + encodeURIComponent(q);
      res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 9000);
      if (res.ok) {
        data = await res.json();
        results = Array.isArray(data.results) ? data.results : [];
      }
    }
    if (!results.length) return null;

    var wantedTitle = normalizarTituloKey(q);
    var wantedYear = yearHint ? String(yearHint).match(/\d{4}/) : null;
    wantedYear = wantedYear ? wantedYear[0] : null;
    var best = null;
    var bestScore = -999;

    for (var ri = 0; ri < results.length; ri++) {
      var r = results[ri] || {};
      var candidateTitle = normalizarTituloKey(r.title || r.name || '');
      var release = r.release_date || r.first_air_date || '';
      var candidateYear = release ? String(release).slice(0, 4) : null;
      var score = 0;

      if (candidateTitle === wantedTitle) score += 100;
      else if (candidateTitle.indexOf(wantedTitle) !== -1 || wantedTitle.indexOf(candidateTitle) !== -1) score += 55;
      else {
        var wa = wantedTitle.split(' ').filter(function (x) { return x.length > 2; });
        var wb = candidateTitle.split(' ');
        var common = 0;
        for (var wi = 0; wi < wa.length; wi++) if (wb.indexOf(wa[wi]) !== -1) common++;
        score += common * 12;
      }

      if (wantedYear && candidateYear) {
        if (wantedYear === candidateYear) score += 45;
        else score -= 55;
      } else if (!wantedYear && candidateYear) {
        score += 3;
      }

      if (isTv && r.name) score += 8;
      if (!isTv && r.title) score += 8;
      if (r.poster_path) score += 5;
      if (r.overview) score += 3;
      if (r.vote_count) score += Math.min(5, Number(r.vote_count) > 100 ? 5 : 1);

      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    // No usar un resultado vagamente parecido.
    if (!best || bestScore < 45) return null;

    var title = best.title || best.name || q;
    var overview = best.overview || null;
    var poster = best.poster_path ? imgTmdb(best.poster_path, 'w500') : null;
    var backdrop = best.backdrop_path ? imgTmdb(best.backdrop_path, 'w780') : null;
    var release = best.release_date || best.first_air_date || null;

    var GENRE_MAP = {
      28: 'Acción', 12: 'Aventura', 16: 'Animación', 35: 'Comedia', 80: 'Crimen',
      99: 'Documental', 18: 'Drama', 10751: 'Familia', 14: 'Fantasía', 36: 'Historia',
      27: 'Terror', 10402: 'Música', 9648: 'Misterio', 10749: 'Romance', 878: 'Ciencia ficción',
      10770: 'Película de TV', 53: 'Suspenso', 10752: 'Bélica', 37: 'Western',
      10759: 'Action & Adventure', 10765: 'Sci-Fi & Fantasy'
    };
    var gens = (best.genre_ids || []).map(function (id) { return GENRE_MAP[id] || null; }).filter(Boolean);

    return {
      tmdb_id: best.id || null,
      imdb_id: null,
      titulo_tmdb: title,
      portada_tmdb: poster,
      backdrop: backdrop,
      calificacion: best.vote_average != null ? Number(best.vote_average) : null,
      descripcion: overview,
      generos: gens,
      fecha_estreno: release,
      year: release ? String(release).slice(0, 4) : null,
      titulo_original: best.original_title || best.original_name || null,
      votos: best.vote_count || null,
      duracion: null,
      status: null,
      tagline: null,
      slug_tmdb: null
    };
  } catch (e) {
    return null;
  }
}

var __TMDB_KEY__ = null; // se asigna en handleRequest desde env
var __OMDB_KEY__ = 'trilogy'; // se sobreescribe en handleRequest desde env.OMDB_API_KEY si existe

// ======================================================
// METADATA / PORTADAS ROBUSTAS
// ======================================================
// IMDb no requiere API key: se usa el HTML público como fuente de
// respaldo/prioridad de portada, especialmente para PelisPlus.
var __META_CACHE__ = Object.create(null);
var __META_CACHE_TTL__ = 15 * 60 * 1000;

function esPortadaUrlValida(url) {
  if (!url || typeof url !== 'string') return false;
  var u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/data:image|svg\+xml|favicon|placeholder/i.test(u)) return false;
  return true;
}

function esPortadaImdb(url) {
  if (!esPortadaUrlValida(url)) return false;
  // m.media-amazon.com, images-na.ssl-images-amazon.com, ia.media-imdb.com, etc.
  return /m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|ia\.media-imdb\.com|media-amazon\.com\/images/i.test(url);
}

function esFuentePelisplus(item) {
  if (!item) return false;
  var fuentes = Array.isArray(item.fuentes) ? item.fuentes : [];
  var f = String(item.fuente || '').toLowerCase();
  if (f === 'pelisplushd' || f === 'pelisplus' || f === '3') return true;
  for (var i = 0; i < fuentes.length; i++) {
    var x = String(fuentes[i] || '').toLowerCase();
    if (x === 'pelisplushd' || x === 'pelisplus' || x === '3') return true;
  }
  return false;
}

function esPortadaSospechosa(url) {
  if (!esPortadaUrlValida(url)) return true;
  var u = String(url).toLowerCase();
  if (esPortadaImdb(url)) return false;
  // PelisPlus / mirrors: portadas suelen venir rotas o genéricas
  if (/pelisplushd|pelisplus|image\.tmdb\.org\/t\/p\/w300/i.test(u)) return true;
  if (/media-amazon|amazon\.com/.test(u)) return true;
  if (/placeholder|no[-_ ]?poster|default[-_ ]?poster|poster[-_ ]?not[-_ ]?found/.test(u)) return true;
  return false;
}

/**
 * ¿El resultado de una fuente realmente corresponde a la búsqueda?
 * Evita que animeav1 “gane” con títulos irrelevantes cuando el query es un dorama/serie.
 * - Título normalizado idéntico → sí
 * - Todos los tokens del query (len>=3) aparecen en el título/slug → sí
 * - Prefijo del título con resto vacío o año → sí
 */
function resultadoRelevanteBusqueda(query, item) {
  if (!item) return false;
  var qKey = normalizarTituloKey(query || '');
  var tKey = normalizarTituloKey(item.titulo || '');
  var sKey = normalizarTituloKey(String(item.slug || '').replace(/-/g, ' '));
  if (!qKey) return false;
  if (tKey && tKey === qKey) return true;
  if (sKey && sKey === qKey) return true;

  var qTokens = qKey.split(/\s+/).filter(function (w) { return w.length >= 3; });
  if (!qTokens.length) {
    // query muy corto: exigir contención
    return (tKey && tKey.indexOf(qKey) !== -1) || (sKey && sKey.indexOf(qKey) !== -1);
  }
  function contieneTodos(txt) {
    if (!txt) return false;
    for (var i = 0; i < qTokens.length; i++) {
      if (txt.indexOf(qTokens[i]) === -1) return false;
    }
    return true;
  }
  if (contieneTodos(tKey) || contieneTodos(sKey)) return true;

  // Prefijo casi exacto (solo año residual)
  if (tKey && (tKey.indexOf(qKey) === 0 || qKey.indexOf(tKey) === 0)) {
    var longer = tKey.length >= qKey.length ? tKey : qKey;
    var shorter = tKey.length >= qKey.length ? qKey : tKey;
    var rest = longer.slice(shorter.length).trim();
    if (!rest || /^\d{4}$/.test(rest)) return true;
  }
  return false;
}

/** Deduplica resultados de UNA sola fuente por slug normalizado */
function dedupePorSlugFuente(items) {
  if (!items || !items.length) return [];
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    var k = normalizarSlugKey(it.slug || '') || normalizarTituloKey(it.titulo || '');
    if (!k) { out.push(it); continue; }
    if (seen[k] !== undefined) {
      // Conservar el que tenga portada
      var prev = out[seen[k]];
      if (prev && (!prev.portada || esPortadaSospechosa(prev.portada)) && it.portada && !esPortadaSospechosa(it.portada)) {
        out[seen[k]] = it;
      }
      continue;
    }
    seen[k] = out.length;
    out.push(it);
  }
  return out;
}

/**
 * Prioridad de portadas (todas las fuentes):
 * 1) IMDb — la más fiable
 * 2) animeav1 / lamovie / doramasflix (poster bueno de la fuente)
 * 3) TMDB (image.tmdb.org w500+)
 * NUNCA usar portadas de PelisPlus (vienen rotas).
 */
function elegirPortadaPreferida(item, meta) {
  if (!meta && !item) return null;
  var imdb = (meta && meta.portada_imdb) || (item && item.portada_imdb) || null;
  var tmdb = (meta && meta.portada_tmdb) || (item && item.portada_tmdb) || null;
  var actual = item && item.portada ? item.portada : null;
  var fuente = String((item && item.fuente) || '').toLowerCase();

  // PelisPlus: ignorar su portada de origen
  if (fuente === 'pelisplushd' || fuente === 'pelisplus' || esFuentePelisplus(item)) {
    actual = null;
  }

  // 1) IMDb siempre gana si es válida
  if (esPortadaImdb(imdb)) return imdb;

  // 2) Poster de fuentes fiables
  if ((fuente === 'animeav1' || fuente === 'lamovie'  || fuente === 'doramasflix') &&
      actual && !esPortadaSospechosa(actual)) {
    return actual;
  }

  // 3) TMDB (preferir w500+)
  if (esPortadaUrlValida(tmdb) && !esPortadaSospechosa(tmdb)) return tmdb;

  // 4) Poster actual si no es sospechoso ni de pelisplus
  if (actual && !esPortadaSospechosa(actual)) return actual;

  // 5) Último recurso
  if (esPortadaUrlValida(imdb)) return imdb;
  if (esPortadaUrlValida(tmdb)) return tmdb;
  return null;
}

function metaCacheKey(titulo, tipoHint, yearHint) {
  return normalizarTituloKey(titulo) + '|' + normalizarTipoKey(tipoHint) + '|' + String(yearHint || '');
}

function metaCacheGet(key) {
  var e = __META_CACHE__[key];
  if (!e) return null;
  if (Date.now() - e.ts > __META_CACHE_TTL__) {
    delete __META_CACHE__[key];
    return null;
  }
  return e.value || null;
}

function metaCacheSet(key, value) {
  __META_CACHE__[key] = { ts: Date.now(), value: value || null };
}

/**
 * Metadata combinada.
 * Orden:
 *   0. MyAnimeList (Jikan) primero SOLO si tipoHint es Anime
 *   1. IMDb scrape sin key (poster fiable + ID + rating + año + géneros)
 *   2. TMDB oficial si existe TMDB_API_KEY (backdrop + respaldo)
 *   3. OMDb solo si todavía faltan datos
 */
async function metaTmdbParaTitulo(titulo, tipoHint, yearHint) {
  var variantes = variantesTitulo(titulo);
  if (!variantes.length) return null;

  // 4º arg = descripcionHint string | object; 5º = { light: true }
  var arg4 = arguments.length >= 4 ? arguments[3] : null;
  var arg5 = arguments.length >= 5 ? arguments[4] : null;
  var lightMeta = false;
  if (arg4 && typeof arg4 === 'object' && !Array.isArray(arg4) && (arg4.light || arg4.descripcionHint || arg4.descripcion)) {
    if (arg4.light) lightMeta = true;
    if (!arg4.descripcion && !arg4.descripcionHint && arg5) { /* keep */ }
  }
  if (arg5 && typeof arg5 === 'object' && arg5.light) lightMeta = true;

  var cacheKey = metaCacheKey(titulo, tipoHint, yearHint) + (lightMeta ? ':L' : '');
  var cached = metaCacheGet(cacheKey);
  if (cached) return cached;

  var meta = null;

  function completar(destino, origenMeta) {
    if (!origenMeta) return destino;
    if (!destino) {
      var nuevo = {};
      for (var nk in origenMeta) if (Object.prototype.hasOwnProperty.call(origenMeta, nk)) nuevo[nk] = origenMeta[nk];
      return nuevo;
    }
    if (!destino.portada_imdb && origenMeta.portada_imdb) destino.portada_imdb = origenMeta.portada_imdb;
    if (!destino.portada_tmdb && origenMeta.portada_tmdb) destino.portada_tmdb = origenMeta.portada_tmdb;
    if (!destino.descripcion && origenMeta.descripcion) destino.descripcion = origenMeta.descripcion;
    if (destino.calificacion == null && origenMeta.calificacion != null) destino.calificacion = origenMeta.calificacion;
    if (!destino.imdb_id && origenMeta.imdb_id) destino.imdb_id = origenMeta.imdb_id;
    if (!destino.tmdb_id && origenMeta.tmdb_id) destino.tmdb_id = origenMeta.tmdb_id;
    if (!destino.mal_id && origenMeta.mal_id) destino.mal_id = origenMeta.mal_id;
    if ((!destino.generos || !destino.generos.length) && origenMeta.generos && origenMeta.generos.length) destino.generos = origenMeta.generos;
    if (!destino.year && origenMeta.year) destino.year = origenMeta.year;
    if (!destino.fecha_estreno && origenMeta.fecha_estreno) destino.fecha_estreno = origenMeta.fecha_estreno;
    if (!destino.votos && origenMeta.votos) destino.votos = origenMeta.votos;
    if (!destino.backdrop && origenMeta.backdrop) destino.backdrop = origenMeta.backdrop;
    if (!destino.duracion && origenMeta.duracion) destino.duracion = origenMeta.duracion;
    if (!destino.duracion_texto && origenMeta.duracion_texto) destino.duracion_texto = origenMeta.duracion_texto;
    if (!destino.certificacion && origenMeta.certificacion) destino.certificacion = origenMeta.certificacion;
    if (!destino.status && origenMeta.status) destino.status = origenMeta.status;
    return destino;
  }

  // 0) MyAnimeList primero SOLO para Anime (título romanizado JP; IMDb/TMDB
  //    casi nunca coinciden con ese formato para anime nuevo/poco licenciado)
  var esAnimeHint = normalizarTipoKey(tipoHint) === 'anime';
  if (esAnimeHint) {
    var maxVarMal = lightMeta ? 1 : 3;
    for (var mi = 0; mi < Math.min(variantes.length, maxVarMal); mi++) {
      try {
        var mMal = await buscarMetaMal(variantes[mi], yearHint);
        if (mMal) {
          meta = completar(meta, mMal);
          if (meta.mal_id && meta.descripcion && meta.calificacion != null) break;
        }
      } catch (eMal) { /* siguiente variante */ }
    }
  }

  // 1) IMDb primero (suggestion + ficha ES + cruce por sinopsis)
  // 4º arg opcional: string descripción o { descripcion }
  var descHintMeta = arg4;
  if (descHintMeta && typeof descHintMeta === 'object') {
    descHintMeta = descHintMeta.descripcion || descHintMeta.descripcionHint || null;
  }
  if (typeof descHintMeta !== 'string') descHintMeta = null;
  var maxVarImdb = lightMeta ? 2 : 7;
  for (var i = 0; i < Math.min(variantes.length, maxVarImdb); i++) {
    try {
      var mImdb = await buscarMetaImdb(variantes[i], tipoHint, yearHint, {
        descripcionHint: lightMeta ? null : descHintMeta,
        light: lightMeta
      });
      if (mImdb) {
        if (yearHint && mImdb.year && String(yearHint).slice(0, 4) !== String(mImdb.year).slice(0, 4)) {
          continue;
        }
        meta = completar(meta, mImdb);
        if (meta.portada_imdb || meta.imdb_id || meta.calificacion != null) break;
      }
    } catch (eImdb) { /* siguiente variante */ }
  }

  // 2) TMDB para completar (en light solo 1 variante)
  var maxVarTmdb = lightMeta ? 1 : 3;
  for (var t = 0; t < Math.min(variantes.length, maxVarTmdb); t++) {
    try {
      var mTmdb = await buscarMetaTmdbApi(variantes[t], tipoHint, yearHint);
      if (mTmdb) {
        meta = completar(meta, mTmdb);
        if (meta.tmdb_id && meta.descripcion && meta.portada_tmdb) break;
      }
    } catch (eTmdb) { /* siguiente */ }
  }

  // 3) OMDb como último recurso
  if (!meta || !meta.portada_imdb || !meta.descripcion || !meta.calificacion) {
    var maxVarOmdb = lightMeta ? 1 : 5;
    for (var oi = 0; oi < Math.min(variantes.length, maxVarOmdb); oi++) {
      try {
        var mOmdb = await buscarMetaOmdb(variantes[oi]);
        if (mOmdb) {
          meta = completar(meta, mOmdb);
          if (meta.portada_imdb || meta.portada_tmdb) break;
        }
      } catch (eOmdb) { /* siguiente */ }
    }
  }

  if (meta) metaCacheSet(cacheKey, meta);
  return meta;
}

/**
 * Enriquece CADA ítem de la lista (no solo los que coinciden con una query).
 * Concurrencia limitada para no saturar el worker de meta.
 */
/** Normaliza rating a número 0–10 con 1 decimal (string o number) */
function normalizarCalificacion(val) {
  if (val == null || val === '' || val === 'N/A') return null;
  var n = Number(String(val).replace(',', '.').replace(/[^\d.]/g, ''));
  if (isNaN(n) || n <= 0) return null;
  // Si viene 0–100 (raro), escalar
  if (n > 10 && n <= 100) n = n / 10;
  if (n > 10) n = 10;
  return Math.round(n * 10) / 10;
}

/**
 * Garantiza el mismo esquema de campos en búsqueda y detalle.
 * No inventa datos: solo asegura claves presentes (null si faltan).
 */

/** Listado/búsqueda: solo lo esencial (meta completa en el detalle) */

function esDescripcionBasura(texto) {
  if (!texto || typeof texto !== 'string') return true;
  var t = texto.trim();
  if (t.length < 40) return true;
  if (/ver\s+.+\s+online\s+gratis/i.test(t)) return true;
  if (/cuevana|pelisplus|repelis|seriesyonkis/i.test(t) && t.length < 120) return true;
  if (/temporada\s+\d+\s+episodio\s+\d+/i.test(t) && /latino|subtitulad/i.test(t)) return true;
  if (/^ver\s+/i.test(t) && /gratis|hd\b|online/i.test(t)) return true;
  return false;
}

/**
 * Listado compacto:
 * title, slug, url, image, year, source, type
 * + episodes (solo serie/anime si se conoce)
 */
function slimResultadoLista(item, origin) {
  if (!item || typeof item !== 'object') return item;
  var fuente = item.fuente || (Array.isArray(item.fuentes) && item.fuentes[0]) || null;
  var sid = item.source_id != null ? String(item.source_id) : sourceIdFromName(fuente);
  var slug = item.slug || null;
  var tipo = item.tipo || 'Pelicula';
  var tipoPath = (tipo === 'Serie' || tipo === 'Anime')
    ? (tipo === 'Anime' ? 'anime' : 'serie')
    : 'pelicula';
  var url = item.url_extract || item.url || item.link || null;
  if (!url && slug && sid) {
    url = (origin || '') + '/' + sid + '/' + tipoPath + '/' + slug;
  }
  var image = item.portada || item.image || item.portada_fuente_raw || null;
  var year = item.year;
  if (year != null) {
    var ym = String(year).match(/(19|20)\d{2}/);
    year = ym ? ym[0] : String(year);
  }
  var out = {
    title: limpiarTitulo(item.titulo || item.nombre || item.title || '') || null,
    slug: slug,
    url: url,
    portada: image,
    year: year || null,
    source: fuente,
    type: tipo
  };
  if (sid) out.source_id = sid;
  // total episodios solo en DETALLE (junto a temporadas), no en listado
  Object.keys(out).forEach(function (k) {
    if (out[k] == null) delete out[k];
  });
  return out;
}

/** Minutos → "1h 31min" */
function minutosATexto(mins) {
  var n = parseInt(mins, 10);
  if (!n || n <= 0 || !isFinite(n)) return null;
  var h = Math.floor(n / 60);
  var m = n % 60;
  if (h > 0 && m > 0) return h + 'h ' + m + 'min';
  if (h > 0) return h + 'h';
  return m + 'min';
}

/**
 * Detalle: respuesta ordenada con meta IMDb/TMDB y atribución de fuente.
 * Descripción: prioridad página fuente; si no hay, IMDb/TMDB.
 */
/** Episodio en listado de serie: mínimo para navegar/reproducir */
function slimEpisodio(ep) {
  if (!ep || typeof ep !== 'object') return ep;
  var temporada = ep.temporada != null ? ep.temporada : (ep.season != null ? ep.season : null);
  var episodio = ep.episodio != null ? ep.episodio : (ep.episode != null ? ep.episode : null);

  // Título: solo nombre del capítulo, no "Serie 1x1"
  var titulo = ep.titulo || ep.name || ep.nombre || null;
  if (titulo) {
    titulo = String(titulo).trim();
    // Quitar prefijos tipo "Acaramelados 1x1", "Serie - T1E1", "1x1 - "
    titulo = titulo
      .replace(/^.*?\b\d+\s*[x×]\s*\d+\s*[-–:|]?\s*/i, '')
      .replace(/^.*?\bT\s*\d+\s*E\s*\d+\s*[-–:|]?\s*/i, '')
      .replace(/^.*?\bTemporada\s*\d+\s*(Episodio|Cap[ií]tulo)?\s*\d+\s*[-–:|]?\s*/i, '')
      .replace(/^(Episodio|Cap[ií]tulo|Episode|Chapter)\s*\d+\s*[-–:|]?\s*/i, '')
      .trim();
    // Si quedó vacío o es solo el nombre de la serie repetido, no mandar titulo
    if (!titulo || /^\d+$/.test(titulo)) titulo = null;
  }

  var out = {};
  if (temporada != null) out.temporada = temporada;
  if (episodio != null) out.episodio = episodio;
  if (titulo) out.titulo = titulo;
  if (ep.slug) out.slug = ep.slug;
  if (ep.link) out.link = ep.link;
  if (ep.episode_id != null) out.episode_id = ep.episode_id;
  if (ep.postId != null) out.postId = ep.postId;

  // Players solo si ya vienen en este ítem (capítulo resuelto)
  var reps = ep.reproductores || [];
  var embeds = ep.embeds || [];
  var descargas = ep.descargas || ep.downloads || [];
  if (reps.length) out.reproductores = reps;
  if (embeds.length) out.embeds = embeds;
  if (descargas.length) out.descargas = descargas;

  return out;
}

function slimTemporada(t) {
  if (!t || typeof t !== 'object') return t;
  var eps = t.episodios || t.capitulos || [];
  var lista = eps.map(slimEpisodio);
  var out = {
    temporada: t.temporada != null ? t.temporada : (t.season_number != null ? t.season_number : null),
    episodios: lista.length
  };
  if (lista.length) out.lista = lista;
  if (out.temporada == null) delete out.temporada;
  return out;
}

/**
 * Detalle limpio:
 * - rating + rating_source (imdb | tmdb | fuente)
 * - imdb/tmdb solo id + rating + votos (sin duplicar géneros/duración/portada)
 * - sin titulo_tmdb
 * - sin campos null innecesarios
 */

/** Capítulo: solo lo necesario para reproducir (meta en detalle de la serie) */
function formatearCapituloRespuesta(item, origin, ctx) {
  ctx = ctx || {};
  item = item || {};
  var sid = ctx.source_id || item.source_id || sourceIdFromName(item.fuente) || null;
  var slug = ctx.slug || item.slug || null;
  var temporada = ctx.season != null ? ctx.season : (item.temporada != null ? item.temporada : null);
  var episodio = ctx.episode != null ? ctx.episode : (item.episodio != null ? item.episodio : null);
  var tipoRuta = ctx.tipoRuta || 'serie';
  if (tipoRuta === 'anime') tipoRuta = 'anime';
  else if (tipoRuta === 'pelicula') tipoRuta = 'pelicula';
  else tipoRuta = 'serie';

  var reproductores = item.reproductores || [];
  var embeds = item.embeds || [];
  // Si embeds son strings, normalizar
  if (embeds.length && typeof embeds[0] === 'string') {
    embeds = embeds.map(function (u) { return { url: u }; });
  }
  var descargas = item.descargas || item.downloads || [];

  var urlExtract = null;
  if (slug && sid && origin && temporada != null && episodio != null) {
    urlExtract = origin + '/' + sid + '/' + tipoRuta + '/' + slug + '/' + temporada + '/' + episodio;
  }

  var out = {
    success: item.success !== false,
    tipo: 'Capitulo',
    fuente: item.fuente || null,
    source_id: sid != null ? String(sid) : null,
    slug: slug,
    titulo: item.titulo_serie || item.titulo || null,
    temporada: temporada,
    episodio: episodio,
    total: reproductores.length || embeds.length || 0,
    embeds: embeds,
    reproductores: reproductores,
    descargas: descargas
  };
  if (urlExtract) out.url_extract = urlExtract;
  if (item.link) out.link = item.link;
  if (item.postId != null) out.postId = item.postId;

  Object.keys(out).forEach(function (k) {
    if (out[k] == null) delete out[k];
  });
  return out;
}

/**
 * Detalle organizado, sin duplicados:
 * rating + rating_source en raíz; imdb/tmdb solo ids (y rating si difiere)
 * generos (array) sin "genero" string; estado sin triplicar en_emision/finalizado
 * series: sin embeds/reproductores vacíos (van por capítulo)
 */
function formatearDetalleRespuesta(item, origin) {
  if (!item || typeof item !== 'object') return item;

  var desc = item.descripcion || null;
  if (desc && typeof esDescripcionBasura === 'function' && esDescripcionBasura(desc)) desc = null;
  if (!desc && item.imdb && item.imdb.descripcion) desc = item.imdb.descripcion;
  if (!desc && item.descripcion_imdb) desc = item.descripcion_imdb;
  if (!desc && item.descripcion_tmdb) desc = item.descripcion_tmdb;

  var ratingImdb = null;
  var ratingTmdb = null;
  if (item.imdb && item.imdb.rating != null) ratingImdb = normalizarCalificacion(item.imdb.rating);
  if (ratingImdb == null && item.rating_imdb != null) ratingImdb = normalizarCalificacion(item.rating_imdb);
  if (item.tmdb && item.tmdb.rating != null) ratingTmdb = normalizarCalificacion(item.tmdb.rating);
  if (ratingTmdb == null && item.rating_tmdb != null) ratingTmdb = normalizarCalificacion(item.rating_tmdb);

  var ratingFuente = item.rating != null ? normalizarCalificacion(item.rating) : null;
  if (ratingFuente == null && item.calificacion != null) ratingFuente = normalizarCalificacion(item.calificacion);

  var rating = null;
  var rating_source = null;
  if (ratingImdb != null) {
    rating = ratingImdb;
    rating_source = 'imdb';
  } else if (item.mal_id && ratingFuente != null) {
    rating = ratingFuente;
    rating_source = 'mal';
  } else if (item.imdb_id && ratingFuente != null) {
    rating = ratingFuente;
    rating_source = 'imdb';
  } else if (ratingTmdb != null) {
    rating = ratingTmdb;
    rating_source = 'tmdb';
  } else if (item.tmdb_id && ratingFuente != null) {
    rating = ratingFuente;
    rating_source = 'tmdb';
  } else if (ratingFuente != null) {
    rating = ratingFuente;
    rating_source = 'fuente';
  }

  var votos = null;
  if (item.imdb && item.imdb.votos != null) votos = item.imdb.votos;
  else if (item.votos != null) votos = item.votos;
  else if (item.votos_imdb != null) votos = item.votos_imdb;

  var duracion = item.duracion != null ? item.duracion : (item.imdb && item.imdb.duracion != null ? item.imdb.duracion : null);
  var duracionTexto = item.duracion_texto || minutosATexto(duracion) || (item.imdb && item.imdb.duracion_texto) || null;
  var certificacion = item.certificacion || (item.imdb && item.imdb.certificacion) || item.clasificacion || null;

  var generos = Array.isArray(item.generos) && item.generos.length
    ? item.generos
    : (item.imdb && Array.isArray(item.imdb.generos) ? item.imdb.generos : null);
  if ((!generos || !generos.length) && item.genero) {
    generos = String(item.genero).split(',').map(function (g) { return g.trim(); }).filter(Boolean);
  }
  if (generos && !generos.length) generos = null;

  var imdbId = item.imdb_id || (item.imdb && item.imdb.id) || null;
  var tmdbId = item.tmdb_id || (item.tmdb && item.tmdb.id) || null;

  // IDs solo en raíz (imdb_id / tmdb_id); sin objetos {id} duplicados
  var imdbObj = null;
  var tmdbObj = null;

  var tipo = item.tipo || 'Pelicula';
  var sid = item.source_id != null ? String(item.source_id) : sourceIdFromName(item.fuente);
  var slug = item.slug || null;
  var tipoPath = (tipo === 'Serie' || tipo === 'Anime')
    ? (tipo === 'Anime' ? 'anime' : 'serie')
    : 'pelicula';
  var urlExtract = item.url_extract || null;
  if (!urlExtract && slug && sid && origin) {
    urlExtract = origin + '/' + sid + '/' + tipoPath + '/' + slug;
  }

  var portada = item.portada || item.portada_imdb || item.portada_tmdb || null;
  var titulo = limpiarTitulo(item.titulo || '') || null;
  var tituloOrig = item.titulo_original || null;
  if (!tituloOrig && item.titulo_tmdb && String(item.titulo_tmdb).toLowerCase() !== String(titulo || '').toLowerCase()) {
    tituloOrig = item.titulo_tmdb;
  }
  if (tituloOrig && titulo && String(tituloOrig).toLowerCase() === String(titulo).toLowerCase()) {
    tituloOrig = null;
  }

  // Estado unificado (series)
  var estado = item.estado || null;
  if (!estado && item.status) {
    var stFmt = normalizarEstadoEmision(item.status);
    estado = stFmt.estado;
    if (item.en_emision == null) item.en_emision = stFmt.en_emision;
    if (item.finalizado == null) item.finalizado = stFmt.finalizado;
  }
  if (!estado) {
    if (item.finalizado === true) estado = 'Finalizado';
    else if (item.en_emision === true) estado = 'En emisión';
  }

  var esSerieAnime = (tipo === 'Serie' || tipo === 'Anime');
  var reps = item.reproductores || [];
  var embeds = item.embeds || [];
  var descargas = item.descargas || item.downloads || [];
  // En ficha de serie no tiene sentido lista vacía de players (van por capítulo)
  var incluirPlayers = !esSerieAnime || reps.length > 0 || embeds.length > 0;

  // Orden lógico de campos
  var out = {
    success: item.success !== false,
    fuente: item.fuente || null,
    source_id: sid,
    tipo: tipo,
    link: item.link || null,
    slug: slug,
    titulo: titulo,
    titulo_original: tituloOrig,
    portada: portada,
    backdrop: item.backdrop || null,
    descripcion: desc,
    year: item.year || null,
    fecha_estreno: item.fecha_estreno || null,
    rating: rating,
    rating_source: rating_source,
    votos: votos,
    generos: generos,
    duracion: duracion,
    duracion_texto: duracionTexto,
    certificacion: certificacion,
    actores: Array.isArray(item.actores) && item.actores.length ? item.actores : null,
    estado: esSerieAnime ? estado : null,
    imdb_id: imdbId,
    tmdb_id: tmdbId,
    imdb: imdbObj,
    tmdb: tmdbObj,
    poster_source: item.poster_source || null,
    url_extract: urlExtract
  };

  if (esSerieAnime) {
    var totalEps = item.total_episodios != null ? parseInt(item.total_episodios, 10) : null;
    var totalTemps = item.total_temporadas != null ? parseInt(item.total_temporadas, 10) : null;
    if (Array.isArray(item.temporadas) && item.temporadas.length) {
      out.temporadas = item.temporadas.map(slimTemporada);
      if (!totalTemps) totalTemps = out.temporadas.length;
      if (!totalEps || !isFinite(totalEps)) {
        totalEps = 0;
        for (var ti = 0; ti < out.temporadas.length; ti++) {
          var te = out.temporadas[ti];
          if (!te) continue;
          if (typeof te.episodios === 'number') totalEps += te.episodios;
          else if (Array.isArray(te.lista)) totalEps += te.lista.length;
          else if (Array.isArray(te.episodios)) totalEps += te.episodios.length;
        }
      }
    } else if (Array.isArray(item.episodios) && item.episodios.length) {
      out.episodios = item.episodios.map(slimEpisodio);
      if (!totalEps) totalEps = out.episodios.length;
    }
    // Totales junto a temporadas (solo detalle)
    if (totalTemps && isFinite(totalTemps)) out.total_temporadas = totalTemps;
    if (totalEps && isFinite(totalEps) && totalEps > 0) out.total_episodios = totalEps;
  }

  if (incluirPlayers) {
    out.total = reps.length || embeds.length || (item.total != null ? item.total : 0);
    out.reproductores = reps;
    out.embeds = embeds;
    out.descargas = descargas;
  }

  if (tipo === 'Capitulo' || (item.temporada != null && item.episodio != null && !esSerieAnime)) {
    if (item.temporada != null) out.temporada = item.temporada;
    if (item.episodio != null) out.episodio = item.episodio;
    if (item.titulo_serie) out.titulo_serie = item.titulo_serie;
  }

  if (item.postId != null) out.postId = item.postId;
  if (item.formato) out.formato = item.formato;

  // Limpiar nulls / vacíos
  Object.keys(out).forEach(function (k) {
    if (out[k] == null) delete out[k];
    if (Array.isArray(out[k]) && !out[k].length) delete out[k];
  });

  return out;
}

function normalizarCamposResultado(item) {
  if (!item || typeof item !== 'object') return item;
  var campos = [
    'titulo', 'titulo_original', 'tipo', 'formato', 'fuente', 'source_id', 'slug',
    'portada', 'backdrop', 'descripcion', 'rating', 'calificacion', 'votos', 'year', 'fecha_estreno',
    'generos', 'genero', 'duracion', 'estado', 'en_emision', 'finalizado',
    'imdb_id', 'tmdb_id', 'url_extract'
  ];
  for (var i = 0; i < campos.length; i++) {
    if (item[campos[i]] === undefined) item[campos[i]] = null;
  }
  if (item.calificacion != null) item.calificacion = normalizarCalificacion(item.calificacion);
  if (item.rating != null) item.rating = normalizarCalificacion(item.rating);
  else if (item.calificacion != null) item.rating = item.calificacion;
  if (item.year != null) {
    var y = String(item.year).match(/(19|20)\d{2}/);
    item.year = y ? y[0] : null;
  }
  if (Array.isArray(item.generos) && !item.genero) {
    item.genero = item.generos.join(', ');
  }
  return item;
}

async function enriquecerListaConTmdb(lista, query, opts) {
  if (!lista || !lista.length) return lista;
  opts = opts || {};
  var light = !!opts.light;
  var maxItems = opts.maxItems > 0 ? opts.maxItems : lista.length;
  var CONCURRENCY = opts.concurrency > 0 ? opts.concurrency : (light ? 2 : 3);
  var i = 0;
  var limit = Math.min(lista.length, maxItems);

  async function worker() {
    while (i < limit) {
      var idx = i++;
      var item = lista[idx];
      if (!item || !item.titulo) continue;
      var sinPortada = !item.portada || (typeof esPortadaSospechosa === 'function' && esPortadaSospechosa(item.portada));
      var sinInfo = !item.descripcion || !item.genero;
      var sinRating = item.calificacion == null || item.calificacion === '' || item.calificacion === 0 || item.calificacion === '0';
      // Siempre enriquecer si falta portada, info o rating
      if (!sinPortada && !sinInfo && !sinRating && item.tmdb_id && !esFuentePelisplus(item)) continue;
      try {
        // Modo light (catálogos): NO scrapea ficha PelisPlus ni IMDb ES (muy pesado → 503/1102)
        if (!light) {
          if (esFuentePelisplus(item) || String(item.fuente || '').toLowerCase() === 'pelisplushd') {
            await enriquecerDesdeFichaPelisplus(item);
          }
        }
        var meta = await metaTmdbParaTitulo(
          item.titulo,
          item.tipo,
          extraerYearItem(item),
          light ? null : item.descripcion,
          light ? { light: true } : null
        );
        if (meta) aplicarMetaAResultadoBusqueda(item, meta);
        // Forzar rating si sigue vacío
        if ((item.calificacion == null || item.calificacion === '') && meta && meta.calificacion != null) {
          item.calificacion = normalizarCalificacion(meta.calificacion);
        }
        // Último recurso portada: solo meta del mismo año / sin conflicto
        var yIt = extraerYearItem(item);
        var yMt = meta && (meta.year || (meta.fecha_estreno ? String(meta.fecha_estreno).slice(0, 4) : null));
        var metaYearOk = !yIt || !yMt || String(yIt) === String(yMt);
        // Si portada_imdb quedó de otra obra, limpiarla
        if (!metaYearOk && item.portada_imdb) {
          item.portada_imdb = null;
          if (item.poster_source === 'imdb') item.poster_source = null;
        }
        if ((!item.portada || esPortadaSospechosa(item.portada))) {
          if (metaYearOk && item.portada_imdb && esPortadaUrlValida(item.portada_imdb)) {
            item.portada = item.portada_imdb;
            item.poster_source = 'imdb';
          } else if (item.portada_tmdb && esPortadaUrlValida(item.portada_tmdb)) {
            item.portada = item.portada_tmdb;
            item.poster_source = 'tmdb';
          } else if (metaYearOk && meta && meta.portada_tmdb && esPortadaUrlValida(meta.portada_tmdb)) {
            item.portada = meta.portada_tmdb;
            item.portada_tmdb = meta.portada_tmdb;
            item.poster_source = 'tmdb';
          } else if (metaYearOk && meta && meta.portada_imdb && esPortadaUrlValida(meta.portada_imdb)) {
            item.portada = meta.portada_imdb;
            item.portada_imdb = meta.portada_imdb;
            item.poster_source = 'imdb';
          } else if (item.portada_fuente_raw && esPortadaUrlValida(item.portada_fuente_raw)) {
            item.portada = item.portada_fuente_raw;
            item.poster_source = String(item.fuente || 'fuente');
          }
        }
        // Normalizar formato final
        if (item.calificacion != null) item.calificacion = normalizarCalificacion(item.calificacion);
      } catch (e) { /* siguiente */ }
    }
  }

  var jobs = [];
  for (var c = 0; c < Math.min(CONCURRENCY, lista.length); c++) {
    jobs.push(worker());
  }
  await Promise.all(jobs);
  return lista;
}

async function enriquecerDetalleConTmdb(detalle, tipoRuta) {
  if (!detalle || detalle.success === false) return detalle;
  var titulo = detalle.titulo || detalle.title || '';
  var slug = detalle.slug || '';
  var metaFull = null;
  try {
    metaFull = await metaTmdbParaTitulo(titulo || slug, tipoRuta || detalle.tipo, extraerYearItem(detalle), detalle.descripcion);
  } catch (e) {
    return detalle;
  }
  if (!metaFull) return detalle;

  // Ya viene normalizada por IMDb/TMDB/OMDb.
  var meta = metaFull;
  // fetchDetalle puede traer más campos
  if (metaFull.backdrop) meta.backdrop = metaFull.backdrop;
  if (metaFull.original_title) meta.titulo_original = metaFull.original_title;
  if (metaFull.votos) meta.votos = metaFull.votos;
  if (metaFull.runtime) meta.duracion = metaFull.runtime;
  if (metaFull.status) {
    meta.status = metaFull.status;
    var stMeta = normalizarEstadoEmision(metaFull.status);
    if (stMeta.estado) {
      meta.estado = stMeta.estado;
      meta.en_emision = stMeta.en_emision;
      meta.finalizado = stMeta.finalizado;
    }
  }
  if (metaFull.tagline) meta.tagline = metaFull.tagline;
  if (metaFull.imdb_id) meta.imdb_id = metaFull.imdb_id;
  if (metaFull.overview_tmdb || metaFull.tmdb_overview) {
    meta.descripcion = metaFull.overview_tmdb || metaFull.tmdb_overview || meta.descripcion;
  }
  if (metaFull.genres_tmdb || metaFull.genres) {
    meta.generos = metaFull.genres_tmdb || metaFull.genres || meta.generos;
  }
  if (metaFull.poster_tmdb || metaFull.tmdb_poster) {
    meta.portada_tmdb = metaFull.poster_tmdb || metaFull.tmdb_poster || meta.portada_tmdb;
  }
  if (metaFull.rating || metaFull.tmdb_rating) {
    meta.calificacion = Number(metaFull.rating || metaFull.tmdb_rating);
  }
  if (metaFull.release_date || metaFull.tmdb_release_date) {
    meta.fecha_estreno = metaFull.release_date || metaFull.tmdb_release_date;
  }

  // No pisar datos buenos ya extraídos de la página fuente
  var descFuente = detalle.descripcion || '';
  var descFuenteOk = descFuente.length > 60 && !/\.\.\.\s*$/.test(descFuente)
    && !(typeof esDescripcionBasura === 'function' && esDescripcionBasura(descFuente));
  var portadaFuenteOk = detalle.portada && !esFuentePelisplus(detalle) && !esPortadaSospechosa(detalle.portada);

  if (descFuenteOk) meta.descripcion = null; // conservar scrape
  if (portadaFuenteOk) { meta.portada_tmdb = null; meta.portada_imdb = null; }
  if (detalle.genero) meta.generos = null;
  // No bloquear rating: si la fuente no trae calificación, usar IMDb/TMDB/OMDb

  aplicarMetaAResultadoBusqueda(detalle, meta);

  // Garantizar calificacion siempre que meta la tenga
  if ((detalle.calificacion == null || detalle.calificacion === '') && metaFull.calificacion != null) {
    detalle.calificacion = normalizarCalificacion(metaFull.calificacion);
  } else if (detalle.calificacion != null) {
    detalle.calificacion = normalizarCalificacion(detalle.calificacion);
  }
  if (!detalle.votos && metaFull.votos) detalle.votos = metaFull.votos;

  // Si aún no hay descripción usable, forzar la de meta (aunque sea inglés)
  var descAhora = detalle.descripcion || '';
  var descSigueMal = !descAhora || descAhora.length < 40
    || (typeof esDescripcionBasura === 'function' && esDescripcionBasura(descAhora));
  if (descSigueMal && metaFull.descripcion && String(metaFull.descripcion).length >= 40) {
    detalle.descripcion = metaFull.descripcion;
  }

  // Si hay imdb_id pero falta estado/tmdb_id/descripcion → TMDB find por imdb_id
  var imdbIdNow = detalle.imdb_id || metaFull.imdb_id || null;
  var faltaEstado = !detalle.estado && !detalle.status;
  var faltaTmdb = !detalle.tmdb_id;
  var faltaDesc2 = !detalle.descripcion || String(detalle.descripcion).length < 40
    || (typeof esDescripcionBasura === 'function' && esDescripcionBasura(detalle.descripcion));
  if (imdbIdNow && (faltaEstado || faltaTmdb || faltaDesc2)) {
    try {
      var extraTmdb = await completarDesdeTmdbPorImdbId(imdbIdNow, tipoRuta || detalle.tipo);
      if (extraTmdb) {
        if (!detalle.tmdb_id && extraTmdb.tmdb_id) detalle.tmdb_id = extraTmdb.tmdb_id;
        if (faltaDesc2 && extraTmdb.descripcion && String(extraTmdb.descripcion).length >= 40) {
          detalle.descripcion = extraTmdb.descripcion;
        }
        if (!detalle.votos && extraTmdb.votos) detalle.votos = extraTmdb.votos;
        if ((detalle.calificacion == null || detalle.calificacion === '') && extraTmdb.calificacion != null) {
          detalle.calificacion = normalizarCalificacion(extraTmdb.calificacion);
        }
        if (!detalle.backdrop && extraTmdb.backdrop) detalle.backdrop = extraTmdb.backdrop;
        if (!detalle.titulo_original && extraTmdb.titulo_original) detalle.titulo_original = extraTmdb.titulo_original;
        if (!detalle.fecha_estreno && extraTmdb.fecha_estreno) detalle.fecha_estreno = extraTmdb.fecha_estreno;
        if (extraTmdb.status) {
          detalle.status = extraTmdb.status;
          var st2 = normalizarEstadoEmision(extraTmdb.status);
          if (st2.estado) {
            if (!detalle.estado) detalle.estado = st2.estado;
            if (detalle.en_emision == null) detalle.en_emision = st2.en_emision;
            if (detalle.finalizado == null) detalle.finalizado = st2.finalizado;
          }
        }
      }
    } catch (eTmdbImdb) { /* silencioso */ }
  }

  // Temporadas TMDB (solo meta; no pisa embeds)
  if (Array.isArray(metaFull.temporadas) && metaFull.temporadas.length) {
    // Solo meta (nombres/stills). NO mezclar con temporadas de la fuente (evita T1 duplicada / T2 fantasma)
    detalle.temporadas_tmdb = metaFull.temporadas;
    // total_temporadas: preferir lo que ya trajo la fuente (animeav1, etc.)
    // Contar temporadas de fuente + extras TMDB no duplicadas
    var nSrc = Array.isArray(detalle.temporadas) ? detalle.temporadas.length : 0;
    var nTmdb = metaFull.temporadas.length;
    detalle.total_temporadas = Math.max(nSrc || 0, nTmdb || 0, detalle.total_temporadas || 0) || nSrc || nTmdb || 1;
    // Solo rellenar lista de reproducción si la fuente no trajo ninguna
    if (!detalle.temporadas || !detalle.temporadas.length) {
      detalle.temporadas = metaFull.temporadas.map(function (t) {
        return t.season_number || t.temporada || t;
      }).filter(Boolean);
    }
  }

  // Limpiar aliases redundantes si alguien los había puesto antes
  delete detalle.tmdb_overview;
  delete detalle.overview_tmdb;
  delete detalle.description;
  delete detalle.tmdb_genres;
  delete detalle.genres_tmdb;
  delete detalle.genres;
  delete detalle.tmdb_poster;
  delete detalle.poster_tmdb;
  delete detalle.tmdb_rating;
  delete detalle.rating;
  delete detalle.tmdb_release_date;
  delete detalle.release_date;
  delete detalle.tmdb_title;
  delete detalle.original_title;
  delete detalle.image;

  return detalle;
}


async function buscarUniversal(query, sourceFilter, limit) {
  sourceFilter = (sourceFilter || 'all').toLowerCase();
  limit = limit || 15;
  var q = String(query || '').trim();
  if (!q) throw new Error('Falta el termino de busqueda');

  // Fuentes en paralelo (rápido). Orden de score decide principal, no "el primero gana".
  // Merge por obra → sin duplicados. Tipo final: cine > dorama > anime basura.
  var cadena = [
    { id: 'animeav1', aliases: ['animeav1', '4', 'av1'], fn: function () { return buscarAnimeAv1(q, limit); } },
    { id: 'doramasflix', aliases: ['doramasflix', '6', 'doramas', 'dfx'], fn: function () { return buscarDoramasflix(q, limit); } },
    { id: 'pelisplushd', aliases: ['pelisplushd', 'pelisplus', '3', 'pp'], fn: function () { return buscarPelisplus(q, limit); } },
    { id: 'lamovie', aliases: ['lamovie', '1', 'lm'], fn: function () { return buscarLamovie(q, limit); } },
    { id: 'hackstore', aliases: ['hackstore', '2', 'hs'], fn: function () { return buscarHackstore(q, limit); } }
  ];

  function withTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise).catch(function () { return []; }),
      new Promise(function (resolve) { setTimeout(function () { resolve([]); }, ms); })
    ]);
  }

  var jobs = [];
  for (var i = 0; i < cadena.length; i++) {
    var c = cadena[i];
    if (sourceFilter !== 'all' && c.aliases.indexOf(sourceFilter) === -1) continue;
    // animeav1 pagina varias veces: más tiempo
    var tms = (c.id === 'animeav1') ? 12000 : 5000;
    jobs.push({ id: c.id, p: withTimeout(c.fn(), tms) });
  }

  var settled = await Promise.all(jobs.map(function (j) { return j.p; }));
  var todos = [];

  for (var ji = 0; ji < jobs.length; ji++) {
    var hits = settled[ji];
    var fid = jobs[ji].id;
    if (!Array.isArray(hits) || !hits.length) continue;

    for (var ti = 0; ti < hits.length; ti++) {
      if (!hits[ti]) continue;
      if (hits[ti].titulo) hits[ti].titulo = limpiarTitulo(hits[ti].titulo);
      delete hits[ti].alternativas;
      hits[ti].fuente = fid;
      hits[ti].fuentes = [fid];
      if (typeof sourceIdFromName === 'function') {
        hits[ti].source_id = sourceIdFromName(fid);
      }
      if (fid === 'pelisplushd' && hits[ti].portada) {
        hits[ti].portada_fuente_raw = hits[ti].portada;
        hits[ti].portada = null;
      }
    }

    var relevantes = [];
    for (var ri = 0; ri < hits.length; ri++) {
      if (resultadoRelevanteBusqueda(q, hits[ri])) relevantes.push(hits[ri]);
    }
    relevantes = dedupePorSlugFuente(relevantes);
    for (var rj = 0; rj < relevantes.length; rj++) todos.push(relevantes[rj]);
  }

  // Fusionar misma obra entre fuentes (sin duplicados)
  var resultados = typeof fusionarResultadosBusqueda === 'function'
    ? fusionarResultadosBusqueda(todos)
    : dedupePorSlugFuente(todos);

  // Ordenar por score (tipo + fuente + meta)
  resultados.sort(function (a, b) {
    return scoreItemBusqueda(b) - scoreItemBusqueda(a);
  });

  var fuenteUsada = null;
  if (resultados.length) {
    fuenteUsada = resultados[0].fuente || null;
  }

  return {
    success: true,
    query: q,
    fuente: fuenteUsada,
    total: resultados.length,
    resultados: resultados.slice(0, limit)
  };
}

async function buscarLamovie(query, limit) {
  var url = LAMOVIE_API + '/search?postType=any&q=' + encodeURIComponent(query) + '&postsPerPage=' + (limit || 15);
  var res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) return [];
  var data = await res.json();
  var posts = (data && data.data && data.data.posts) ? data.data.posts : [];
  if (!Array.isArray(posts)) return [];

  var out = [];
  for (var i = 0; i < posts.length; i++) {
    var p = posts[i];
    var tipo = 'Pelicula';
    var path = 'peliculas';
    if (p.type === 'tvshows') { tipo = 'Serie'; path = 'series'; }
    if (p.type === 'animes') { tipo = 'Anime'; path = 'animes'; }

    var portada = '';
    if (p.images && p.images.poster) {
      portada = p.images.poster.indexOf('http') === 0
        ? p.images.poster
        : 'https://lamovie.org/wp-content/uploads' + p.images.poster;
    }

    out.push({
      titulo: p.title || '',
      tipo: tipo,
      fuente: 'lamovie',
      postId: p._id,
      slug: p.slug || '',
      link: LAMOVIE_BASE + '/' + path + '/' + (p.slug || '') + '/',
      portada: portada,
      year: p.release_date ? String(p.release_date).slice(0, 4) : null,
      calificacion: p.rating || p.imdb_rating || null
    });
  }
  return out;
}

/** Query limpia para buscadores: sin acentos raros, sin ":", sin mojibake */
/**
 * Convierte texto UTF-8 correcto a la forma mojibake que usa a veces pelisplushd.
 * "Código: Venganza" → "CÃ³digo: Venganza"
 * Así el buscador de la página fuente sí encuentra el título mal indexado.
 */
function aMojibakeLatin1(txt) {
  try {
    var bytes = new TextEncoder().encode(String(txt || ''));
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  } catch (e) {
    return String(txt || '');
  }
}

function normalizarQueryBusqueda(q) {
  var s = limpiarTexto(String(q || ''));
  // Quitar mojibake residual y normalizar Unicode
  try {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) { /* ok */ }
  // "CÃ³digo" → "Codigo" si aún queda
  s = s.replace(/CAdigo|CÃ³digo|CÃ\x93digo/gi, 'Codigo');
  s = s.replace(/[:;|/\\]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Título legible desde slug: codigo-venganza → Código Venganza (aprox.) */
function tituloDesdeSlug(slug) {
  var t = String(slug || '')
    .replace(/-\d{4}$/, '')
    .replace(/-+/g, ' ')
    .trim();
  // Capitalizar palabras
  t = t.replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); });
  return limpiarTitulo(t);
}

async function buscarHackstore(query, limit) {
  var q = normalizarQueryBusqueda(query);
  if (!q) return [];
  var url = HACKSTORE_BASE + '/?s=' + encodeURIComponent(q);
  var res = await fetch(url, {
    headers: Object.assign({}, HEADERS, { 'Referer': HACKSTORE_BASE + '/' })
  });
  if (!res.ok) return [];
  var html = await res.text();
  html = html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  var out = [];
  var vistos = {};
  var regex = /href=["'](https?:\/\/(?:www\.)?hackstore\.[a-z]+\/(peliculas|series|animes)\/([^"'\/\?]+))\/?["']/gi;
  var m;
  while ((m = regex.exec(html)) !== null && out.length < (limit || 15)) {
    var link = m[1].replace(/\/$/, '') + '/';
    var seccion = m[2];
    var slug = m[3];
    if (vistos[link]) continue;
    if (PALABRAS_BLOQUEADAS_BUSQUEDA.some(function (w) { return slug.indexOf(w) !== -1; })) continue;
    vistos[link] = true;
    var tipo = 'Pelicula';
    if (seccion === 'series') tipo = 'Serie';
    if (seccion === 'animes') tipo = 'Anime';

    // Portada: data-src de lazyload cerca del enlace
    var portada = null;
    var pos = m.index;
    var chunk = html.slice(Math.max(0, pos - 80), pos + 900);
    var imgM = chunk.match(/data-src=["'](https?:\/\/[^"']+)["']/i)
      || chunk.match(/data-lazy-src=["'](https?:\/\/[^"']+)["']/i)
      || chunk.match(/src=["'](https?:\/\/image\.tmdb\.org\/[^"']+)["']/i);
    if (imgM && !/data:image|svg\+xml|lazyload\.min/i.test(imgM[1])) {
      portada = imgM[1].replace('/w300/', '/w500/');
    }

    // Año desde slug
    var year = null;
    var ym = slug.match(/-(\d{4})$/);
    if (ym) year = ym[1];

    out.push({
      titulo: tituloDesdeSlug(slug),
      tipo: tipo,
      fuente: 'hackstore',
      link: link,
      slug: slug,
      portada: portada,
      year: year
    });
  }
  return out;
}

async function buscarPelisplus(query, limit) {
  // Pelisplus a veces indexa el título EN MOJIBAKE en su buscador:
  //   página: "CÃ³digo: Venganza"
  //   usuario busca: "Codigo Venganza" / "Código: Venganza" → sin esa variante no sale
  var variantes = [];
  function addVar(v) {
    v = String(v || '').replace(/\s+/g, ' ').trim();
    if (v && variantes.indexOf(v) === -1) variantes.push(v);
  }
  var qRaw = String(query || '').trim();
  var q0 = limpiarTexto(qRaw);
  var q1 = normalizarQueryBusqueda(query);
  addVar(qRaw);
  addVar(q0);
  addVar(q1);
  addVar(q1.replace(/[^\w\s\-]/g, ' ').replace(/\s+/g, ' ').trim());

  // Poner acentos típicos (codigo→Código) para poder generar el mojibake real
  function conAcentos(t) {
    return String(t || '')
      .replace(/\bcodigo\b/gi, function (m) { return m[0] === 'C' ? 'Código' : 'código'; })
      .replace(/\bpelicula\b/gi, function (m) { return m[0] === 'P' ? 'Película' : 'película'; })
      .replace(/\banos\b/gi, function (m) { return m[0] === 'A' ? 'Años' : 'años'; })
      .replace(/\bnumero\b/gi, function (m) { return m[0] === 'N' ? 'Número' : 'número'; })
      .replace(/\baction\b/gi, function (m) { return m; });
  }
  var qAccent = conAcentos(q0 || q1);
  addVar(qAccent);

  // "Código Venganza" → "Código: Venganza" (formato frecuente en la web)
  var parts = qAccent.split(/\s+/).filter(Boolean);
  var qColon = parts.length >= 2 ? (parts[0] + ': ' + parts.slice(1).join(' ')) : qAccent;
  addVar(qColon);

  // ★ Variantes mojibake (como está indexado en pelisplushd)
  addVar(aMojibakeLatin1(qAccent));
  addVar(aMojibakeLatin1(qColon));
  var qCap = parts.map(function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
  addVar(aMojibakeLatin1(qCap));
  if (parts.length >= 2) {
    addVar(aMojibakeLatin1(parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ': ' + parts.slice(1).join(' ')));
  }

  if (variantes.length === 0) return [];

  var out = [];
  var vistos = {};
  var limitN = limit || 15;

  for (var vi = 0; vi < variantes.length && out.length < limitN; vi++) {
    var q = variantes[vi];
    if (!q) continue;
    try {
      var url = PELISPLUS_BASE + '/search?s=' + encodeURIComponent(q);
      var res = await fetch(url, {
        headers: Object.assign({}, HEADERS, {
          'Referer': PELISPLUS_BASE + '/',
          'Accept-Language': 'es-ES,es;q=0.9'
        })
      });
      if (!res.ok) continue;
      var html = await res.text();

      // Links pelicula/serie/anime
      var regex = /href=["']((?:https?:\/\/[^"']+)?\/(?:pelicula|serie|anime)\/([^"'\/\?]+))\/?["']/gi;
      var m;
      while ((m = regex.exec(html)) !== null && out.length < limitN) {
        var path = m[1];
        var slug = decodeURIComponent(m[2] || '');
        // Arreglar slugs rotos tipo c-digo-traje-rojo → codigo-...
        slug = slug.replace(/\bc-digo\b/gi, 'codigo').replace(/\bc-\s*digo\b/gi, 'codigo');
        var full = path.indexOf('http') === 0 ? path : PELISPLUS_BASE + path;
        full = full.replace(/\/$/, '') + '/';
        if (vistos[full]) continue;
        if (PALABRAS_BLOQUEADAS_BUSQUEDA.some(function (w) { return slug.indexOf(w) !== -1; })) continue;
        vistos[full] = true;
        var tipo = 'Pelicula';
        if (/\/serie\//i.test(full)) tipo = 'Serie';
        if (/\/anime\//i.test(full)) tipo = 'Anime';

        // Portada desde /poster/slug-thumb.jpg cerca del link
        var portada = null;
        var chunk = html.slice(Math.max(0, m.index - 200), m.index + 500);
        var pm = chunk.match(/(?:src|data-src)=["'](\/?poster\/[^"']+)["']/i)
          || chunk.match(/(?:src|data-src)=["'](https?:\/\/[^"']*\/poster\/[^"']+)["']/i);
        if (pm) {
          portada = pm[1].indexOf('http') === 0 ? pm[1] : PELISPLUS_BASE + (pm[1].charAt(0) === '/' ? pm[1] : '/' + pm[1]);
          // Preferir poster completo sin -thumb si existe patrón
          portada = portada.replace(/-thumb\.(jpg|png|webp)/i, '.$1');
        }
        if (!portada) {
          portada = PELISPLUS_BASE + '/poster/' + slug + '.jpg';
        }

        var titulo = tituloDesdeSlug(slug);
        // Título visible en el HTML (alt o texto)
        var tm = chunk.match(/alt=["']([^"']{3,80})["']/i)
          || chunk.match(/title=["']([^"']{3,80})["']/i);
        if (tm) titulo = limpiarTitulo(limpiarTexto(tm[1]));

        // Año desde HTML cercano o slug (la-captura-2026)
        var yearPp = null;
        var ymChunk = chunk.match(/\b((?:19|20)\d{2})\b/);
        if (ymChunk) yearPp = ymChunk[1];
        if (!yearPp) {
          var ymSlug = String(slug).match(/(?:^|-)((?:19|20)\d{2})$/);
          if (ymSlug) yearPp = ymSlug[1];
        }
        // Título tipo "La captura (2026)"
        var ymTit = String(titulo).match(/\(((?:19|20)\d{2})\)/);
        if (ymTit) yearPp = ymTit[1];

        out.push({
          titulo: titulo,
          tipo: tipo,
          fuente: 'pelisplushd',
          link: full,
          slug: slug,
          portada: portada,
          year: yearPp
        });
      }
    } catch (e) { /* next variante */ }
  }

  // Fallback: si la web indexó el título con mojibake y el search no devuelve nada,
  // probar URL directa por slug (codigo-venganza, etc.)
  if (out.length === 0 && variantes.length) {
    var slugTry = String(variantes[variantes.length - 1] || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s\-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (slugTry && slugTry.length > 2) {
      var kinds = ['pelicula', 'serie', 'anime'];
      for (var ki = 0; ki < kinds.length; ki++) {
        try {
          var direct = PELISPLUS_BASE + '/' + kinds[ki] + '/' + slugTry + '/';
          var dr = await fetch(direct, {
            headers: Object.assign({}, HEADERS, { 'Referer': PELISPLUS_BASE + '/' }),
            redirect: 'follow'
          });
          if (!dr.ok) continue;
          var dhtml = await dr.text();
          // Página real de ficha (no 404 genérico)
          if (!/\/(pelicula|serie|anime)\//i.test(dr.url || direct) && dhtml.length < 500) continue;
          if (/no encontrada|not found|404/i.test(dhtml.slice(0, 2000))) continue;
          var tipoD = kinds[ki] === 'serie' ? 'Serie' : kinds[ki] === 'anime' ? 'Anime' : 'Pelicula';
          var tituloD = tituloDesdeSlug(slugTry);
          var tmD = dhtml.match(/<title>([^<]{3,120})<\/title>/i);
          if (tmD) tituloD = limpiarTitulo(tmD[1].split('|')[0].split('-')[0]);
          out.push({
            titulo: tituloD,
            tipo: tipoD,
            fuente: 'pelisplushd',
            link: direct,
            slug: slugTry,
            portada: PELISPLUS_BASE + '/poster/' + slugTry + '.jpg'
          });
          break;
        } catch (eDir) { /* next kind */ }
      }
    }
  }
  return out;
}

// ======================================================
// LAMOVIE
// ======================================================
function extraerSlugLamovie(pageUrl) {
  var m = pageUrl.match(/\/(?:peliculas|series|animes|pelicula|serie|anime)\/([^\/\?]+)/i);
  return m ? m[1].replace(/\/$/, '') : null;
}

function slugAQuery(slug) {
  return String(slug || '').replace(/-\d{4}$/, '').replace(/-/g, ' ').trim();
}

async function buscarPostIdPorSlug(slug) {
  var queries = [];
  var q1 = slugAQuery(slug) || slug;
  queries.push(q1);
  // Sin año al final del query: "diario de una pasion 2004" → "diario de una pasion"
  var q2 = String(q1).replace(/\s+(19|20)\d{2}\s*$/, '').trim();
  if (q2 && q2 !== q1) queries.push(q2);
  // Solo slug sin guiones
  if (slug && queries.indexOf(slug) === -1) queries.push(slug);

  for (var qi = 0; qi < queries.length; qi++) {
    var query = queries[qi];
    if (!query) continue;
    try {
      var url = LAMOVIE_API + '/search?postType=any&q=' + encodeURIComponent(query) + '&postsPerPage=15';
      var res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'Accept': 'application/json',
          'Referer': LAMOVIE_BASE + '/'
        }
      });
      if (!res.ok) continue;
      var data = await res.json();
      var posts = [];
      if (data && data.data && data.data.posts) posts = data.data.posts;
      else if (data && data.data && Array.isArray(data.data)) posts = data.data;
      if (!Array.isArray(posts) || posts.length === 0) continue;

      // Match exacto de slug
      for (var i = 0; i < posts.length; i++) {
        if (posts[i].slug === slug) return { postId: posts[i]._id, post: posts[i] };
      }
      // Slug sin año
      var slugNoYear = String(slug).replace(/-\d{4}$/, '');
      for (var i2 = 0; i2 < posts.length; i2++) {
        if (posts[i2].slug === slugNoYear || posts[i2].slug === slug) {
          return { postId: posts[i2]._id, post: posts[i2] };
        }
      }
      for (var j = 0; j < posts.length; j++) {
        if (posts[j].slug && (posts[j].slug.indexOf(slugNoYear) !== -1 || slugNoYear.indexOf(posts[j].slug) !== -1)) {
          return { postId: posts[j]._id, post: posts[j] };
        }
      }
      // Primer resultado solo si el título se parece
      if (posts[0] && posts[0]._id) {
        return { postId: posts[0]._id, post: posts[0] };
      }
    } catch (eQ) { /* next query */ }
  }
  return null;
}

async function getPlayerLamovie(postId) {
  var url = LAMOVIE_API + '/player?postId=' + postId + '&demo=0';
  var res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Accept': 'application/json',
      'Referer': LAMOVIE_BASE + '/'
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' en /player');

  var data = await res.json();
  var embedsRaw = (data && data.data && data.data.embeds) ? data.data.embeds : [];
  var downloadsRaw = (data && data.data && data.data.downloads) ? data.data.downloads : [];

  if ((!embedsRaw || embedsRaw.length === 0) && data && data.data) {
    var d = data.data;
    embedsRaw = [].concat(d.players || [], d.servers || [], d.sources || [], d.links || []);
  }

  var embeds = [];
  var downloads = [];
  var vistos = {};

  for (var i = 0; i < embedsRaw.length; i++) {
    var e = embedsRaw[i];
    var u = typeof e === 'string' ? e : (e.url || e.link || e.src || null);
    if (!u || vistos[u]) continue;
    if (!esReproductorValido(u)) continue;
    vistos[u] = true;
    embeds.push({
      url: u,
      idioma: (e && (e.lang || e.language || e.idioma)) || 'Desconocido',
      servidor: (e && e.server) || extraerServidor(u),
      calidad: (e && (e.quality || e.calidad)) || null,
      tipo: 'reproductor'
    });
  }

  for (var j = 0; j < downloadsRaw.length; j++) {
    var dl = downloadsRaw[j];
    var du = typeof dl === 'string' ? dl : (dl.url || dl.link || dl.href || null);
    if (!du || vistos[du]) continue;
    if (!esDescargaValida(du)) continue;
    vistos[du] = true;
    downloads.push({
      url: du,
      servidor: (dl && dl.server) || extraerServidor(du),
      calidad: (dl && (dl.quality || dl.calidad)) || null,
      size: (dl && dl.size) || null,
      tipo: 'descarga'
    });
  }

  embeds.sort(function (a, b) {
    var aV = a.url.toLowerCase().indexOf('vimeos') !== -1 ? 1 : 0;
    var bV = b.url.toLowerCase().indexOf('vimeos') !== -1 ? 1 : 0;
    return bV - aV;
  });

  return { embeds: embeds, downloads: downloads };
}

async function getEpisodesLamovie(serieId, season) {
  season = season || 1;
  var url = LAMOVIE_API + '/single/episodes/list?_id=' + encodeURIComponent(serieId) +
    '&season=' + season + '&page=1&postsPerPage=50';
  var res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Accept': 'application/json',
      'Referer': LAMOVIE_BASE + '/'
    }
  });
  if (!res.ok) return { posts: [], seasons: [] };
  var data = await res.json();
  var d = (data && data.data) ? data.data : {};
  var posts = Array.isArray(d.posts) ? d.posts : [];
  var seasons = Array.isArray(d.seasons)
    ? d.seasons.map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); })
    : [];
  return { posts: posts, seasons: seasons };
}

async function scrapearLamovie(pageUrl, opts) {
  opts = opts || {};
  var incluirPlayers = !!opts.players;
  var maxCaps = opts.maxCaps || 5;
  var seasonOnly = opts.season ? parseInt(opts.season, 10) : null;
  var episodeOnly = opts.episode ? parseInt(opts.episode, 10) : null;

  var slug = extraerSlugLamovie(pageUrl);
  if (!slug) throw new Error('No se pudo extraer el slug de la URL de Lamovie');

  var encontrado = await buscarPostIdPorSlug(slug);
  // Reintento: query sin año (diario-de-una-pasion-2004 → diario de una pasion)
  if (!encontrado || !encontrado.postId) {
    var slugSinAnio = String(slug).replace(/-\d{4}$/, '');
    if (slugSinAnio && slugSinAnio !== slug) {
      encontrado = await buscarPostIdPorSlug(slugSinAnio);
    }
  }
  if (!encontrado || !encontrado.postId) {
    throw new Error('No se encontro postId para el slug: ' + slug);
  }

  var postId = encontrado.postId;
  var post = encontrado.post || {};

  var tipo = 'Pelicula';
  if (post.type === 'tvshows' || /\/series\//i.test(pageUrl)) tipo = 'Serie';
  if (post.type === 'animes' || /\/animes\//i.test(pageUrl)) tipo = 'Anime';

  var titulo = post.title || 'Sin titulo';
  var portada = '';
  if (post.images && post.images.poster) {
    portada = post.images.poster.indexOf('http') === 0
      ? post.images.poster
      : 'https://lamovie.org/wp-content/uploads' + post.images.poster;
  }
  var descripcion = post.overview || '';
  var year = post.release_date ? String(post.release_date).slice(0, 4) : null;
  var calificacion = post.rating || post.imdb_rating || null;

  var workerOrigin = '';
  try {
    if (opts.requestUrl) workerOrigin = new URL(opts.requestUrl).origin;
  } catch (e) { /* ignore */ }

  // PELÍCULA
  if (tipo === 'Pelicula') {
    var playerData = { embeds: [], downloads: [] };
    try {
      playerData = await getPlayerLamovie(postId);
    } catch (ePl) {
      // Meta sí; players opcionales (no tumbar el detalle entero)
      playerData = { embeds: [], downloads: [] };
    }
    return {
      success: true,
      fuente: 'lamovie',
      source_id: '1',
      tipo: tipo,
      link: pageUrl,
      postId: postId,
      slug: slug,
      titulo: titulo,
      portada: portada,
      descripcion: descripcion,
      year: year,
      calificacion: calificacion,
      total: (playerData.embeds && playerData.embeds.length) || 0,
      embeds: (playerData.embeds || []).map(function (e) { return e.url; }),
      reproductores: playerData.embeds || [],
      descargas: playerData.downloads || [],
      temporadas: []
    };
  }

  // EPISODIO CONCRETO: ?url=SERIE&season=1&episode=1
  if (seasonOnly && episodeOnly) {
    var epList = await getEpisodesLamovie(postId, seasonOnly);
    var postsEps = epList.posts || [];
    var targetEp = null;
    for (var i = 0; i < postsEps.length; i++) {
      var n = postsEps[i].episode_number || (i + 1);
      if (parseInt(n, 10) === episodeOnly) {
        targetEp = postsEps[i];
        break;
      }
    }
    if (!targetEp) {
      throw new Error('No se encontro el episodio ' + seasonOnly + 'x' + episodeOnly);
    }
    var epId = targetEp._id || targetEp.id;
    var pd = await getPlayerLamovie(epId);
    var epTitulo = targetEp.title || (titulo + ': Temporada ' + seasonOnly + ' Episodio ' + episodeOnly);
    return {
      success: true,
      fuente: 'lamovie',
      tipo: 'Capitulo',
      link: pageUrl,
      postId: epId,
      serie_postId: postId,
      serie_titulo: titulo,
      titulo: epTitulo,
      portada: portada,
      temporada: seasonOnly,
      episodio: episodeOnly,
      overview: targetEp.overview || '',
      still: targetEp.still_path
        ? (String(targetEp.still_path).indexOf('http') === 0
            ? targetEp.still_path
            : 'https://image.tmdb.org/t/p/w300' + targetEp.still_path)
        : null,
      total: pd.embeds.length,
      embeds: pd.embeds.map(function (e) { return e.url; }),
      reproductores: pd.embeds,
      descargas: pd.downloads
    };
  }

  // SERIE / ANIME (listado)
  var first = await getEpisodesLamovie(postId, 1);
  var seasonNums = first.seasons && first.seasons.length ? first.seasons.slice() : [1];
  if (seasonOnly) seasonNums = [seasonOnly];

  var temporadas = [];
  var totalEps = 0;
  var resolvedPlayers = 0;

  for (var si = 0; si < seasonNums.length; si++) {
    var seasonNum = seasonNums[si];
    var epData = (seasonNum === 1 && !seasonOnly) ? first : await getEpisodesLamovie(postId, seasonNum);
    var postsList = epData.posts || [];

    if (epData.seasons && epData.seasons.length && !seasonOnly) {
      for (var sx = 0; sx < epData.seasons.length; sx++) {
        var sn = parseInt(epData.seasons[sx], 10);
        if (!isNaN(sn) && seasonNums.indexOf(sn) === -1) seasonNums.push(sn);
      }
    }

    var episodios = [];
    for (var ei = 0; ei < postsList.length; ei++) {
      var ep = postsList[ei];
      var epId2 = ep._id || ep.id;
      var epNum = ep.episode_number || (ei + 1);
      var epSeason = ep.season_number || seasonNum;

      var epLink = pageUrl.replace(/\/$/, '') + '/';
      if (workerOrigin) {
        epLink = workerOrigin + '/?url=' + encodeURIComponent(pageUrl) +
          '&season=' + epSeason + '&episode=' + epNum;
      }

      var epObj = {
        postId: epId2,
        temporada: epSeason,
        episodio: epNum,
        titulo: ep.title || ('Episodio ' + epNum),
        slug: ep.slug || null,
        overview: ep.overview || '',
        runtime: ep.runtime || null,
        still: ep.still_path
          ? (String(ep.still_path).indexOf('http') === 0
              ? ep.still_path
              : 'https://image.tmdb.org/t/p/w300' + ep.still_path)
          : null,
        link: epLink,
        url: epLink,
        episodePostId: epId2,
        reproductor: null,
        embeds: [],
        reproductores: [],
        descargas: []
      };

      if (incluirPlayers && epId2 && resolvedPlayers < maxCaps) {
        try {
          var pd2 = await getPlayerLamovie(epId2);
          epObj.reproductores = pd2.embeds || [];
          epObj.embeds = (pd2.embeds || []).map(function (e) { return e.url; });
          epObj.reproductor = epObj.embeds[0] || null;
          epObj.descargas = pd2.downloads || [];
          resolvedPlayers++;
        } catch (e) { /* ignore */ }
      }

      episodios.push(epObj);
      totalEps++;
    }

    temporadas.push({
      temporada: seasonNum,
      total_episodios: episodios.length,
      episodios: episodios
    });
  }

  return {
    success: true,
    fuente: 'lamovie',
    tipo: tipo,
    link: pageUrl,
    postId: postId,
    titulo: titulo,
    portada: portada,
    descripcion: descripcion,
    year: year,
    calificacion: calificacion,
    total_temporadas: temporadas.length,
    total_episodios: totalEps,
    total: resolvedPlayers,
    embeds: [],
    reproductores: [],
    descargas: [],
    temporadas: temporadas,
    nota: incluirPlayers
      ? 'Players solo en los primeros ' + maxCaps + ' caps. Usa ?url=SERIE&season=N&episode=M o ?episodePostId=XXX para un capítulo.'
      : 'Usa ?url=SERIE&season=N&episode=M o el link de cada episodio para obtener los players.'
  };
}

// ======================================================
// PELISPLUSHD
// ======================================================
function extraerPlayurlsPelisplus(html) {
  var reproductores = [];
  var vistos = {};

  function add(u, idioma) {
    if (!u || vistos[u]) return;
    var ok = esReproductorValido(u) ||
      /streamwish|vidhide|voe\.|filemoon|dood|waaw|hqq|netu|uqload|mixdrop/i.test(u);
    if (!ok) return;
    vistos[u] = true;
    reproductores.push({
      url: u,
      idioma: idioma || 'Desconocido',
      servidor: extraerServidor(u),
      tipo: 'reproductor'
    });
  }

  var r1 = /data-url=["']([^"']+)["'][^>]*data-name=["']([^"']*)["']/gi;
  var m;
  while ((m = r1.exec(html)) !== null) add(m[1], m[2]);

  var r2 = /data-name=["']([^"']*)["'][^>]*data-url=["']([^"']+)["']/gi;
  while ((m = r2.exec(html)) !== null) add(m[2], m[1]);

  var r3 = /<span[^>]+lid=["']?\d+["']?[^>]+url=["']([^"']+)["'][^>]*>/gi;
  while ((m = r3.exec(html)) !== null) add(m[1], 'Desconocido');

  var r4 = /<span[^>]+url=["']([^"']+)["'][^>]+lid=["']?\d+["']?[^>]*>/gi;
  while ((m = r4.exec(html)) !== null) add(m[1], 'Desconocido');

  var r5 = /\burl=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = r5.exec(html)) !== null) add(m[1], 'Desconocido');

  return reproductores;
}

async function listarPelisplusCatalogo(seccion, filtro, page, origin) {
  seccion = (seccion || 'peliculas').toLowerCase();
  filtro = (filtro || '').toLowerCase();
  page = page || 1;

  var pathCat = '/' + seccion;
  if (filtro === 'estrenos' || filtro === 'populares') {
    pathCat += '/' + filtro;
  }
  var listUrl = PELISPLUS_BASE + pathCat + (page > 1 ? '?page=' + page : '');

  var res = await fetch(listUrl, {
    headers: Object.assign({}, HEADERS, { 'Referer': PELISPLUS_BASE + '/' })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' en catalogo PelisPlus');
  var html = await res.text();

  var tipoItem = 'Pelicula';
  var tipoPath = 'pelicula';
  if (seccion === 'series') { tipoItem = 'Serie'; tipoPath = 'serie'; }
  if (seccion === 'animes') { tipoItem = 'Anime'; tipoPath = 'anime'; }

  var items = [];
  var vistos = {};
  var m;

  // Tarjeta completa: <a href="/pelicula/slug" ...Posters-link...>...<img src="/poster/slug.jpg"...></a>
  var reCard = /<a\b[^>]*href=["'](?:https?:\/\/[^"']+)?\/(?:pelicula|serie|anime)\/([^"'\/\?]+)\/?["'][^>]*>[\s\S]*?<\/a>/gi;
  while ((m = reCard.exec(html)) !== null) {
    var slug = m[1];
    if (!slug || vistos[slug]) continue;
    if (PALABRAS_BLOQUEADAS_BUSQUEDA.some(function (w) { return slug.indexOf(w) !== -1; })) continue;
    if (!/Posters-link|\/poster\//i.test(m[0])) continue;
    vistos[slug] = true;

    var tag = m[0];
    var titulo = '';
    var tm = tag.match(/data-title=["']([^"']+)["']/i) || tag.match(/alt=["']([^"']+)["']/i);
    if (tm) titulo = limpiarTitulo(tm[1].replace(/^VER\s+/i, '').replace(/\s+Online.*$/i, ''));
    if (!titulo) titulo = limpiarTitulo(slug.replace(/-/g, ' '));

    var portada = '';
    // Buscar src de poster DENTRO de esta tarjeta
    var imgM = tag.match(/src=["']([^"']*\/poster\/[^"'\s>]+)["']/i)
      || tag.match(/data-src=["']([^"']*\/poster\/[^"'\s>]+)["']/i)
      || tag.match(/srcset=["']([^"'\s,>]*\/poster\/[^"'\s,>]+)/i);
    if (imgM) {
      portada = imgM[1];
      if (portada.indexOf('http') !== 0) {
        portada = PELISPLUS_BASE + (portada.charAt(0) === '/' ? portada : '/' + portada);
      }
    }
    // Si el src no coincide con el slug, preferir convención /poster/{slug}.jpg
    if (!portada || portada.indexOf('/poster/' + slug + '.') === -1) {
      var bySlug = PELISPLUS_BASE + '/poster/' + slug + '.jpg';
      // Solo forzar si no había imagen, o si la imagen es de otro slug
      if (!portada) portada = bySlug;
      else if (portada.indexOf('/poster/' + slug + '.') === -1) portada = bySlug;
    }

    items.push({
      titulo: titulo,
      tipo: tipoItem,
      fuente: 'pelisplushd',
      source_id: '3',
      slug: slug,
      portada: portada,
      url_extract: origin + '/3/' + tipoPath + '/' + slug
    });
  }

  return {
    success: true,
    fuente: 'pelisplushd',
    source_id: '3',
    seccion: seccion,
    filtro: filtro || 'todas',
    page: page,
    total: items.length,
    resultados: items
  };
}

async function scrapearPelisplus(pageUrl, opts) {
  opts = opts || {};
  var maxCaps = opts.maxCaps || 5;
  var incluirPlayers = !!opts.players;
  var seasonOnly = opts.season ? parseInt(opts.season, 10) : null;
  var episodeOnly = opts.episode ? parseInt(opts.episode, 10) : null;

  var workerOrigin = '';
  try {
    if (opts.requestUrl) workerOrigin = new URL(opts.requestUrl).origin;
  } catch (e) { /* ignore */ }

  // Si piden season+episode sobre URL de serie, construir URL del capítulo
  var esSerieRoot = (/\/serie\//i.test(pageUrl) || /\/anime\//i.test(pageUrl)) &&
    !/\/temporada\/\d+\/capitulo\/\d+/i.test(pageUrl);
  if (esSerieRoot && seasonOnly && episodeOnly) {
    var slugM = pageUrl.match(/\/(?:serie|anime)\/([^\/\?]+)/i);
    var tipoPath = /\/anime\//i.test(pageUrl) ? 'anime' : 'serie';
    if (slugM) {
      pageUrl = PELISPLUS_BASE + '/' + tipoPath + '/' + slugM[1] +
        '/temporada/' + seasonOnly + '/capitulo/' + episodeOnly + '/';
    }
  }

  var res = await fetch(pageUrl, {
    headers: Object.assign({}, HEADERS, { 'Referer': PELISPLUS_BASE + '/' })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var html = await res.text();

  var esSerie = /\/serie\//i.test(pageUrl) || /\/anime\//i.test(pageUrl);
  var esCapitulo = /\/temporada\/\d+\/capitulo\/\d+/i.test(pageUrl);

  var metas = extraerMetas(html);
  var titulo = metas.titulo;
  var portada = metas.portada;
  var descripcion = metas.descripcion;
  var yearMeta = metas.year || null;
  var generosMeta = metas.generos || [];
  var generoMeta = metas.genero || null;
  var actoresMeta = metas.actores || [];

  // Serie raíz → listar capítulos
  if (esSerie && !esCapitulo) {
    var caps = [];
    var reCap = /href=["']((?:https?:\/\/[^"']+)?\/(?:serie|anime)\/[^"']+\/temporada\/(\d+)\/capitulo\/(\d+)\/?)["']/gi;
    var cm;
    var seen = {};
    while ((cm = reCap.exec(html)) !== null) {
      var href = cm[1];
      if (href.indexOf('http') !== 0) href = PELISPLUS_BASE + href;
      href = href.replace(/\/$/, '') + '/';
      var key = cm[2] + 'x' + cm[3];
      if (seen[key]) continue;
      seen[key] = true;

      var epSeason = parseInt(cm[2], 10);
      var epNum = parseInt(cm[3], 10);
      var epLink = href;
      if (workerOrigin) {
        // Link unificado: worker + season + episode
        epLink = workerOrigin + '/?url=' + encodeURIComponent(pageUrl) +
          '&season=' + epSeason + '&episode=' + epNum;
      }

      caps.push({
        temporada: epSeason,
        episodio: epNum,
        link: epLink,
        url: epLink,
        source_link: href,
        reproductor: null,
        embeds: [],
        reproductores: []
      });
    }

    // Filtrar por temporada si pidieron solo una
    if (seasonOnly) {
      caps = caps.filter(function (c) { return c.temporada === seasonOnly; });
    }

    var bySeason = {};
    for (var i = 0; i < caps.length; i++) {
      var s = caps[i].temporada;
      if (!bySeason[s]) bySeason[s] = [];
      bySeason[s].push(caps[i]);
    }

    var resolved = 0;
    if (incluirPlayers) {
      for (var j = 0; j < caps.length && resolved < maxCaps; j++) {
        try {
          var srcLink = caps[j].source_link || caps[j].link;
          var r2 = await fetch(srcLink, {
            headers: Object.assign({}, HEADERS, { 'Referer': PELISPLUS_BASE + '/' })
          });
          if (!r2.ok) continue;
          var h2 = await r2.text();
          var reps = extraerPlayurlsPelisplus(h2);
          caps[j].reproductores = reps;
          caps[j].embeds = reps.map(function (x) { return x.url; });
          caps[j].reproductor = reps[0] ? reps[0].url : null;
          resolved++;
        } catch (e) { /* ignore */ }
      }
    }

    var temporadas = Object.keys(bySeason).map(Number).sort(function (a, b) { return a - b; }).map(function (num) {
      return {
        temporada: num,
        total_episodios: bySeason[num].length,
        episodios: bySeason[num]
      };
    });

    return {
      success: true,
      fuente: 'pelisplushd',
      tipo: 'Serie',
      link: pageUrl,
      titulo: titulo,
      portada: portada,
      descripcion: descripcion,
      year: yearMeta,
      genero: generoMeta,
      generos: generosMeta,
      actores: actoresMeta,
      calificacion: metas.calificacion != null ? metas.calificacion : null,
      total_temporadas: temporadas.length,
      total_episodios: caps.length,
      total: resolved,
      embeds: [],
      reproductores: [],
      descargas: [],
      temporadas: temporadas,
      nota: incluirPlayers
        ? 'Players solo en los primeros ' + maxCaps + ' caps. Usa /3/serie/slug/T/E para un capítulo.'
        : 'Usa /3/serie/slug/T/E o url_video de cada episodio para obtener los players.'
    };
  }

  // Película o capítulo
  var reproductores = extraerPlayurlsPelisplus(html);
  var descargas = extraerDescargas(html);
  var capMatch = pageUrl.match(/\/temporada\/(\d+)\/capitulo\/(\d+)/i);
  return {
    success: true,
    fuente: 'pelisplushd',
    tipo: esCapitulo ? 'Capitulo' : 'Pelicula',
    link: pageUrl,
    titulo: titulo,
    portada: portada,
    descripcion: descripcion,
    year: yearMeta,
    genero: generoMeta,
    generos: generosMeta,
    actores: actoresMeta,
    calificacion: metas.calificacion != null ? metas.calificacion : null,
    temporada: capMatch ? parseInt(capMatch[1], 10) : null,
    episodio: capMatch ? parseInt(capMatch[2], 10) : null,
    total: reproductores.length,
    embeds: reproductores.map(function (r) { return r.url; }),
    reproductores: reproductores,
    descargas: descargas
  };
}

// ======================================================
// HACKSTORE
// ======================================================
async function resolverPlayPhp(playUrl, referer) {
  if (playUrl.indexOf('http') !== 0) {
    playUrl = HACKSTORE_BASE + (playUrl.indexOf('/') === 0 ? playUrl : '/' + playUrl);
  }
  playUrl = playUrl.replace(/&amp;/g, '&');
  var pr = await fetch(playUrl, {
    headers: Object.assign({}, HEADERS, { 'Referer': referer || HACKSTORE_BASE + '/' }),
    redirect: 'follow'
  });
  var phtml = await pr.text();
  var ifr = phtml.match(/<(?:iframe|embed)[^>]+src=["']([^"']+)["']/i);
  if (ifr && ifr[1] && esReproductorValido(ifr[1])) return ifr[1];
  var urls = phtml.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (var u = 0; u < urls.length; u++) {
    if (esReproductorValido(urls[u])) return urls[u];
  }
  return null;
}

async function scrapearHackstoreEpisodio(pageUrl) {
  var res = await fetch(pageUrl, {
    headers: Object.assign({}, HEADERS, { 'Referer': HACKSTORE_BASE + '/' })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var html = await res.text();

  var reproductores = [];
  var vistos = {};

  var rePlayr = /class=["'][^"']*playr[^"']*["'][^>]*data-href=["']([^"']+)["'][^>]*data-lang=["']([^"']*)["']/gi;
  var m;
  var jobs = [];
  while ((m = rePlayr.exec(html)) !== null) {
    jobs.push({ href: m[1].replace(/&amp;/g, '&'), lang: m[2] || 'Desconocido' });
  }
  var rePlayr2 = /data-href=["']([^"']*play\.php[^"']*)["'][^>]*data-lang=["']([^"']*)["']/gi;
  while ((m = rePlayr2.exec(html)) !== null) {
    jobs.push({ href: m[1].replace(/&amp;/g, '&'), lang: m[2] || 'Desconocido' });
  }

  var seenJob = {};
  var uniqueJobs = [];
  for (var j = 0; j < jobs.length; j++) {
    if (seenJob[jobs[j].href]) continue;
    seenJob[jobs[j].href] = true;
    uniqueJobs.push(jobs[j]);
  }

  for (var i = 0; i < Math.min(uniqueJobs.length, 8); i++) {
    try {
      var src = await resolverPlayPhp(uniqueJobs[i].href, pageUrl);
      if (src && !vistos[src]) {
        vistos[src] = true;
        reproductores.push({
          url: src,
          idioma: uniqueJobs[i].lang,
          servidor: extraerServidor(src),
          tipo: 'reproductor'
        });
      }
    } catch (e) { /* ignore */ }
  }

  var metas = extraerMetas(html);
  var descargas = extraerDescargas(html);

  return {
    success: true,
    fuente: 'hackstore',
    tipo: 'Capitulo',
    link: pageUrl,
    titulo: limpiarTitulo(metas.titulo),
    portada: extraerPortadaHackstore(html) || normalizarPortadaUrl(metas.portada) || metas.portada,
    descripcion: limpiarTexto(metas.descripcion),
    total: reproductores.length,
    embeds: reproductores.map(function (r) { return r.url; }),
    reproductores: reproductores,
    descargas: descargas
  };
}

async function scrapearHackstore(pageUrl, opts) {
  opts = opts || {};
  var maxCaps = opts.maxCaps || 5;
  var incluirPlayers = !!opts.players;
  var seasonOnly = opts.season ? parseInt(opts.season, 10) : null;
  var episodeOnly = opts.episode ? parseInt(opts.episode, 10) : null;

  var workerOrigin = '';
  try {
    if (opts.requestUrl) workerOrigin = new URL(opts.requestUrl).origin;
  } catch (e) { /* ignore */ }

  // Episodio directo por URL
  if (/\/episodio\//i.test(pageUrl)) {
    return scrapearHackstoreEpisodio(pageUrl);
  }

  var res = await fetch(pageUrl, {
    headers: Object.assign({}, HEADERS, { 'Referer': HACKSTORE_BASE + '/' })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var html = await res.text();

  var esSerie = /\/series\//i.test(pageUrl) || /\/animes\//i.test(pageUrl);

  if (esSerie) {
    var caps = [];
    var seen = {};
    var reEp = /href=["'](https?:\/\/(?:www\.)?hackstore\.[a-z]+\/episodio\/([^"'\/\?]+))\/?["']/gi;
    var em;
    while ((em = reEp.exec(html)) !== null) {
      var link = em[1].replace(/\/$/, '') + '/';
      var slug = em[2];
      if (seen[link]) continue;
      seen[link] = true;
      var sx = slug.match(/(\d+)x(\d+)/i);
      var epSeason = sx ? parseInt(sx[1], 10) : 1;
      var epNum = sx ? parseInt(sx[2], 10) : caps.length + 1;

      var epLink = link;
      if (workerOrigin) {
        epLink = workerOrigin + '/?url=' + encodeURIComponent(pageUrl) +
          '&season=' + epSeason + '&episode=' + epNum;
      }

      caps.push({
        temporada: epSeason,
        episodio: epNum,
        link: epLink,
        url: epLink,
        source_link: link,
        slug: slug,
        reproductor: null,
        embeds: [],
        reproductores: []
      });
    }

    // Filtrar por temporada si pidieron
    if (seasonOnly) {
      caps = caps.filter(function (c) { return c.temporada === seasonOnly; });
    }

    // Episodio concreto: ?url=SERIE&season=1&episode=1
    if (seasonOnly && episodeOnly) {
      var target = null;
      for (var ti = 0; ti < caps.length; ti++) {
        if (caps[ti].temporada === seasonOnly && caps[ti].episodio === episodeOnly) {
          target = caps[ti];
          break;
        }
      }
      if (!target) {
        throw new Error('No se encontro el episodio ' + seasonOnly + 'x' + episodeOnly);
      }
      return scrapearHackstoreEpisodio(target.source_link || target.link);
    }

    if (incluirPlayers) {
      for (var i = 0; i < Math.min(caps.length, maxCaps); i++) {
        try {
          var epData = await scrapearHackstoreEpisodio(caps[i].source_link || caps[i].link);
          caps[i].reproductores = epData.reproductores || [];
          caps[i].embeds = epData.embeds || [];
          caps[i].reproductor = caps[i].embeds[0] || null;
        } catch (e) { /* ignore */ }
      }
    }

    var bySeason = {};
    for (var k = 0; k < caps.length; k++) {
      var s = caps[k].temporada;
      if (!bySeason[s]) bySeason[s] = [];
      bySeason[s].push(caps[k]);
    }
    var temporadas = Object.keys(bySeason).map(Number).sort(function (a, b) { return a - b; }).map(function (num) {
      return { temporada: num, total_episodios: bySeason[num].length, episodios: bySeason[num] };
    });

    var metas = extraerMetas(html);
    var portadaHs = extraerPortadaHackstore(html) || normalizarPortadaUrl(metas.portada) || metas.portada;
    var yearHs = null;
    var ym = (metas.titulo || pageUrl).match(/\((\d{4})\)/) || pageUrl.match(/-(\d{4})\/?$/);
    if (ym) yearHs = ym[1];

    return {
      success: true,
      fuente: 'hackstore',
      tipo: 'Serie',
      link: pageUrl,
      titulo: limpiarTitulo(metas.titulo),
      portada: portadaHs,
      descripcion: limpiarTexto(metas.descripcion),
      year: yearHs,
      calificacion: null,
      total_temporadas: temporadas.length,
      total_episodios: caps.length,
      total: caps.filter(function (c) { return c.reproductor; }).length,
      embeds: [],
      reproductores: [],
      descargas: [],
      temporadas: temporadas,
      nota: incluirPlayers
        ? 'Players solo en los primeros ' + maxCaps + ' caps. Usa /2/serie/slug/T/E para un capítulo.'
        : 'Usa /2/serie/slug/T/E o url_video de cada episodio para obtener los players.'
    };
  }

  // Película
  var reproductores = [];
  var descargas = [];
  var vistos = {};

  var playMatches = html.match(/(?:https?:\/\/[^"'<>\s]*)?\/play\.php\?[^"'<>\s]+/gi) || [];
  var dataHref = html.match(/data-href=["']([^"']*play\.php[^"']*)["']/gi) || [];
  for (var d = 0; d < dataHref.length; d++) {
    var hm = dataHref[d].match(/data-href=["']([^"']+)["']/i);
    if (hm) playMatches.push(hm[1]);
  }

  for (var j = 0; j < Math.min(8, playMatches.length); j++) {
    try {
      var src = await resolverPlayPhp(playMatches[j], pageUrl);
      if (src && !vistos[src] && esReproductorValido(src)) {
        vistos[src] = true;
        reproductores.push({ url: src, idioma: 'Desconocido', servidor: extraerServidor(src), tipo: 'reproductor' });
      }
    } catch (e) { /* ignore */ }
  }

  var metasP = extraerMetas(html);
  descargas = extraerDescargas(html);
  var portadaPel = extraerPortadaHackstore(html) || normalizarPortadaUrl(metasP.portada) || metasP.portada;
  var yearPel = null;
  var ymP = (metasP.titulo || pageUrl).match(/\((\d{4})\)/) || pageUrl.match(/-(\d{4})\/?$/);
  if (ymP) yearPel = ymP[1];

  return {
    success: true,
    fuente: 'hackstore',
    tipo: 'Pelicula',
    link: pageUrl,
    titulo: limpiarTitulo(metasP.titulo),
    portada: portadaPel,
    descripcion: limpiarTexto(metasP.descripcion),
    year: yearPel,
    calificacion: null,
    total: reproductores.length,
    embeds: reproductores.map(function (r) { return r.url; }),
    reproductores: reproductores,
    descargas: descargas
  };
}


// ======================================================
// ANIMEAV1 (https://animeav1.com) — SvelteKit __data.json
// source_id = 4
// ======================================================

async function fetchAnimeAv1Data(pathAndQuery) {
  var p = String(pathAndQuery || '');
  if (p.charAt(0) !== '/') p = '/' + p;
  var url = ANIMEAV1_BASE + p;
  if (url.indexOf('__data.json') === -1) {
    // /catalogo/__data.json?search=x  vs  /media/slug/1/__data.json
    if (url.indexOf('?') !== -1) {
      url = url.replace('?', '/__data.json?');
      url = url.replace('/__data.json/__data.json', '/__data.json');
    } else {
      if (url.charAt(url.length - 1) === '/') url = url.slice(0, -1);
      url += '/__data.json';
    }
  }
  var res = await fetch(url, {
    headers: {
      'User-Agent': HEADERS['User-Agent'],
      'Accept': 'application/json',
      'Referer': ANIMEAV1_BASE + '/'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('AnimeAV1 HTTP ' + res.status + ' en ' + url);
  return await res.json();
}

/** Decodifica el formato SvelteKit nodes[].data (referencias por índice) */
function decodeSvelteKitData(payload) {
  var nodes = (payload && payload.nodes) || [];
  var arr = null;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n && n.data && Array.isArray(n.data) && n.data.length > 2) {
      arr = n.data;
      break;
    }
  }
  if (!arr) return null;
  var memo = {};
  function resolve(idx, stack) {
    stack = stack || {};
    if (typeof idx !== 'number') return idx;
    if (stack[idx]) return null;
    if (memo[idx] !== undefined) return memo[idx];
    if (idx < 0 || idx >= arr.length) return null;
    stack[idx] = true;
    var val = arr[idx];
    if (val === null || typeof val === 'boolean' || typeof val === 'string' || typeof val === 'number') {
      memo[idx] = val;
      delete stack[idx];
      return val;
    }
    if (Array.isArray(val)) {
      var outA = [];
      for (var j = 0; j < val.length; j++) {
        outA.push(typeof val[j] === 'number' ? resolve(val[j], stack) : val[j]);
      }
      memo[idx] = outA;
      delete stack[idx];
      return outA;
    }
    if (typeof val === 'object') {
      var outO = {};
      var keys = Object.keys(val);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var v = val[key];
        outO[key] = typeof v === 'number' ? resolve(v, stack) : v;
      }
      memo[idx] = outO;
      delete stack[idx];
      return outO;
    }
    memo[idx] = val;
    delete stack[idx];
    return val;
  }
  var root = arr[0];
  if (!root || typeof root !== 'object') return null;
  var result = {};
  var rkeys = Object.keys(root);
  for (var r = 0; r < rkeys.length; r++) {
    var rk = rkeys[r];
    var rv = root[rk];
    result[rk] = typeof rv === 'number' ? resolve(rv) : rv;
  }
  return result;
}

/** Poster desde Jikan/MAL por malId (animeav1 a menudo no trae poster en JSON) */
async function fetchPosterMal(malId) {
  if (!malId) return null;
  try {
    var url = 'https://api.jikan.moe/v4/anime/' + encodeURIComponent(String(malId));
    var res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': HEADERS['User-Agent'] }
    });
    if (!res.ok) return null;
    var data = await res.json();
    var img = data && data.data && data.data.images;
    if (!img) return null;
    var jpg = img.jpg || {};
    var webp = img.webp || {};
    return jpg.large_image_url || jpg.image_url || webp.large_image_url || webp.image_url || null;
  } catch (e) {
    return null;
  }
}

function animeAv1Poster(slug, malId) {
  // Path MAL directo no es fiable (necesita folder id); usar fetchPosterMal async
  return null;
}

function normalizarIdiomaLabel(lang) {
  var L = String(lang || '').toUpperCase().trim();
  if (!L) return 'Desconocido';
  if (L === 'SUB' || L === 'SOFTSUB' || L === 'SUBS' || /SUBTIT/.test(L)) return 'Subtitulado';
  if (L === 'LAT' || L === 'LATINO' || L === 'DUB' || L === 'DUBLADO' || L === 'ESP' || L === 'ES' ||
      L === 'AUDIO LATINO' || L === 'CAST' || L === 'CASTELLANO' || /LATIN/.test(L) || /ESPA/.test(L)) {
    return 'Latino';
  }
  if (L === 'ENG' || L === 'EN' || L === 'VOSE') return 'Inglés';
  return lang;
}

/**
 * Número de temporada desde título o slug.
 * "One Punch Man 3" → 3
 * "One Punch Man 2nd Season Specials" → 2
 * slug one-punch-man-season-2 / -2nd-season / -s2 → 2
 * Si no se detecta → 1
 */
function extraerNumeroTemporada(titulo, slug) {
  var t = String(titulo || '');
  var s = String(slug || '').toLowerCase();

  // Slug: -season-N, -temporada-N, -Nth-season, -sN, -part-N
  var ms = s.match(/(?:^|-)(?:season|temporada|part|parte)-(\d+)(?:-|$)/i)
    || s.match(/(?:^|-)(\d+)(?:st|nd|rd|th)-season(?:-|$)/i)
    || s.match(/(?:^|-)s(\d+)(?:-|$)/i);
  if (ms) {
    var nS = parseInt(ms[1], 10);
    if (nS >= 1 && nS <= 50) return nS;
  }
  // Slug termina en -N (one-punch-man-3) — solo si N es 2–20 y no parece año
  var me = s.match(/-(\d{1,2})$/);
  if (me) {
    var nE = parseInt(me[1], 10);
    if (nE >= 2 && nE <= 20) return nE;
  }

  // Título: "2nd Season", "Season 2", "Temporada 2", "2ª temporada"
  var mt = t.match(/(\d+)(?:st|nd|rd|th)\s*season/i)
    || t.match(/(?:season|temporada|parte?)\s*(\d+)/i)
    || t.match(/(\d+)\s*ª\s*temporada/i);
  if (mt) {
    var nT = parseInt(mt[1], 10);
    if (nT >= 1 && nT <= 50) return nT;
  }
  // Título: "One Punch Man 3" / "One Punch Man III" al final (no año 4 dígitos)
  var mt2 = t.match(/\s+(\d{1,2})\s*(?:$|[:\-–—]|special|ova|ona|movie|film|especial)/i);
  if (mt2) {
    var n2 = parseInt(mt2[1], 10);
    if (n2 >= 2 && n2 <= 20) return n2;
  }

  return 1;
}

/**
 * Formato anime: TV / OVA / ONA / Especial / Pelicula
 */
function detectarFormatoAnime(titulo, category, slug) {
  var blob = [titulo, category, slug].map(function (x) { return String(x || ''); }).join(' ');
  if (/ova\b/i.test(blob)) return 'OVA';
  if (/\bona\b/i.test(blob)) return 'ONA';
  if (/specials?|especiales?/i.test(blob)) return 'Especial';
  if (/movie|pel[ií]cula|film/i.test(blob)) return 'Pelicula';
  if (/tv\s*special/i.test(blob)) return 'Especial';
  return 'TV';
}

/** ¿Texto parece español? */
function pareceEspanol(txt) {
  var s = String(txt || '');
  if (!s || s.length < 20) return false;
  if (/[áéíóúñü¿¡]/i.test(s)) return true;
  var esWords = (s.match(/\b(el|la|los|las|de|del|que|en|un|una|por|con|para|como|más|también|después|cuando|sobre|entre|hasta|desde|sin|este|esta|estos|sus|su|se|es|son|fue|ser|está|están)\b/gi) || []).length;
  var enWords = (s.match(/\b(the|and|with|from|after|when|his|her|their|this|that|was|were|are|is|for|into|about|which|who|whom)\b/gi) || []).length;
  return esWords >= 3 && esWords > enWords;
}

/** ¿Texto parece inglés? */
function pareceIngles(txt) {
  var s = String(txt || '');
  if (!s || s.length < 20) return false;
  if (/[áéíóúñü¿¡]/i.test(s)) return false;
  var enWords = (s.match(/\b(the|and|with|from|after|when|his|her|their|this|that|was|were|are|is|for|into|about|which)\b/gi) || []).length;
  return enWords >= 3;
}

/** Extrae año 19xx/20xx de título, slug o fecha */
function extraerYearFlexible(titulo, slug, fecha) {
  if (fecha) {
    var yf = String(fecha).match(/(19|20)\d{2}/);
    if (yf) return yf[0];
  }
  var t = String(titulo || '');
  var yt = t.match(/\b((?:19|20)\d{2})\b/);
  if (yt) return yt[1];
  var s = String(slug || '');
  var ys = s.match(/(?:^|-)((?:19|20)\d{2})(?:-|$)/);
  if (ys) return ys[1];
  return null;
}

function esIdiomaLatino(label) {
  return /latino|castellano|español|dub/i.test(String(label || ''));
}

function mapAnimeAv1Embeds(embedsObj) {
  var reproductores = [];
  var descargas = [];
  if (!embedsObj || typeof embedsObj !== 'object') return { reproductores: reproductores, descargas: descargas };
  var langs = Object.keys(embedsObj);
  // Orden preferido de claves: LAT/DUB antes que SUB
  langs.sort(function (a, b) {
    var ra = esIdiomaLatino(normalizarIdiomaLabel(a)) ? 0 : 1;
    var rb = esIdiomaLatino(normalizarIdiomaLabel(b)) ? 0 : 1;
    return ra - rb;
  });
  for (var i = 0; i < langs.length; i++) {
    var lang = langs[i];
    var list = embedsObj[lang];
    if (!Array.isArray(list)) continue;
    var idioma = normalizarIdiomaLabel(lang);
    for (var j = 0; j < list.length; j++) {
      var e = list[j];
      if (!e || !e.url) continue;
      var url = e.url;
      var server = e.server || extraerServidor(url);
      var isDl = /mega\.nz\/file|1fichier|mediafire|download/i.test(url) && !/embed/i.test(url);
      var row = {
        url: url,
        idioma: idioma,
        lang: lang,
        servidor: server,
        tipo: isDl ? 'descarga' : 'reproductor'
      };
      if (isDl) descargas.push(row);
      else if (esReproductorValido(url) || /zilla-networks|uns\.bio|mp4upload|mega\.nz\/embed|yourupload|streamtape|vidhide|ryderjet/i.test(url)) {
        reproductores.push(row);
      }
    }
  }
  // Latino primero en la lista final
  reproductores.sort(function (a, b) {
    var la = esIdiomaLatino(a.idioma) ? 0 : 1;
    var lb = esIdiomaLatino(b.idioma) ? 0 : 1;
    return la - lb;
  });
  descargas.sort(function (a, b) {
    var la = esIdiomaLatino(a.idioma) ? 0 : 1;
    var lb = esIdiomaLatino(b.idioma) ? 0 : 1;
    return la - lb;
  });
  return { reproductores: reproductores, descargas: descargas };
}


/**
 * Catálogo AnimeAV1 (estrenos / en emisión)
 * https://animeav1.com/catalogo?status=emision
 * Ruta: /4/animes/estrenos  o  /4/animes/emision
 */
async function listarAnimeAv1Catalogo(filtro, page, origin) {
  page = page || 1;
  filtro = (filtro || 'emision').toLowerCase();
  // AnimeAV1: emision | proximo (status=1) | populares (sin filtro)
  var statusParam = 'emision';
  if (filtro === 'populares') statusParam = '';
  else if (filtro === 'proximo' || filtro === 'proximamente' || filtro === 'upcoming') statusParam = '1';
  else if (filtro === 'estrenos' || filtro === 'emision') statusParam = 'emision';
  var path = '/catalogo/__data.json?page=' + page;
  if (statusParam) path += '&status=' + encodeURIComponent(statusParam);

  var raw = await fetchAnimeAv1Data(path);
  var data = decodeSvelteKitData(raw);
  var results = (data && Array.isArray(data.results)) ? data.results : [];
  var out = [];
  for (var i = 0; i < results.length; i++) {
    var it = results[i];
    if (!it || !it.slug) continue;
    var catName = (it.category && it.category.name) || '';
    var tit = it.title || it.slug;
    var formato = detectarFormatoAnime(tit, catName, it.slug);
    var tipo = formato === 'Pelicula' ? 'Pelicula' : 'Anime';
    var portada = it.poster || it.image || it.cover || it.thumbnail || null;
    if (!portada && it.id != null && String(it.id).match(/^\d+$/)) {
      portada = 'https://cdn.animeav1.com/covers/' + it.id + '.jpg';
    }
    if (portada && typeof portada === 'string' && portada.indexOf('http') !== 0) {
      portada = 'https://cdn.animeav1.com/covers/' + String(portada).replace(/^.*\//, '');
    }
    var yearAv = extraerYearFlexible(tit, it.slug, it.startDate || it.year);
    out.push({
      fuente: 'animeav1',
      source_id: '4',
      tipo: tipo,
      formato: formato,
      titulo: tit,
      slug: it.slug,
      portada: portada,
      year: yearAv,
      link: ANIMEAV1_BASE + '/media/' + it.slug,
      url_extract: (origin || '') + '/4/anime/' + it.slug,
      estado: statusParam === 'emision' ? 'En emisión' : (statusParam === '1' ? 'Próximamente' : null),
      en_emision: statusParam === 'emision' ? true : false,
      finalizado: false
    });
  }
  return {
    success: true,
    fuente: 'animeav1',
    seccion: 'animes',
    filtro: filtro,
    page: page,
    total: out.length,
    resultados: out
  };
}

async function buscarAnimeAv1(query, limit) {
  limit = limit || 30;
  var out = [];
  var seen = Object.create(null);
  var totalApi = null;
  // Paginar: animeav1 suele devolver ~20 por página
  var maxPages = Math.min(6, Math.max(2, Math.ceil(limit / 15) + 1));
  for (var page = 1; page <= maxPages && out.length < limit * 2; page++) {
    var path = '/catalogo/__data.json?search=' + encodeURIComponent(query) + '&page=' + page;
    var raw;
    try {
      raw = await fetchAnimeAv1Data(path);
    } catch (ePage) {
      break;
    }
    var data = decodeSvelteKitData(raw);
    if (!data || !Array.isArray(data.results) || !data.results.length) break;
    if (totalApi == null && data.total != null) totalApi = Number(data.total) || null;
    var added = 0;
    for (var i = 0; i < data.results.length; i++) {
      var it = data.results[i];
      if (!it || !it.slug || seen[it.slug]) continue;
      seen[it.slug] = true;
      var catName = (it.category && it.category.name) || '';
      var titAv1 = it.title || it.slug;
      var formatoAv1 = detectarFormatoAnime(titAv1, catName, it.slug);
      var tipo = formatoAv1 === 'Pelicula' ? 'Pelicula' : 'Anime';
      var portadaAv1 = it.poster || it.image || it.cover || it.thumbnail || it.coverImage || null;
      if (!portadaAv1 && it.id != null && String(it.id).match(/^\d+$/)) {
        portadaAv1 = 'https://cdn.animeav1.com/covers/' + it.id + '.jpg';
      }
      if (portadaAv1 && typeof portadaAv1 === 'string' && portadaAv1.indexOf('http') !== 0) {
        if (/^\/?covers\//i.test(portadaAv1) || /^\d+\.jpe?g$/i.test(portadaAv1)) {
          portadaAv1 = 'https://cdn.animeav1.com/covers/' + String(portadaAv1).replace(/^.*\//, '');
        } else {
          portadaAv1 = ANIMEAV1_BASE + (portadaAv1.charAt(0) === '/' ? portadaAv1 : '/' + portadaAv1);
        }
      }
      var yearAv = extraerYearFlexible(titAv1, it.slug, it.startDate || it.year);
      out.push({
        fuente: 'animeav1',
        tipo: tipo,
        formato: formatoAv1,
        titulo: titAv1,
        slug: it.slug,
        portada: portadaAv1 || null,
        link: ANIMEAV1_BASE + '/media/' + it.slug,
        year: yearAv,
        temporada: extraerNumeroTemporada(titAv1, it.slug)
      });
      added++;
    }
    if (added === 0) break;
    if (totalApi != null && out.length >= totalApi) break;
    if (data.results.length < 15) break;
  }

  // Ocultar temporadas sueltas si ya existe el título base
  // Patrones: -season-2, -2nd-season, -temporada-2, -part-2, -s2
  var slugs = {};
  for (var j = 0; j < out.length; j++) slugs[out[j].slug] = out[j];
  out = out.filter(function (item) {
    var slug = String(item.slug || '');
    var m = slug.match(/^(.*?)-(?:season|temporada|part|parte)-(\d+)$/i)
      || slug.match(/^(.*?)-(\d+)(?:st|nd|rd|th)-season$/i)
      || slug.match(/^(.*?)-s(\d+)$/i);
    if (!m) return true;
    var base = m[1];
    if (slugs[base]) {
      if (!item.portada && slugs[base].portada) item.portada = slugs[base].portada;
      return false; // ocultar season suelto (el detalle del base une T1+T2)
    }
    return true;
  });
  // Portada: si un season quedó y no tiene portada, intentar base
  for (var k = 0; k < out.length; k++) {
    if (out[k].portada) continue;
    var slug2 = String(out[k].slug || '');
    var mm = slug2.match(/^(.*?)-(?:season|temporada|part|parte)-\d+$/i)
      || slug2.match(/^(.*?)-\d+(?:st|nd|rd|th)-season$/i)
      || slug2.match(/^(.*?)-s\d+$/i);
    if (mm && slugs[mm[1]] && slugs[mm[1]].portada) {
      out[k].portada = slugs[mm[1]].portada;
    }
  }
  return out.slice(0, limit);
}


/**
 * Estado unificado anime/series.
 * AnimeAV1 usa status numérico: 0=Finalizado, 1=Próximamente, 2=En emisión
 * También acepta booleanos y textos TMDB/IMDb.
 */
function normalizarEstadoEmision(raw) {
  if (raw == null || raw === '') return { estado: null, en_emision: null, finalizado: null };
  // Códigos numéricos AnimeAV1
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(String(raw).trim()))) {
    var code = parseInt(raw, 10);
    if (code === 0) return { estado: 'Finalizado', en_emision: false, finalizado: true };
    if (code === 1) return { estado: 'Próximamente', en_emision: false, finalizado: false };
    if (code === 2) return { estado: 'En emisión', en_emision: true, finalizado: false };
    if (code === 3) return { estado: 'Pausado', en_emision: false, finalizado: false };
  }
  if (typeof raw === 'boolean') {
    return raw
      ? { estado: 'En emisión', en_emision: true, finalizado: false }
      : { estado: 'Finalizado', en_emision: false, finalizado: true };
  }
  var t = String(raw).trim().toLowerCase();
  if (!t) return { estado: null, en_emision: null, finalizado: null };
  if (/final|ended|complet|finish|finished|concluded|terminad/.test(t)) {
    return { estado: 'Finalizado', en_emision: false, finalizado: true };
  }
  if (/emisi[oó]n|airing|ongoing|returning|current|releasing|en\s*curso|transmission/.test(t)) {
    return { estado: 'En emisión', en_emision: true, finalizado: false };
  }
  if (/paus|hiatus|on\s*hold/.test(t)) {
    return { estado: 'Pausado', en_emision: false, finalizado: false };
  }
  if (/pr[oó]xim|upcoming|not yet|soon|announced|tba/.test(t)) {
    return { estado: 'Próximamente', en_emision: false, finalizado: false };
  }
  if (/cancel/.test(t)) {
    return { estado: 'Cancelado', en_emision: false, finalizado: true };
  }
  return { estado: String(raw).trim(), en_emision: null, finalizado: null };
}

/** Estado desde objeto media de AnimeAV1 (status + endDate) */
function estadoDesdeAnimeAv1Media(media) {
  if (!media) return { estado: null, en_emision: null, finalizado: null };
  // Preferir código status
  if (media.status != null && media.status !== '') {
    var st = normalizarEstadoEmision(media.status);
    if (st.estado) return st;
  }
  // Heurística: endDate presente → finalizado; si no y hay startDate → en emisión
  if (media.endDate) return { estado: 'Finalizado', en_emision: false, finalizado: true };
  if (media.nextDate || media.waitDays != null) {
    return { estado: 'En emisión', en_emision: true, finalizado: false };
  }
  if (media.startDate && !media.endDate) {
    return { estado: 'En emisión', en_emision: true, finalizado: false };
  }
  return { estado: null, en_emision: null, finalizado: null };
}


async function scrapearAnimeAv1(pageUrl, opts) {
  opts = opts || {};
  var u = String(pageUrl || '');
  // extraer slug y episodio
  var m = u.match(/\/media\/([^\/\?#]+)(?:\/(\d+))?/i);
  if (!m) {
    // permitir solo slug
    m = u.match(/animeav1\.com\/(?:media\/)?([^\/\?#]+)/i);
  }
  if (!m) throw new Error('AnimeAV1: no se pudo extraer slug de ' + pageUrl);
  var slug = decodeURIComponent(m[1]);
  var epNum = m[2] ? parseInt(m[2], 10) : null;
  if (opts.episode && !epNum) epNum = parseInt(opts.episode, 10);
  // season ignored (animeav1 usa número de episodio global)
  if (opts.season && opts.episode && !m[2]) {
    epNum = parseInt(opts.episode, 10);
  }

  // Datos del media
  var mediaRaw = await fetchAnimeAv1Data('/media/' + encodeURIComponent(slug) + '/__data.json');
  var mediaData = decodeSvelteKitData(mediaRaw);
  var media = (mediaData && mediaData.media) || {};
  var titulo = media.title || slug;
  var sinopsis = media.synopsis || null;
  var epsCount = media.episodesCount || 0;
  var score = media.score || null;
  var malId = media.malId || null;
  var portada = media.poster || media.cover || media.image || null;
  if (!portada && media.id != null && String(media.id).match(/^\d+$/)) {
    portada = 'https://cdn.animeav1.com/covers/' + media.id + '.jpg';
  }
  if (portada && typeof portada === 'string' && portada.indexOf('http') !== 0) {
    if (/^\/?covers\//i.test(portada) || /^\d+\.jpe?g$/i.test(portada)) {
      portada = 'https://cdn.animeav1.com/covers/' + String(portada).replace(/^.*\//, '');
    } else {
      portada = ANIMEAV1_BASE + (portada.charAt(0) === '/' ? portada : '/' + portada);
    }
  }
  // Si sigue sin portada → Jikan/MAL
  if (!portada && malId) {
    try {
      portada = await fetchPosterMal(malId);
    } catch (eMal) { portada = null; }
  }
  var catName = (media.category && media.category.name) || 'TV Anime';
  var formato = detectarFormatoAnime(titulo, catName, slug);
  var tipo = formato === 'Pelicula' ? 'Pelicula' : 'Anime';
  // Año: startDate → título/slug
  var yearAv1 = extraerYearFlexible(titulo, slug, media.startDate || media.year);
  // Temporada real del título/slug (One Punch Man 3 → 3, 2nd Season → 2)
  var temporadaDetectada = extraerNumeroTemporada(titulo, slug);
  var temporadaBase = temporadaDetectada;
  if (opts.season) {
    var os = parseInt(opts.season, 10);
    // Si el media YA es T2/T3 por título, no degradar a T1 por la ruta /1/N
    if (temporadaDetectada > 1 && os === 1) temporadaBase = temporadaDetectada;
    else if (os >= 1) temporadaBase = os;
  }

  // Si piden episodio concreto → embeds (T2+ puede vivir en slug-season-N)
  if (epNum && epNum > 0) {
    var seasonNum = parseInt(opts.season || temporadaBase || 1, 10) || temporadaBase || 1;
    var mediaSlug = slug;
    if (seasonNum > 1) {
      var seasonCandidates = [
        slug + '-season-' + seasonNum,
        slug + '-' + seasonNum + 'nd-season',
        slug + '-' + seasonNum + 'rd-season',
        slug + '-' + seasonNum + 'th-season',
        slug + '-part-' + seasonNum
      ];
      for (var sc = 0; sc < seasonCandidates.length; sc++) {
        try {
          var testRaw = await fetchAnimeAv1Data('/media/' + encodeURIComponent(seasonCandidates[sc]) + '/__data.json');
          var testData = decodeSvelteKitData(testRaw);
          if (testData && testData.media) {
            mediaSlug = seasonCandidates[sc];
            break;
          }
        } catch (eS) { /* next */ }
      }
    }
    var epRaw = await fetchAnimeAv1Data('/media/' + encodeURIComponent(mediaSlug) + '/' + epNum + '/__data.json');
    var epData = decodeSvelteKitData(epRaw);
    var mapped = mapAnimeAv1Embeds(epData && epData.embeds);
    var dlMapped = mapAnimeAv1Embeds(epData && epData.downloads);
    // downloads object is separate
    var descargas = [];
    if (epData && epData.downloads && typeof epData.downloads === 'object') {
      var dlangs = Object.keys(epData.downloads);
      for (var di = 0; di < dlangs.length; di++) {
        var dlist = epData.downloads[dlangs[di]];
        if (!Array.isArray(dlist)) continue;
        for (var dj = 0; dj < dlist.length; dj++) {
          if (dlist[dj] && dlist[dj].url) {
            descargas.push({
              url: dlist[dj].url,
              idioma: dlangs[di] === 'SUB' ? 'Subtitulado' : dlangs[di],
              servidor: dlist[dj].server || extraerServidor(dlist[dj].url),
              tipo: 'descarga'
            });
          }
        }
      }
    }
    var epMeta = (epData && epData.episode) || {};
    return {
      success: true,
      fuente: 'animeav1',
      source_id: '4',
      tipo: 'Capitulo',
      formato: formato,
      link: ANIMEAV1_BASE + '/media/' + slug + '/' + epNum,
      slug: slug,
      titulo: titulo + ' — Episodio ' + epNum,
      titulo_serie: titulo,
      temporada: seasonNum || epMeta.season || temporadaBase || 1,
      episodio: epNum,
      slug_media: mediaSlug,
      portada: portada,
      descripcion: sinopsis,
      calificacion: score,
      year: yearAv1,
      total: mapped.reproductores.length,
      embeds: mapped.reproductores.map(function (r) { return r.url; }),
      reproductores: mapped.reproductores,
      descargas: descargas
    };
  }

  // Listado de episodios (stubs ligeros; players al pedir /4/anime/slug/{temp}/{ep})
  // temporadaBase: si el título/slug es "Season 2" o "OPM 3", NO empieza en T1
  var totalEps = parseInt(epsCount, 10) || 0;
  if (totalEps < 1) totalEps = 1;
  if (totalEps > 5000) totalEps = 5000;

  var epFrom = parseInt(opts.epFrom || opts.ep_from || 1, 10) || 1;
  var epTo = parseInt(opts.epTo || opts.ep_to || 0, 10) || 0;
  var RANGO_DEFAULT = 50;
  if (!epTo || epTo < epFrom) {
    if (totalEps > 200) {
      epFrom = 1;
      epTo = Math.min(totalEps, RANGO_DEFAULT);
    } else {
      epFrom = 1;
      epTo = totalEps;
    }
  }
  if (epFrom < 1) epFrom = 1;
  if (epTo > totalEps) epTo = totalEps;
  if (epTo - epFrom > 300) epTo = epFrom + 299;

  var tempPrincipal = temporadaBase || 1;
  var episodiosRango = [];
  for (var e = epFrom; e <= epTo; e++) {
    episodiosRango.push({
      temporada: tempPrincipal,
      episodio: e,
      titulo: 'Episodio ' + e,
      url_video: null
    });
  }

  var rangos = [];
  var step = RANGO_DEFAULT;
  for (var r = 1; r <= totalEps; r += step) {
    var r2 = Math.min(r + step - 1, totalEps);
    rangos.push({ desde: r, hasta: r2, label: r + '–' + r2 });
  }

  var temporadas = [{
    temporada: tempPrincipal,
    titulo: formato !== 'TV' ? (formato + (tempPrincipal > 1 ? ' T' + tempPrincipal : '')) : ('Temporada ' + tempPrincipal),
    formato: formato,
    episodios: episodiosRango
  }];

  // Si pidieron players=1 y maxCaps, cargar algunos del rango
  if (opts.players && episodiosRango.length > 0) {
    var maxCaps = opts.maxCaps || 5;
    for (var p = 0; p < Math.min(maxCaps, episodiosRango.length); p++) {
      var epN = episodiosRango[p].episodio;
      try {
        var er = await fetchAnimeAv1Data('/media/' + encodeURIComponent(slug) + '/' + epN + '/__data.json');
        var ed = decodeSvelteKitData(er);
        var mp = mapAnimeAv1Embeds(ed && ed.embeds);
        temporadas[0].episodios[p].reproductores = mp.reproductores;
        temporadas[0].episodios[p].embeds = mp.reproductores.map(function (r) { return r.url; });
      } catch (eCap) { /* skip */ }
    }
  }

  // Solo descubrir temporadas extra si ESTE media es la temporada 1 base
  // (si ya es "One Punch Man 3" / season-2, no inventar T1 ni re-etiquetar)
  if (tempPrincipal === 1 && formato === 'TV') {
    for (var sn = 2; sn <= 5; sn++) {
      var altSlugs = [
        slug + '-season-' + sn,
        slug + '-' + sn + 'nd-season',
        slug + '-' + sn + 'rd-season',
        slug + '-' + sn + 'th-season'
      ];
      var found = null;
      var foundSlug = null;
      for (var ai = 0; ai < altSlugs.length; ai++) {
        try {
          var altRaw = await fetchAnimeAv1Data('/media/' + encodeURIComponent(altSlugs[ai]) + '/__data.json');
          var altData = decodeSvelteKitData(altRaw);
          if (altData && altData.media && (altData.media.episodesCount || altData.media.title)) {
            found = altData.media;
            foundSlug = altSlugs[ai];
            break;
          }
        } catch (eAlt) { /* next */ }
      }
      if (!found) break;
      var altCount = parseInt(found.episodesCount, 10) || 0;
      if (altCount < 1) altCount = 12;
      if (altCount > 500) altCount = 500;
      var altEps = [];
      for (var ae = 1; ae <= altCount; ae++) {
        altEps.push({
          temporada: sn,
          episodio: ae,
          titulo: 'Episodio ' + ae,
          url_video: null,
          slug_media: foundSlug
        });
      }
      temporadas.push({
        temporada: sn,
        slug_media: foundSlug,
        titulo: found.title || ('Temporada ' + sn),
        formato: detectarFormatoAnime(found.title, null, foundSlug),
        episodios: altEps
      });
      totalEps += altCount;
    }
  }

  // Estado AnimeAV1: status numérico (0 finalizado, 2 en emisión) + endDate/nextDate
  var estadoInfo = estadoDesdeAnimeAv1Media(media);

  return {
    success: true,
    fuente: 'animeav1',
    source_id: '4',
    tipo: tipo,
    formato: formato,
    link: ANIMEAV1_BASE + '/media/' + slug,
    slug: slug,
    titulo: titulo,
    portada: portada,
    descripcion: sinopsis,
    calificacion: score,
    year: yearAv1,
    fecha_estreno: media.startDate || media.airedFrom || media.premiereDate || null,
    estado: estadoInfo.estado,
    en_emision: estadoInfo.en_emision,
    finalizado: estadoInfo.finalizado,
    total_episodios: totalEps,
    total_temporadas: temporadas.length,
    temporada_principal: tempPrincipal,
    episodio_desde: epFrom,
    episodio_hasta: epTo,
    rangos_episodios: rangos,
    total: 0,
    embeds: [],
    reproductores: [],
    descargas: [],
    temporadas: temporadas,
    nota: 'Temporada principal=' + tempPrincipal + (formato !== 'TV' ? ' (' + formato + ')' : '') +
      '. Players: /4/anime/' + slug + '/' + tempPrincipal + '/{ep}'
  };
}
// ======================================================
// DORAMASFLIX (GraphQL fluxcedene + HTML) — source_id 6
// ======================================================
async function doramasflixGql(query, variables) {
  var res = await fetch(DORAMASFLIX_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': HEADERS['User-Agent'],
      'Origin': DORAMASFLIX_BASE,
      'Referer': DORAMASFLIX_BASE + '/'
    },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  if (!res.ok) throw new Error('Doramasflix GQL HTTP ' + res.status);
  var data = await res.json();
  if (data.errors && data.errors.length) {
    throw new Error(data.errors[0].message || 'GQL error');
  }
  return data.data;
}

function posterTmdbPath(path) {
  if (!path) return null;
  if (String(path).indexOf('http') === 0) return path;
  return 'https://image.tmdb.org/t/p/w500' + (path.charAt(0) === '/' ? path : '/' + path);
}

function estadoDesdeDoramasflix(item) {
  if (!item) return { estado: null, en_emision: null, finalizado: null };
  if (item.isFinish) return { estado: 'Finalizado', en_emision: false, finalizado: true };
  var seasons = item.seasons || [];
  for (var i = 0; i < seasons.length; i++) {
    if (seasons[i].emision || seasons[i].uploading) {
      return { estado: 'En emisión', en_emision: true, finalizado: false };
    }
    if (seasons[i].pause) return { estado: 'Pausado', en_emision: false, finalizado: false };
  }
  if (item.premiere || item.commingSoon) return { estado: 'Próximamente', en_emision: false, finalizado: false };
  return { estado: item.isFinish === false ? 'En emisión' : null, en_emision: item.isFinish === false, finalizado: !!item.isFinish };
}

async function buscarDoramasflix(query, limit) {
  limit = limit || 15;
  var q = String(query || '').trim();
  if (!q) return [];
  var out = [];
  try {
    var data = await doramasflixGql(
      'query SearchFullDoramas($input: String!, $page: Int, $perPage: Int, $fuzzy: Boolean) { searchFullDoramas(input: $input, page: $page, perPage: $perPage, fuzzy: $fuzzy) { count items { _id slug name name_es original_name poster_path first_air_date isTVShow isFinish premiere rating seasons { emision uploading pause status } } } }',
      { input: q, page: 1, perPage: limit, fuzzy: true }
    );
    var items = (data && data.searchFullDoramas && data.searchFullDoramas.items) || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.slug) continue;
      var st = estadoDesdeDoramasflix(it);
      out.push({
        titulo: it.name_es || it.name || it.slug,
        titulo_original: it.original_name || null,
        tipo: 'Serie',
        fuente: 'doramasflix',
        slug: it.slug,
        link: DORAMASFLIX_BASE + '/doramas/' + it.slug,
        portada: posterTmdbPath(it.poster_path),
        year: it.first_air_date ? String(it.first_air_date).slice(0, 4) : null,
        calificacion: it.rating != null ? Number(Number(it.rating).toFixed(1)) : null,
        estado: st.estado,
        en_emision: st.en_emision,
        finalizado: st.finalizado,
        doramasflix_id: it._id
      });
    }
  } catch (eD) { /* ok */ }

  try {
    var dataM = await doramasflixGql(
      'query SearchFullMovies($input: String!, $page: Int, $perPage: Int, $fuzzy: Boolean) { searchFullMovies(input: $input, page: $page, perPage: $perPage, fuzzy: $fuzzy) { count items { _id slug name name_es original_name poster_path release_date status } } }',
      { input: q, page: 1, perPage: Math.min(limit, 10), fuzzy: true }
    );
    var movies = (dataM && dataM.searchFullMovies && dataM.searchFullMovies.items) || [];
    for (var j = 0; j < movies.length && out.length < limit * 2; j++) {
      var mv = movies[j];
      if (!mv || !mv.slug) continue;
      out.push({
        titulo: mv.name_es || mv.name || mv.slug,
        titulo_original: mv.original_name || null,
        tipo: 'Pelicula',
        fuente: 'doramasflix',
        slug: mv.slug,
        link: DORAMASFLIX_BASE + '/peliculas/' + mv.slug,
        portada: posterTmdbPath(mv.poster_path),
        year: mv.release_date ? String(mv.release_date).slice(0, 4) : null,
        estado: mv.status || null,
        doramasflix_id: mv._id
      });
    }
  } catch (eM) { /* ok */ }

  return out.slice(0, limit);
}

/** Decodifica JWT de embedshortener.co → URL real del player */
function decodificarEmbedShortener(url) {
  if (!url) return null;
  var m = String(url).match(/embedshortener\.co\/e\/([A-Za-z0-9_\-\.]+)/i);
  if (!m) return url;
  try {
    var parts = m[1].split('.');
    if (parts.length < 2) return url;
    var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    var jsonStr = null;
    try {
      if (typeof atob === 'function') jsonStr = atob(payload);
      else if (typeof Buffer !== 'undefined') jsonStr = Buffer.from(payload, 'base64').toString('utf8');
    } catch (e1) { return url; }
    var data = JSON.parse(jsonStr);
    if (!data || !data.link) return url;
    var inner = data.link;
    try {
      var real = null;
      if (typeof atob === 'function') real = atob(inner);
      else if (typeof Buffer !== 'undefined') real = Buffer.from(inner, 'base64').toString('utf8');
      if (real && /^https?:\/\//i.test(real)) return real;
    } catch (e2) { /* ok */ }
    return url;
  } catch (e) {
    return url;
  }
}

/** Trae TODOS los episodios de un dorama vía GraphQL (paginación completa) */
async function doramasflixListarEpisodios(serieId, seasonNumber) {
  var all = [];
  var page = 1;
  var maxPages = 40;
  var conTemporada = seasonNumber != null && !isNaN(seasonNumber);
  while (page <= maxPages) {
    var data;
    if (conTemporada) {
      data = await doramasflixGql(
        'query($serie_id:ID!,$page:Int,$limit:Int,$season_number:Int){paginationEpisode(page:$page,limit:$limit,filter:{serie_id:$serie_id,season_number:$season_number}){count items{_id slug name name_es episode_number season_number air_date overview still_path} pageInfo{currentPage pageCount hasNextPage itemCount}}}',
        { serie_id: serieId, page: page, limit: 50, season_number: Number(seasonNumber) }
      );
    } else {
      data = await doramasflixGql(
        'query($serie_id:ID!,$page:Int,$limit:Int){paginationEpisode(page:$page,limit:$limit,filter:{serie_id:$serie_id}){count items{_id slug name name_es episode_number season_number air_date overview still_path} pageInfo{currentPage pageCount hasNextPage itemCount}}}',
        { serie_id: serieId, page: page, limit: 50 }
      );
    }
    var block = data && data.paginationEpisode;
    if (!block) break;
    var items = block.items || [];
    for (var i = 0; i < items.length; i++) all.push(items[i]);
    if (!block.pageInfo || !block.pageInfo.hasNextPage) break;
    page++;
  }
  return all;
}

/** Links de un episodio concreto */
async function doramasflixEpisodeLinks(episodeId) {
  if (!episodeId) return [];
  try {
    var data = await doramasflixGql(
      'query($episode_id:ID!){getEpisodeLinks(id:$episode_id,app:"android"){links_online{server lang link _id is_recommended}}}',
      { episode_id: episodeId }
    );
    var links = (data && data.getEpisodeLinks && data.getEpisodeLinks.links_online) || [];
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var L = links[i];
      if (!L || !L.link) continue;
      var real = decodificarEmbedShortener(L.link) || L.link;
      var lang = String(L.lang || '');
      var idioma = (lang === '38' || /lat|es/i.test(lang)) ? 'Latino'
        : (lang === '13109' || /sub/i.test(lang)) ? 'Subtitulado' : 'Otro';
      out.push({
        url: real,
        servidor: extraerServidor(real) || ('server-' + (L.server || '')),
        idioma: idioma,
        lang: lang,
        tipo: 'reproductor',
        fuente: 'doramasflix'
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function scrapearDoramasflix(pageUrl, opts) {
  opts = opts || {};
  var u = String(pageUrl || '');
  var isMovie = /\/peliculas?\//i.test(u);
  var isCap = /\/capitulos?\//i.test(u);
  var slug = null;
  var m = u.match(/\/(?:doramas|peliculas|pelicula)\/([^\/\?#]+)/i);
  if (m) slug = decodeURIComponent(m[1]);
  var capM = u.match(/\/capitulos\/([^\/\?#]+)/i);
  var season = opts.season ? parseInt(opts.season, 10) : null;
  var episode = opts.episode ? parseInt(opts.episode, 10) : null;
  if (capM) {
    var cm = capM[1].match(/^(.*)-(\d+)x(\d+)$/i);
    if (cm) {
      slug = cm[1];
      season = parseInt(cm[2], 10);
      episode = parseInt(cm[3], 10);
      isCap = true;
    }
  }
  if (!slug) throw new Error('Doramasflix: no se pudo extraer slug de ' + pageUrl);

  var detailUrl = isMovie
    ? (DORAMASFLIX_BASE + '/peliculas/' + slug)
    : (DORAMASFLIX_BASE + '/doramas/' + slug);

  // Detalle completo vía GraphQL (rating, temporadas, episodios, overview…)
  var detail = null;
  try {
    var dData = await doramasflixGql(
      'query($slug:String!){detailDorama(filter:{slug:$slug}){_id name slug name_es original_name overview rating rating_count number_of_episodes number_of_seasons poster_path backdrop_path first_air_date last_air_date isFinish tmdb_id genres{name} labels{name}}}',
      { slug: slug }
    );
    detail = dData && dData.detailDorama;
  } catch (eDet) { /* ok */ }

  // Fallback película
  if (!detail && isMovie) {
    try {
      var mData = await doramasflixGql(
        'query($slug:String!){detailMovie(filter:{slug:$slug}){_id name slug name_es original_name overview rating rating_count poster_path backdrop_path release_date tmdb_id genres{name}}}',
        { slug: slug }
      );
      detail = mData && mData.detailMovie;
      if (detail) isMovie = true;
    } catch (eMov) { /* ok */ }
  }

  if (!detail) {
    // Último recurso: búsqueda
    try {
      var hits = await buscarDoramasflix(slug.replace(/-/g, ' '), 8);
      for (var h = 0; h < (hits || []).length; h++) {
        if (hits[h].slug === slug) {
          detail = {
            _id: hits[h].doramasflix_id,
            name: hits[h].titulo,
            slug: hits[h].slug,
            poster_path: hits[h].portada,
            first_air_date: hits[h].year,
            isFinish: hits[h].finalizado
          };
          break;
        }
      }
    } catch (eH) { /* ok */ }
  }

  if (!detail) throw new Error('Doramasflix: no se encontró "' + slug + '"');

  var titulo = detail.name_es || detail.name || slug;
  var tituloOrig = detail.original_name || null;
  var descripcion = detail.overview || null;
  var portada = posterTmdbPath(detail.poster_path || detail.poster);
  var backdrop = posterTmdbPath(detail.backdrop_path || detail.backdrop);
  var year = detail.first_air_date
    ? String(detail.first_air_date).slice(0, 4)
    : (detail.release_date ? String(detail.release_date).slice(0, 4) : null);
  var calificacion = detail.rating != null ? Number(Number(detail.rating).toFixed(1)) : null;
  var generos = [];
  if (Array.isArray(detail.genres)) {
    for (var gi = 0; gi < detail.genres.length; gi++) {
      if (detail.genres[gi] && detail.genres[gi].name) generos.push(detail.genres[gi].name);
    }
  }
  var totalSeasons = detail.number_of_seasons || 1;
  var totalEpsMeta = detail.number_of_episodes || 0;
  var estadoInfo = estadoDesdeDoramasflix(detail);
  var serieId = detail._id;

  // ——— Capítulo concreto ———
  if (isCap || (season && episode)) {
    var sN = season || 1;
    var eN = episode || 1;
    var epId = null;
    var epSlug = slug + '-' + sN + 'x' + eN;
    // Buscar episode_id en la página de episodios de esa temporada
    try {
      var epsSeason = await doramasflixListarEpisodios(serieId, sN);
      for (var ei = 0; ei < epsSeason.length; ei++) {
        if (Number(epsSeason[ei].episode_number) === eN) {
          epId = epsSeason[ei]._id;
          epSlug = epsSeason[ei].slug || epSlug;
          break;
        }
      }
    } catch (eEp) { /* ok */ }

    var reproductores = epId ? await doramasflixEpisodeLinks(epId) : [];
    // Intentar resolver a HLS los que se puedan (vimeos/streamwish/vidhide/voe)
    for (var ri = 0; ri < reproductores.length; ri++) {
      var rp = reproductores[ri];
      if (!rp || !rp.url) continue;
      if (/\.m3u8(\?|$)/i.test(rp.url)) {
        rp.hls = rp.url;
        rp.tipo = 'hls';
        continue;
      }
      try {
        var prov = null;
        if (typeof detectarProviderEmbedFull === 'function') prov = detectarProviderEmbedFull(rp.url);
        if (!prov && typeof detectarProviderEmbed === 'function') prov = detectarProviderEmbed(rp.url);
        if (prov && typeof resolveByProvider === 'function') {
          var resolved = await resolveByProvider(rp.url, prov, null);
          if (resolved && (resolved.url || resolved.master)) {
            rp.hls = resolved.master || resolved.url;
            rp.tipo = 'hls';
            if (resolved.qualities) rp.qualities = resolved.qualities;
          }
        }
      } catch (eRes) { /* dejar embed */ }
    }

    return {
      success: true,
      fuente: 'doramasflix',
      source_id: '6',
      tipo: 'Capitulo',
      link: DORAMASFLIX_BASE + '/capitulos/' + epSlug,
      slug: slug,
      titulo: titulo + ' — ' + sN + 'x' + eN,
      titulo_serie: titulo,
      portada: portada,
      backdrop: backdrop,
      descripcion: descripcion,
      year: year,
      calificacion: calificacion,
      estado: estadoInfo.estado,
      temporada: sN,
      episodio: eN,
      reproductores: reproductores,
      embeds: reproductores.map(function (r) { return r.url; }),
      total: reproductores.length
    };
  }

  // ——— Serie / listado: todos los episodios de todas las temporadas ———
  var caps = [];
  if (serieId && !isMovie) {
    try {
      // Traer por temporada para cubrir todas (evita límites del API)
      var seasonsToFetch = [];
      for (var sn = 1; sn <= Math.max(totalSeasons, 1); sn++) seasonsToFetch.push(sn);
      // Si no sabemos cuántas, también pedir sin filtro de temporada
      if (!totalSeasons || totalSeasons < 1) seasonsToFetch = [null];

      var seenEp = Object.create(null);
      for (var si = 0; si < seasonsToFetch.length; si++) {
        var list = await doramasflixListarEpisodios(serieId, seasonsToFetch[si]);
        for (var li = 0; li < list.length; li++) {
          var ep = list[li];
          if (!ep) continue;
          var key = (ep.season_number || 1) + 'x' + (ep.episode_number || 0);
          if (seenEp[key]) continue;
          seenEp[key] = true;
          caps.push({
            temporada: Number(ep.season_number) || 1,
            episodio: Number(ep.episode_number) || 0,
            slug: ep.slug || (slug + '-' + key),
            link: DORAMASFLIX_BASE + '/capitulos/' + (ep.slug || (slug + '-' + key)),
            titulo: ep.name_es || ep.name || ('T' + (ep.season_number || 1) + 'E' + (ep.episode_number || 0)),
            episode_id: ep._id,
            air_date: ep.air_date || null,
            still: posterTmdbPath(ep.still_path),
            reproductores: [],
            embeds: []
          });
        }
      }
      // Si por temporada no trajo nada, intentar sin filtro
      if (!caps.length) {
        var allEps = await doramasflixListarEpisodios(serieId, null);
        for (var ai = 0; ai < allEps.length; ai++) {
          var ep2 = allEps[ai];
          if (!ep2) continue;
          caps.push({
            temporada: Number(ep2.season_number) || 1,
            episodio: Number(ep2.episode_number) || 0,
            slug: ep2.slug,
            link: DORAMASFLIX_BASE + '/capitulos/' + ep2.slug,
            titulo: ep2.name_es || ep2.name || '',
            episode_id: ep2._id,
            still: posterTmdbPath(ep2.still_path),
            reproductores: [],
            embeds: []
          });
        }
      }
    } catch (eList) { /* ok */ }
  }

  caps.sort(function (a, b) {
    if (a.temporada !== b.temporada) return a.temporada - b.temporada;
    return a.episodio - b.episodio;
  });

  var byT = Object.create(null);
  for (var k = 0; k < caps.length; k++) {
    var t = caps[k].temporada;
    if (!byT[t]) byT[t] = [];
    byT[t].push(caps[k]);
  }
  var temps = Object.keys(byT).map(Number).sort(function (a, b) { return a - b; }).map(function (tn) {
    return { temporada: tn, total_episodios: byT[tn].length, episodios: byT[tn] };
  });

  return {
    success: true,
    fuente: 'doramasflix',
    source_id: '6',
    tipo: isMovie ? 'Pelicula' : 'Serie',
    link: detailUrl,
    slug: slug,
    titulo: titulo,
    titulo_original: tituloOrig,
    portada: portada,
    backdrop: backdrop,
    descripcion: descripcion,
    year: year,
    calificacion: calificacion,
    votos: detail.rating_count || null,
    tmdb_id: detail.tmdb_id || null,
    estado: estadoInfo.estado,
    en_emision: estadoInfo.en_emision,
    finalizado: estadoInfo.finalizado,
    generos: generos,
    genero: generos.length ? generos.join(', ') : null,
    total_episodios: totalEpsMeta || caps.length,
    total_temporadas: Math.max(totalSeasons, temps.length || 1),
    temporadas: temps.length ? temps : [{ temporada: 1, total_episodios: 0, episodios: [] }],
    total: 0,
    embeds: [],
    reproductores: [],
    descargas: []
  };
}
