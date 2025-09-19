// server.js
import express from "express";
import { Innertube } from "youtubei.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public", { extensions: ["html"] }));

/** Create one Innertube client (server-side) */
let ytPromise = null;
function getYT() {
  if (!ytPromise) ytPromise = Innertube.create({ location: "US" });
  return ytPromise;
}

/** Resolve a channel's current live video id */
async function resolveLiveVideoId(channelId) {
  const yt = await getYT();
  const ch = await yt.getChannel(channelId).catch(() => null);
  let liveId = null;

  // Try scanning channel tabs/sections for a live item
  const tabs = ch?.tabs ?? [];
  outer: for (const tab of tabs) {
    const sections = tab?.content?.sections ?? [];
    for (const s of sections) {
      const items = s?.contents ?? [];
      for (const it of items) {
        const vid = it?.id || it?.video_id || it?.endpoint?.payload?.videoId;
        const isLive = !!(it?.is_live || it?.badges?.some?.(b => /LIVE/i.test(b?.label || "")));
        if (isLive && vid) { liveId = vid; break outer; }
      }
    }
  }

  // Fallback: channel-scoped search with "Live" filter
  if (!liveId) {
    const res = await yt.search("", { params: { channel_id: channelId, features: ["Live"], type: "video" } }).catch(() => null);
    const firstLive = res?.videos?.find?.(v => v?.is_live);
    if (firstLive?.id) liveId = firstLive.id;
  }

  return liveId;
}

/** Build a minimal text+emoji "runs" to HTML on the client; here we just deliver the raw item we need */
function extractRenderable(action) {
  const add = action.addChatItemAction || action.addLiveChatItemAction;
  if (!add) return null;

  const item =
    add.item?.liveChatTextMessageRenderer ||
    add.item?.liveChatPaidMessageRenderer ||
    add.item?.liveChatMembershipItemRenderer ||
    add.item?.liveChatPaidStickerRenderer;

  if (!item) return null;

  const id = item.id || item.timestampUsec || Math.random().toString(36).slice(2);
  const author = item.authorName?.simpleText || item.authorName?.text || "User";
  const runs = item.message?.runs || item.headerPrimaryText?.runs || [];
  const authorPhoto = item.authorPhoto?.thumbnails?.slice(-1)?.[0]?.url || "";

  return { id, author, authorPhoto, runs };
}

/** SSE live chat stream
 *  /sse?video=VIDEO_ID    OR    /sse?channel=UCxxxx
 */
app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const videoIdParam = req.query.video?.toString();
  const channelId = req.query.channel?.toString();

  let videoId = videoIdParam || null;

  try {
    if (!videoId && channelId) {
      videoId = await resolveLiveVideoId(channelId);
    }
    if (!videoId) {
      res.write(`event: status\ndata: ${JSON.stringify({ error: "No live video found" })}\n\n`);
      return res.end();
    }

    const yt = await getYT();
    const info = await yt.getInfo(videoId).catch(() => null);
    if (!info) {
      res.write(`event: status\ndata: ${JSON.stringify({ error: "Failed to load video info" })}\n\n`);
      return res.end();
    }

    const liveChat = info.getLiveChat?.();
    if (!liveChat) {
      res.write(`event: status\ndata: ${JSON.stringify({ error: "Live chat not available" })}\n\n`);
      return res.end();
    }

    // Fast polling loop for "All chat"
    let continuation = await liveChat.getInitialContinuation?.();
    const seen = new Set();
    let alive = true;

    req.on("close", () => { alive = false; });

    while (alive) {
      try {
        const resp = continuation
          ? await liveChat.getContinuation(continuation, { client: "WEB" })
          : await liveChat.getChat({ client: "WEB" });

        continuation = resp?.continuation;

        for (const act of (resp?.actions || [])) {
          const msg = extractRenderable(act);
          if (!msg) continue;
          if (msg.id && seen.has(msg.id)) continue;
          if (msg.id) seen.add(msg.id);

          // Push to client
          res.write(`event: chat\ndata: ${JSON.stringify(msg)}\n\n`);
        }
      } catch (e) {
        // soft error – report once and continue
        res.write(`event: status\ndata: ${JSON.stringify({ warn: "poll-error" })}\n\n`);
      }
      // rapid feel
      await new Promise(r => setTimeout(r, 350));
    }
  } catch (e) {
    res.write(`event: status\ndata: ${JSON.stringify({ error: e?.message || "unknown-error" })}\n\n`);
  } finally {
    res.end();
  }
});

/** Minimal health/help */
app.get("/status", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`YouTube Chat Overlay running on http://localhost:${PORT}`);
  console.log(`Overlay example: http://localhost:${PORT}/overlay.html?channel=UCxxxxxxxxxxxxxxxx`);
  console.log(`Or by video:     http://localhost:${PORT}/overlay.html?video=VIDEOID12345`);
});
