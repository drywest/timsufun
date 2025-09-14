// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import axios from "axios";
import { Innertube } from "youtubei.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// tracks listeners per channelId
const listeners = new Map();

/**
 * Try to find the current live videoId for a given channel by requesting /channel/<id>/live
 * This method:
 *  - follows redirects (axios does by default)
 *  - inspects final URL for watch?v=...
 *  - falls back to searching HTML for "videoId":"..."
 */
async function getLiveVideoIdFromChannel(channelId) {
  try {
    const url = `https://www.youtube.com/channel/${channelId}/live`;
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400
    });

    // axios exposes final redirected URL here in many Node versions:
    const finalUrl =
      res.request?.res?.responseUrl || res.request?.res?.headers?.location || "";

    if (finalUrl && finalUrl.includes("watch?v=")) {
      const m = finalUrl.match(/v=([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }

    // fallback: inspect HTML for a "videoId":"XXXXXXXXXXX"
    const html = res.data || "";
    let m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (m) return m[1];
    m = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];

    return null;
  } catch (err) {
    console.warn("getLiveVideoIdFromChannel error:", err.message);
    return null;
  }
}

/**
 * Start monitoring a channel. Returns an object with current state.
 * We reuse an Innertube instance for the channel.
 */
async function ensureListener(channelId) {
  if (listeners.has(channelId)) return listeners.get(channelId);

  const state = {
    sockets: new Set(),
    youtube: null,
    livechat: null,
    videoId: null,
    pollTimer: null
  };
  listeners.set(channelId, state);

  // create Innertube client instance
  try {
    state.youtube = await Innertube.create();
  } catch (err) {
    console.error("Innertube create failed:", err);
    return state;
  }

  // try immediately; if not live, poll every 5s until a live starts while we have clients
  async function tryStartOnce() {
    const vid = await getLiveVideoIdFromChannel(channelId);
    if (vid && vid !== state.videoId) {
      startLivechatForVideo(channelId, vid, state).catch((e) =>
        console.error("startLivechatForVideo error:", e)
      );
    }
  }

  // immediate attempt
  await tryStartOnce();

  // polling while we have sockets and no livechat
  state.pollTimer = setInterval(async () => {
    if (state.sockets.size === 0) return; // no listeners -> don't waste requests
    if (!state.videoId) await tryStartOnce();
  }, 5000);

  return state;
}

/**
 * Start a livechat stream for a resolved videoId (uses youtubei.js built-in livechat support).
 * forwards messages to socket.io room named after channelId
 */
async function startLivechatForVideo(channelId, videoId, state) {
  try {
    console.log(`Starting livechat for channel=${channelId} video=${videoId}`);
    // stop previous if exists
    if (state.livechat && typeof state.livechat.stop === "function") {
      try {
        state.livechat.stop();
      } catch {}
      state.livechat.removeAllListeners?.();
      state.livechat = null;
    }

    state.videoId = videoId;

    const video = await state.youtube.getInfo(videoId);
    if (!video) {
      console.warn("youtube.getInfo returned null for", videoId);
      return;
    }

    // many versions provide video.getLivechat()
    if (typeof video.getLivechat !== "function") {
      console.warn("video.getLivechat not available for", videoId);
      return;
    }

    const livechat = video.getLivechat();

    // forward metadata updates
    livechat.on("update-metadata", (meta) =>
      io.to(channelId).emit("meta", { videoId, meta })
    );

    // events for each chat update
    livechat.on("chat-update", (message) => {
      try {
        // normalized payload (simple)
        const payload = {
          id: message.id || `m_${Date.now()}`,
          author: {
            name: message.author?.name || "Unknown",
            channelId: message.author?.id || message.author?.channelId || null,
            badges: message.author?.badges || []
          },
          text: message.text || (message.message ?? ""),
          raw: message
        };
        io.to(channelId).emit("chat", payload);
      } catch (e) {
        console.warn("error emitting chat:", e);
      }
    });

    livechat.on("end", () => {
      io.to(channelId).emit("ended", { videoId });
      state.videoId = null;
    });

    // start the internal loop if the lib requires it (many versions auto-poll)
    if (typeof livechat.start === "function") {
      try {
        livechat.start();
      } catch {}
    }

    state.livechat = livechat;
  } catch (err) {
    console.error("startLivechatForVideo error:", err);
  }
}

/**
 * Stop and cleanup listener for channel when no clients left
 */
function stopListenerIfIdle(channelId) {
  const state = listeners.get(channelId);
  if (!state) return;
  if (state.sockets.size === 0) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    try {
      state.livechat?.stop?.();
    } catch {}
    state.youtube = null;
    state.livechat = null;
    listeners.delete(channelId);
    console.log("Stopped listener for", channelId);
  }
}

/* socket.io handling */
io.on("connection", (socket) => {
  socket.on("join", async ({ channel }) => {
    if (!channel) return;
    socket.join(channel);
    socket.data.channel = channel;

    const state = await ensureListener(channel);
    state.sockets.add(socket.id);

    // quick status to client
    socket.emit("status", { ok: true, channel });

    // do not return existing backlog (overlay is push-only); client will get next messages.
  });

  socket.on("disconnect", () => {
    const channel = socket.data.channel;
    if (!channel) return;
    const state = listeners.get(channel);
    if (!state) return;
    state.sockets.delete(socket.id);
    // cleanup potentially
    stopListenerIfIdle(channel);
  });
});

/* pages */
app.get("/", (req, res) => {
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

// overlay page example served statically from public folder

server.listen(PORT, () => {
  console.log(`YT Chat overlay server listening: http://localhost:${PORT}`);
});
