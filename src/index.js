import puppeteer from "@cloudflare/puppeteer";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function extractToken(urlOrToken) {
  const s = String(urlOrToken || "").trim();
  const m = s.match(/\/(?:embed|player|e)\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{6,}$/.test(s)) return s;
  return null;
}

/** Metadata pública (sin token de reproducción) */
async function fetchMeta(token) {
  const res = await fetch(`https://primeload.co/api/v1/player/${token}`, {
    headers: {
      Accept: "application/json",
      Referer: `https://primeload.co/player/${token}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`player API HTTP ${res.status}`);
  return res.json();
}

/**
 * Abre el embed con Browser Rendering y captura el primer master.m3u8 con token.
 * Los tokens caducan rápido; úsalos al momento o vía /proxy.
 */
async function resolveAuthenticated(env, embedUrl) {
  if (!env.BROWSER) {
    throw new Error("Falta binding BROWSER (Cloudflare Browser Rendering)");
  }

  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();
  const captured = [];

  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("primecdn.co") && u.includes(".m3u8") && u.includes("token=")) {
      captured.push(u);
    }
  });

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    try {
      await page.click("#sf-overlay", { timeout: 4000 });
    } catch (_) {}
    // Esperar auth + primer manifest
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && captured.length === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await browser.close();
  }

  const master = captured.find((u) => u.includes("/master.m3u8")) || null;
  const variant = captured.find((u) => !u.includes("/master.m3u8")) || null;
  if (!master && !variant) {
    throw new Error("No se capturó m3u8 autenticado (challenge/timeout)");
  }
  return { master, url: variant || master, all: [...new Set(captured)] };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = url.origin;

    // Health
    if (path === "/" && !url.searchParams.has("url") && !url.searchParams.get("action")) {
      return json({
        status: "ok",
        service: "primeload-resolver",
        endpoints: {
          meta: `${origin}/meta?url=https://primeload.co/embed/TOKEN`,
          resolve: `${origin}/resolve?url=https://primeload.co/embed/TOKEN`,
          proxy: `${origin}/proxy?url={m3u8_con_token}`,
        },
        note: "resolve requiere Browser Rendering; tokens de corta vida",
      });
    }

    // Proxy genérico de m3u8/segmentos (el cliente pasa URL ya con token)
    if (path === "/proxy" || url.searchParams.get("action") === "stream") {
      const target = url.searchParams.get("url") || url.searchParams.get("stream_url");
      if (!target) return json({ success: false, error: "Falta url" }, 400);
      let targetUrl = target;
      try {
        targetUrl = decodeURIComponent(target);
      } catch (_) {}

      const headers = new Headers({
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Referer: "https://primeload.co/",
        Origin: "https://primeload.co",
      });
      if (request.headers.has("Range")) {
        headers.set("Range", request.headers.get("Range"));
      }

      const upstream = await fetch(targetUrl, { method: "GET", headers, redirect: "follow" });
      const out = new Headers(CORS);
      ["content-type", "content-length", "content-range", "accept-ranges"].forEach((h) => {
        if (upstream.headers.has(h)) out.set(h, upstream.headers.get(h));
      });
      // Si es playlist, reescribir URIs relativas hacia nuestro proxy (opcional)
      const ct = upstream.headers.get("content-type") || "";
      if (ct.includes("mpegurl") || targetUrl.includes(".m3u8")) {
        let body = await upstream.text();
        // No re-firmamos segmentos aquí: cada línea absoluta con token propio ya viene del CDN
        // Si las URIs son relativas, absolutizar contra el master
        const base = targetUrl.split("?")[0].replace(/\/[^/]*$/, "/");
        body = body
          .split("\n")
          .map((line) => {
            const t = line.trim();
            if (!t || t.startsWith("#")) return line;
            if (/^https?:\/\//i.test(t)) return line;
            return new URL(t, base).href;
          })
          .join("\n");
        out.set("Content-Type", "application/vnd.apple.mpegurl");
        return new Response(body, { status: upstream.status, headers: out });
      }
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    const raw = url.searchParams.get("url") || url.searchParams.get("token") || "";
    const token = extractToken(raw);
    if (!token) {
      return json({ success: false, error: "Falta url/token de Primeload" }, 400);
    }
    const embedUrl = `https://primeload.co/embed/${token}`;

    // Solo meta (sin Browser)
    if (path === "/meta" || url.searchParams.get("action") === "meta") {
      try {
        const meta = await fetchMeta(token);
        return json({
          success: true,
          token,
          title: meta.title,
          type: meta.type,
          poster: meta.poster,
          master_raw: meta.master_manifest,
          sources: meta.sources,
          note: "master_raw sin token → 403 en CDN; usa /resolve",
        });
      } catch (e) {
        return json({ success: false, error: e.message }, 502);
      }
    }

    // Resolve autenticado (Browser Rendering)
    if (path === "/resolve" || url.searchParams.get("action") === "resolve" || path === "/") {
      try {
        const meta = await fetchMeta(token).catch(() => null);
        const auth = await resolveAuthenticated(env, embedUrl);
        const play = auth.url;
        return json({
          success: true,
          token,
          title: meta?.title || null,
          type: "hls",
          poster: meta?.poster || null,
          url: play,
          master: auth.master,
          proxy_url: `${origin}/proxy?url=${encodeURIComponent(play)}`,
          proxy_master: auth.master
            ? `${origin}/proxy?url=${encodeURIComponent(auth.master)}`
            : null,
          expires_note:
            "Token de corta vida. Reproduce al momento. Segmentos piden token nuevo (limitación de Primeload).",
          all_m3u8: auth.all,
        });
      } catch (e) {
        return json({ success: false, error: e.message || String(e) }, 500);
      }
    }

    return json({ success: false, error: "Ruta no encontrada" }, 404);
  },
};
