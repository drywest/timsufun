// public/overlay.js
import { Innertube } from "https://esm.sh/youtubei.js@15.1.1/web";

const qs = new URLSearchParams(location.search);
const VIDEO_ID = qs.get("video");
const CHANNEL_ID = qs.get("channel");
const chatEl = document.getElementById("chat");

// style: username white + colon (as in your image)
function authorSpan(name) {
  const safe = (name || "User").replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]));
  return `<span class="msg__author">${safe.toUpperCase()}:</span>`;
}

function runsToHTML(runs = []) {
  return runs.map(run => {
    if (run.text) {
      return run.text
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;");
    }
    if (run.emoji) {
      const src = run.emoji?.image?.sources?.[0]?.url || run.emoji?.image?.thumbnails?.[0]?.url;
      if (src) return `<img class="emoji" alt="" src="${src}">`;
      if (run.emoji.emoji_id) return run.emoji.emoji_id;
    }
    return "";
  }).join("");
}

function pushMessage(html) {
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = html;
  chatEl.appendChild(div);
  // Keep a long but safe buffer (like your reference)
  const max = 200;
  if (chatEl.children.length > max) chatEl.removeChild(chatEl.firstChild);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function resolveVideoIdFromChannel(channelId) {
  const res = await fetch(`/api/live?channel=${encodeURIComponent(channelId)}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  return json.videoId || null;
}

(async () => {
  let videoId = VIDEO_ID;

  if (!videoId) {
    if (!CHANNEL_ID) {
      pushMessage("Missing ?video=VIDEO_ID or ?channel=CHANNEL_ID in the URL");
      return;
    }
    // Resolve current live video for the channel via server function
    videoId = await resolveVideoIdFromChannel(CHANNEL_ID);
    if (!videoId) {
      pushMessage(`No active livestream for channel ${CHANNEL_ID}`);
      return;
    }
  }

  // Create browser client with proxy for CORS
  const yt = await Innertube.create({
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      return fetch(`/api/yt-proxy?url=${encodeURIComponent(url)}`, init);
    },
    // Prefer WEB client; library will request "all chat" stream
    location: "US"
  });

  const info = await yt.getInfo(videoId).catch(() => null);
  if (!info) { pushMessage("Failed to load video info."); return; }

  const liveChat = info.getLiveChat?.();
  if (!liveChat) { pushMessage("Live chat not available."); return; }

  let continuation = await liveChat.getInitialContinuation?.();
  const seen = new Set();

  while (true) {
    try {
      const resp = continuation
        ? await liveChat.getContinuation(continuation, { client: "WEB" })
        : await liveChat.getChat({ client: "WEB" });

      continuation = resp?.continuation;

      const actions = resp?.actions || [];
      for (const act of actions) {
        const add = act.addChatItemAction || act.addLiveChatItemAction;
        if (!add) continue;

        const item =
          add.item?.liveChatTextMessageRenderer ||
          add.item?.liveChatPaidMessageRenderer ||
          add.item?.liveChatMembershipItemRenderer ||
          add.item?.liveChatPaidStickerRenderer;

        if (!item) continue;
        const id = item.id || item.timestampUsec;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);

        const author = item.authorName?.simpleText || item.authorName?.text || "User";
        const runs = item.message?.runs || item.headerPrimaryText?.runs || [];
        const textHTML = runsToHTML(runs);

        pushMessage(`${authorSpan(author)} <span class="msg__text">${textHTML}</span>`);
      }
    } catch (e) {
      // swallow and retry quickly
      console.warn("chat poll error", e);
    }
    await sleep(350); // rapid updates
  }
})();
