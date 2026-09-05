# TV Zone API

API de canales en vivo (cable + IPTV por países).

## Endpoints

| Ruta | Descripción |
|------|-------------|
| `/` | Info y ejemplos |
| `/tv/cable` | Tu lista ChannelsTV |
| `/tv/countries` | Lista de países |
| `/tv/countries/mx` | Canales de México |
| `/tv/search?q=espn` | Buscar canales |
| `/proxy?url=` | Proxy CORS para m3u8 |

## Deploy

```bash
npm i
npx wrangler login
npx wrangler deploy
