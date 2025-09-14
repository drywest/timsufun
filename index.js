/**
 * index.js
 * Node.js server that:
 *  - resolves channel -> live video id (/channel/:id/live)
 *  - fetches live_chat popout HTML -> extracts INNERTUBE API key, clientVersion, continuation
 *  - polls youtubei get_live_chat endpoint frequently and forwards parsed messages to overlay clients via socket.io
 *
 * Notes:
 *  - hosted on Replit: listens on process.env.PORT or 3000
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { fetch } = require('undici'); // stable fetch in Node
const { Server } = require('socket.io');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// Serve static web client
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Simple home + overlay creation endpoints:
app.get('/api/resolve/video/:channelOrUrl', async (req, res) => {
  // Accept channel ID, handle (@handle) or full channel URL, or video id directly
  try {
    const input = req.params.channelOrUrl;
    const norm = normalizeChannelInput(input);
    if (!norm) return res.status(400).json({ error: 'Invalid channel input' });
    const videoId = await resolveLiveVideoId(norm);
    if (!videoId) return res.status(404).json({ error: 'No live video found for that channel' });
    return res.json({ videoId, overlayUrl: `/overlay/${videoId}` });
  } catch (err) {
    console.error('resolve error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Overlay route serves static overlay page (public/overlay.html)
app.get('/overlay/:videoId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// poller map: videoId -> Poller instance
const pollers = new Map();

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('subscribe', async ({ videoId, freqMs }) => {
    try {
      if (!videoId) return socket.emit('error', 'missing videoId');
      socket.join(videoId);
      // create or reuse poller
      let p = pollers.get(videoId);
      if (!p) {
        p = new Poller(videoId, freqMs || 700); // default: 700ms
        pollers.set(videoId, p);
        p.start();
      } else {
        // possibly update freq if changed (client asked faster)
        if (freqMs && freqMs < p.freqMs) {
          p.setFreq(freqMs);
        }
        if (!p.running) p.start();
      }
      // increment client count handled inside Poller
      p.addClientSocket(socket);
      console.log(`socket ${socket.id} subscribed to ${videoId}`);
    } catch (err) {
      console.error('subscribe err', err);
      socket.emit('error', String(err));
    }
  });

  socket.on('unsubscribe', ({ videoId }) => {
    if (!videoId) return;
    const p = pollers.get(videoId);
    if (p) p.removeClientSocket(socket);
  });

  socket.on('disconnect', reason => {
    // remove socket from all pollers
    for (const [vid, p] of pollers.entries()) {
      p.removeClientSocket(socket);
      // if poller has no clients, poller will auto stop after timeout
      if (!p.hasClients()) {
        // schedule removal after a grace period handled inside Poller
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

/* ---------- Utilities & Poller implementation ---------- */

function normalizeChannelInput(input) {
  if (!input) return null;
  // strip whitespace
  let s = input.trim();
  // if full url, try to extract channel id or handle
  try {
    if (s.startsWith('http')) {
      const u = new URL(s);
      // e.g. /channel/UCxxxxx or /c/someName or /@handle or /watch?v=...
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'channel' && parts[1]) return { type: 'channelId', id: parts[1] };
      if (parts[0] === 'c' && parts[1]) return { type: 'custom', id: parts[1] };
      if (parts[0].startsWith('@')) return { type: 'handle', id: parts[0] };
      if (u.searchParams.get('v')) return { type: 'videoId', id: u.searchParams.get('v') };
    }
    // raw id: video id? (length ~11)
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return { type: 'videoId', id: s };
    // channel id starts with UC
    if (s.startsWith('UC') && s.length > 20) return { type: 'channelId', id: s };
    // handle like @name or raw handle
    if (s.startsWith('@')) return { type: 'handle', id: s };
    // custom name
    return { type: 'custom', id: s };
  } catch (e) {
    return null;
  }
}

