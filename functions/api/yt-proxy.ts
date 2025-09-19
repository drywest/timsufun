// functions/api/yt-proxy.ts
// A very small proxy so youtubei.js/web can work in the browser.
// It forwards requests to youtube domains and returns responses with CORS enabled.

export const onRequest: PagesFunction = async (ctx) => {
  const req = ctx.request;
  const url = new URL(req.url);
  const target = url.searchParams.get("url");

  if (!target) {
    return new Response("Missing ?url", { status: 400 });
  }

  // Only allow YouTube/Google video endpoints for safety.
  const allowedHosts = new Set([
    "www.youtube.com",
    "youtubei.googleapis.com",
    "i.ytimg.com",
    "yt3.ggpht.com",
    "yt3.googleusercontent.com",
    "music.youtube.com",
    "m.youtube.com"
  ]);

  const targetURL = new URL(target);

  if (!allowedHosts.has(targetURL.hostname)) {
    return new Response("Host not allowed", { status: 403 });
  }

  // Clone method/headers/body to forward the request.
  const init: RequestInit = {
    method: req.method,
    headers: new Headers(req.headers),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body
  };

  // Remove hop-by-hop headers.
  ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailers"].forEach(h => init.headers!.delete(h));

  const upstream = await fetch(targetURL.toString(), init);

  // Build CORS-safe response
  const respHeaders = new Headers(upstream.headers);
  respHeaders.set("access-control-allow-origin", "*");
  respHeaders.set("access-control-allow-headers", "*");
  respHeaders.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS");

  // Cloudflare Workers/Pages need a fresh body stream
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders
  });
};
