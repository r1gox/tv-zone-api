# Video Resolver Worker

Worker de Cloudflare que resuelve enlaces de video desde múltiples servicios (Streamtape, etc.) y actúa como proxy para evitar bloqueos CORS.

## Características

- ✅ Extractor para **Streamtape** (usando su API oficial).
- 🔄 Caché en **Cloudflare KV** para reducir peticiones.
- 📺 Proxy de video para evitar CORS y referer.
- 🎬 Catálogo desde **TMDB** (películas y series populares).
- 🧩 Estructura modular para añadir más extractores (Doodstream, Voe, etc.).

## Configuración

1. Clona el repositorio.
2. Crea un namespace KV en Cloudflare llamado `VIDEO_CACHE`.
3. En el panel de Cloudflare Workers, añade las siguientes variables de entorno:
   - `TMDB_API_KEY`: Tu clave de The Movie Database (v3).
   - `STREAMTAPE_LOGIN`: Tu login de Streamtape.
   - `STREAMTAPE_API_KEY`: Tu API Key de Streamtape.
4. Sube el código `worker.js` a tu Worker.

## Uso

### Obtener un video