async function resolveLiveVideoId(norm) {
  // If input already a video id, return it
  if (norm.type === 'videoId') return norm.id;

  // Best approach: request /channel/{id}/live or /@handle/live and follow redirects.
  // Try channel, handle, custom:
  const tryUrls = [];
  if (norm.type === 'channelId') tryUrls.push(`https://www.youtube.com/channel/${norm.id}/live`);
  if (norm.type === 'handle' || norm.type === 'custom') {
    tryUrls.push(`https://www.youtube.com/${norm.id}/live`);
    tryUrls.push(`https://www.youtube.com/c/${norm.id}/live`);
    tryUrls.push(`https://www.youtube.com/user/${norm.id}/live`);
  }
  // Attempt each
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      // after redirects, the final url may be a watch?v=VIDEOID
      const finalUrl = res.url;
      if (finalUrl) {
        const parsed = new URL(finalUrl);
        const vid = parsed.searchParams.get('v');
        if (vid) return vid;
      }
      // else parse html for watch?v= in the content
      const txt = await res.text();
      const m = txt.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    } catch (e) {
      // try next
    }
  }
  return null;
}

/**
 * Poller: fetches initial continuation + innertube key, then repeatedly POSTs to
 * youtubei get_live_chat endpoint and emits each parsed chat message via socket.io room = videoId
 */
class Poller {
  constructor(videoId, freqMs = 700) {
    this.videoId = videoId;
    this.freqMs = Math.max(250, Math.floor(freqMs)); // don't go below 250ms enforced
    this.running = false;
    this.timer = null;
    this.apiKey = null;
    this.clientVersion = null;
    this.continuation = null;
    this.lastFetch = 0;
    this.clientSockets = new Set();
    this.graceStopTimeout = null;
    this.stopped = false;
    this.fetching = false;
    this.failureCount = 0;
    this.room = videoId;
  }

  setFreq(ms) {
    this.freqMs = Math.max(250, Math.floor(ms));
  }

  addClientSocket(socket) {
    this.clientSockets.add(socket);
    socket.join(this.room);
    // when socket disconnects, remove it
    socket.on('disconnect', () => this.removeClientSocket(socket));
    // clear any auto-stop scheduled
    if (this.graceStopTimeout) {
      clearTimeout(this.graceStopTimeout);
      this.graceStopTimeout = null;
    }
  }

  removeClientSocket(socket) {
    if (this.clientSockets.has(socket)) {
      this.clientSockets.delete(socket);
      try { socket.leave(this.room); } catch (e) {}
    }
    // schedule graceful stop if no clients exist
    if (!this.hasClients()) {
      // stop after 20 seconds if no one reconnects
      if (!this.graceStopTimeout) {
        this.graceStopTimeout = setTimeout(() => {
          if (!this.hasClients()) this.stop();
        }, 20_000);
      }
    }
  }

  hasClients() {
    // remove dead sockets
    for (const s of [...this.clientSockets]) {
      if (s.disconnected) this.clientSockets.delete(s);
    }
    return this.clientSockets.size > 0;
  }

  start() {
    if (this.running) return;
    console.log('Poller start', this.videoId);
    this.running = true;
    this._startLoop().catch(err => {
      console.error('Poller start error', err);
      this.running = false;
    });
  }

  stop() {
    console.log('Poller stop', this.videoId);
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // cleanup map entry
    pollers.delete(this.videoId);
  }

  async _startLoop() {
    try {
      // initial setup: fetch live_chat popout to extract keys and initial continuation
      await this._ensureInit();
      // main loop
      while (this.running) {
        const now = Date.now();
        // guard re-entrancy
        if (this.fetching) {
          await new Promise(r => setTimeout(r, 20));
          continue;
        }
        this.fetching = true;
        try {
          await this._fetchOnce();
          this.failureCount = 0;
        } catch (err) {
          console.warn('poll fetch error', err?.message || err);
          this.failureCount++;
          // If too many failures, try re-init
          if (this.failureCount > 3) {
            console.log('attempting re-init after repeated failures');
            await this._ensureInit(true);
            this.failureCount = 0;
          }
        } finally {
          this.fetching = false;
        }
        // wait freqMs (but be responsive if stopped)
        await new Promise(r => {
          let t = setTimeout(() => {
            clearTimeout(t);
            r();
          }, this.freqMs);
          this.timer = t;
        });
      }
    } catch (err) {
      console.error('poller loop fatal', err);
      this.running = false;
    } finally {
      this.running = false;
    }
  }

