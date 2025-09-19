// public/overlay.js
// Overlay logic: discovers the active live stream for a Channel ID, starts live chat,
// polls fast for "All chat", renders messages with vibrant username colors & YouTube emojis.

import { Innertube } from "https://esm.sh/youtubei.js@15.1.1/web";

const qs = new URLSearchParams(location.search);
const CHANNEL_ID = qs.get("channel");                // required
const FONT_SIZE = parseInt(qs.get("fontSize") || "20", 10);
const MAX_ON_SCREEN = parseInt(qs.get("max") || "150", 10);

// Utility: hash a string -> deterministic HSL (twitchy colors)
function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 72;
  const light = 60;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// Render runs array to HTML, including custom emojis (image-based).
function runsToHTML(runs = []) {
  return runs.map(run => {
    if (run.text) {
      // Escape basic HTML
      return run.text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    if (run.emoji) {
      // YouTube custom emoji: image-based
      const src = run.emoji.image?.sources?.[0]?.url || run.emoji.image?.thumbnails?.[0]?.url;
      if (src) {
        return `<img class="emoji" alt="${run.emoji.shortcuts?.[0] || 'emoji'}" src="${src}">`;
      }
      // default to unicode fallback if present
      if (run.emoji.emoji_id) return run.emoji.emoji_id;
    }
    return "";
  }).join("");
}

const chatEl = document.getElementById("chat");
document.documentElement.style.fontSize = `${FONT_SIZE}px`;

function pushMessage({ authorName, authorPhoto, messageHTML }) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  wrap.innerHTML = `
    <img class="msg__pfp" referrerpolicy="no-referrer" src="${authorPhoto || ""}" />
    <div class="msg__content">
      <div class="msg__author" style="color:${nameColor(authorName)}">${authorName}</div>
      <div class="msg__text">${messageHTML}</div>
    </div>
  `;
  chatEl.prepend(wrap);

  // Cull old messages
  const nodes = chatEl.querySelectorAll(".msg");
  if (nodes.length > MAX_ON_SCREEN) {
    for (let i = MAX_ON_SCREEN; i < nodes.length; i++) nodes[i].remove();
  }
}

// Small helper to delay
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!CHANNEL_ID) {
    pushMessage({
      authorName: "Overlay",
      authorPhoto: "",
      messageHTML: `Missing ?channel=CHANNEL_ID in the URL`
    });
    return;
  }

  // Use youtubei.js/web with a proxy fetch to our Cloudflare function.
  const yt = await Innertube.create({
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const proxied = `/api/yt-proxy?url=${encodeURIComponent(url)}`;
      return fetch(proxied, init);
    }
  });

  // Discover the *current* live video for this channel (permanent link)
  // Strategy:
  //  1) Browse the channel and look for a live tab or a "Live Now" item.
  //  2) If not found, fall back to search with "Live" filter for this channel.
  let liveVideoId = null;

  try {
    const channel = await yt.getChannel(CHANNEL_ID);
    // Try shelves for "Live" content
    const tabs = channel.tabs || [];
    for (const tab of tabs) {
      const sec = tab.content?.sections || [];
      for (const s of sec) {
        const items = (s.contents || []).map(c => c?.as?.(?.Video) ? c.as(Video) : null).filter(Boolean);
        // Fallback generic scan:
        for (const item of (s.contents || [])) {
          const isLive = item?.badges?.some(b => /LIVE/i.test(b.label || b?.metadata || ""));
          const vid = item?.id || item?.video_id || item?.endpoint?.payload?.videoId;
          if (isLive && vid) { liveVideoId = vid; break; }
        }
        if (liveVideoId) break;
      }
      if (liveVideoId) break;
    }
  } catch {}

  if (!liveVideoId) {
    try {
      // Search fallback (filter by channel + live)
      const res = await yt.search("", { params: { channel_id: CHANNEL_ID, features: ["Live"], type: "video" } });
      const item = res?.videos?.[0];
      if (item && (item.is_live || item.is_upcoming)) liveVideoId = item.id;
    } catch {}
  }

  if (!liveVideoId) {
    pushMessage({
      authorName: "Overlay",
      authorPhoto: "",
      messageHTML: `No active livestream found for channel <code>${CHANNEL_ID}</code>.`
    });
    return;
  }

  // Get video info & LiveChat handle
  const info = await yt.getInfo(liveVideoId);
  const liveChat = info.getLiveChat?.();
  if (!liveChat) {
    pushMessage({
      authorName: "Overlay",
      authorPhoto: "",
      messageHTML: `Live chat is not available for this stream.`
    });
    return;
  }

  // ---- Polling loop (FAST) ----
  // Request "All chat" (not Top chat). For InnerTube, this is handled by client hints;
  // youtubei.js surfaces full live chat stream. The library normalizes actions (adds, deletes, ticks).
  // We'll poll aggressively (250–500ms) to feel "rapid" while remaining reliable.
  let isRunning = true;

  // Some library versions offer an event API; we implement a robust polling path instead:
  let continuation = await liveChat.getInitialContinuation?.();
  const seenIds = new Set();

  while (isRunning) {
    try {
      const resp = continuation
        ? await liveChat.getContinuation(continuation, { client: "WEB" })
        : await liveChat.getChat({ client: "WEB" });

      continuation = resp?.continuation;

      // resp.actions include addChatItemAction, remove, ticker updates, etc.
      for (const action of (resp?.actions || [])) {
        const add = action.addChatItemAction || action?.addLiveChatItemAction;
        if (!add) continue;

        const item = add.item?.liveChatTextMessageRenderer
                 || add.item?.liveChatPaidMessageRenderer
                 || add.item?.liveChatMembershipItemRenderer
                 || add.item?.liveChatPaidStickerRenderer;

        if (!item) continue;

        const id = item.id || item.timestampUsec || Math.random().toString(36).slice(2);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const authorName = item.authorName?.simpleText || item.authorName?.text || "User";
        const authorPhoto = item.authorPhoto?.thumbnails?.slice(-1)[0]?.url || "";

        // Text runs (with emojis) may be under message.runs or headerPrimaryText.runs
        const runs = item.message?.runs || item.headerPrimaryText?.runs || [];
        const messageHTML = runsToHTML(runs);

        pushMessage({ authorName, authorPhoto, messageHTML });
      }
    } catch (err) {
      // Show a soft error message once
      console.warn("poll error", err);
    }
    await sleep(350); // FAST polling to reduce apparent delay
  }
})();