  async _ensureInit(force=false) {
    if (!force && this.apiKey && this.continuation && this.clientVersion) return;
    // fetch popout html and extract innertube api key, clientVersion and initial continuation
    console.log('Poller init for', this.videoId);
    // Try the popout chat
    const popoutUrl = `https://www.youtube.com/live_chat?v=${this.videoId}&is_popout=1`;
    const res = await fetch(popoutUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const text = await res.text();
    // use regex extractions (robust to variations)
    // innertubeApiKey
    const apiKeyMatch = text.match(/innertubeApiKey["']?\s*[:=]\s*["']([^"']+)["']/i)
                       || text.match(/INNERTUBE_API_KEY["']?\s*[:=]\s*["']([^"']+)["']/i);
    const clientVerMatch = text.match(/INNERTUBE_CONTEXT_CLIENT_VERSION["']?\s*[:=]\s*["']([^"']+)["']/i)
                         || text.match(/INNERTUBE_CLIENT_VERSION["']?\s*[:=]\s*["']([^"']+)["']/i)
                         || text.match(/"clientVersion"\s*:\s*"([^"]+)"/i);
    const continuationMatch = text.match(/"continuation"\s*:\s*"([^"]+)"/i);

    if (!apiKeyMatch || !continuationMatch) {
      // fallback: try to find inside ytInitialData or ytcfg
      // search for innertubeApiKey in the HTML
      const altApiMatch = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/i) || text.match(/"innertubeApiKey":"([^"]+)"/i);
      if (altApiMatch) this.apiKey = altApiMatch[1];
    }
    if (apiKeyMatch) this.apiKey = apiKeyMatch[1];
    if (clientVerMatch) this.clientVersion = clientVerMatch[1];
    if (continuationMatch) this.continuation = continuationMatch[1];

    // If we still don't have those, try parsing scripts for ytcfg
    if (!this.apiKey || !this.continuation) {
      // attempt to grab using cheerio to find scripts
      const $ = cheerio.load(text);
      const scripts = $('script').map((i, s) => $(s).html()).get().join('\n');
      const mApi = scripts.match(/INNERTUBE_API_KEY":"([^"]+)"/) || scripts.match(/innertubeApiKey":"([^"]+)"/);
      const mCont = scripts.match(/"continuation":"([^"]+)"/);
      const mClient = scripts.match(/INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || scripts.match(/clientVersion":"([^"]+)"/);
      if (mApi) this.apiKey = mApi[1];
      if (mCont) this.continuation = mCont[1];
      if (mClient) this.clientVersion = mClient[1];
    }

    if (!this.apiKey || !this.continuation) {
      throw new Error('Failed to parse innertube API key / continuation from popout page.');
    }
    if (!this.clientVersion) {
      this.clientVersion = '2.20230530.00.00'; // fallback default; yt often accepts many versions
    }

    console.log('init OK', { apiKey: this.apiKey ? 'OK' : null, clientVersion: this.clientVersion, continuationPreview: this.continuation?.slice(0,10) });
  }

  async _fetchOnce() {
    if (!this.continuation) {
      await this._ensureInit(true);
    }
    const endpoint = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.apiKey}`;
    const payload = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: this.clientVersion,
          mainAppWebInfo: { graftUrl: `https://www.youtube.com/live_chat?continuation=` }
        },
        request: { useSsl: true }
      },
      continuation: this.continuation
    };
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'Referer': `https://www.youtube.com/watch?v=${this.videoId}`
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('get_live_chat failed: ' + res.status + ' ' + txt.slice(0,300));
    }
    const json = await res.json();

    // update continuation token from response (there are multiple possible places)
    const cont = extractContinuationFromResponse(json);
    if (cont) this.continuation = cont;

    // parse actions into chat items
    const actions = json?.continuationContents?.liveChatContinuation?.actions || [];
    // some responses include 'actions' directly
    // emit each action parsed into a simple object
    const parsed = [];
    for (const action of actions) {
      const item = parseChatAction(action);
      if (item) parsed.push(item);
    }
    // emit to clients in order (older->newer)
    if (parsed.length) {
      io.to(this.room).emit('chatBatch', parsed);
    }
  }
}

/* --------- Parsing helper functions ---------- */

function extractContinuationFromResponse(json) {
  try {
    const conts = json?.continuationContents?.liveChatContinuation?.continuations;
    if (Array.isArray(conts) && conts.length) {
      // choose the first available continuation token (timed or invalidation)
      for (const c of conts) {
        if (c?.invalidationContinuationData?.continuation) return c.invalidationContinuationData.continuation;
        if (c?.timedContinuationData?.continuation) return c.timedContinuationData.continuation;
        if (c?.continuationData?.continuation) return c.continuationData.continuation;
      }
    }
    // fallback: some responses include continuation in other places
    const m = JSON.stringify(json).match(/"continuation":"([^"]+)"/);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

function parseChatAction(action) {
  // action shapes vary. We try to find item + renderer
  const add = action?.addChatItemAction?.item || action?.replayChatItemAction?.actions?.[0]?.addChatItemAction?.item || action?.addChatItemAction || action?.addChatItemAction;
  const item = action?.addChatItemAction?.item || action?.replayChatItemAction?.actions?.[0]?.addChatItemAction?.item || action?.addChatItemAction?.item || action?.item || add;
  if (!item) return null;

  // message types: liveChatTextMessageRenderer, liveChatPaidMessageRenderer (superchat), liveChatMembershipItemRenderer etc.
  const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer || item.liveChatMembershipItemRenderer || item.liveChatTickerSponsorItemRenderer || null;
  if (!renderer) return null;

  // author
  const authorName = renderer?.authorName?.simpleText || (renderer?.authorName?.runs || []).map(r => r.text).join('') || 'Unknown';
  const authorChannelId = renderer?.authorExternalChannelId || null;
  const authorPhoto = renderer?.authorPhoto?.thumbnails?.slice(-1)?.[0]?.url || null;
  let timestampUsec = renderer?.timestampUsec || null;
  let timestamp = timestampUsec ? new Date(Number(timestampUsec) / 1000) : new Date();

  // message parts: runs OR simpleText
  const parts = [];
  if (renderer?.message?.runs) {
    for (const run of renderer.message.runs) {
      if (run.text) {
        parts.push({ type: 'text', text: run.text });
      } else if (run.emoji) {
        // try to extract image url
        const img = run.emoji?.image?.thumbnails?.slice(-1)?.[0]?.url || run.emoji?.image?.thumbnail?.url || run.emoji?.image?.url || run.emoji?.thumbnails?.slice(-1)?.[0]?.url;
        const alt = run.emoji?.shortcuts || run.emoji?.searchTerms?.join(' ') || run.emoji?.emojiId || run.emoji?.tooltip || run.emoji?.alt || '';
        parts.push({ type: 'emoji', url: img, alt });
      } else if (run?.emoji?.shortcuts) {
        // fallback
        parts.push({ type: 'text', text: run.emoji.shortcuts });
      } else {
        // unknown
        parts.push({ type: 'text', text: (run?.text || '') });
      }
    }
  } else if (renderer?.message?.simpleText) {
    parts.push({ type: 'text', text: renderer.message.simpleText });
  }

  // detect paid message (superchat)
  let isPaid = !!renderer?.purchaseAmountText;
  let paidInfo = null;
  if (isPaid) {
    paidInfo = {
      amount: renderer?.purchaseAmountText?.simpleText || renderer?.purchaseAmountText?.runs?.map(r=>r.text).join(''),
      color: renderer?.isSuperchat ? renderer?.background?.simpleColor || null : null
    };
  }

  return {
    id: renderer?.id || renderer?.videoOffsetTimeMsec || `${Date.now()}_${Math.random()}`,
    authorName,
    authorChannelId,
    authorPhoto,
    timestamp: timestamp.toISOString(),
    parts,
    isPaid,
    paidInfo
  };
}
