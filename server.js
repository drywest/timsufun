// server.js
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Innertube, UniversalCache } from 'youtubei.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/overlay/:channelId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

const PORT = process.env.PORT || 3000;
const YT_READY = Innertube.create({ cache: new UniversalCache(true) });

const managers = new Map();

class ChatManager {
  constructor(channelId, yt) {
    this.channelId = channelId;
    this.yt = yt;
    this.livechat = null;
    this.videoId = null;
    this.clients = new Set();
    this.timer = null;
    this.stopped = false;
  }
  addClient(ws) { this.clients.add(ws); ws.on('close', () => this.clients.delete(ws)); }
  broadcast(msg) { const data = JSON.stringify(msg); for (const ws of this.clients) if (ws.readyState === 1) ws.send(data); }
  stop() { this.stopped = true; clearTimeout(this.timer); try { this.livechat?.stop(); } catch {} this.livechat = null; }
  async start() { this.stopped = false; await this.loop(); }

  async loop() {
    if (this.stopped) return;
    try { if (!this.livechat) await this.attach(); }
    catch { this.broadcast({ type: 'status', text: 'Waiting for stream…' }); }
    finally { this.timer = setTimeout(() => this.loop(), 800); } // <- your polling frequency
  }

  async attach() {
    const info = await resolveLiveInfo(this.yt, this.channelId);
    if (!info) throw new Error('No live found');
    const chat = info.getLiveChat?.();
    if (!chat) throw new Error('Live chat not available');

    this.videoId = info?.basic_info?.id || info?.id || null;
    this.livechat = chat;

    // Force ALL messages (not Top Chat) and keep re-applying
    ensureAllChat(chat);

    // HARD disable smoothing so we get events ASAP
    try {
      if (chat.smoothed_queue) {
        chat.smoothed_queue.setEnabled?.(false);
        chat.smoothed_queue.enabled = false;
        chat.smoothed_queue.setEmitDelay?.(0);
        chat.smoothed_queue.setMaxBatchSize?.(1);
        const directEmit = (arr) => { try { chat.emit?.('actions', arr); } catch {} };
        chat.smoothed_queue.push = (arr) => directEmit(arr);
        chat.smoothed_queue.clear?.();
      }
    } catch {}

    const handle = (evt) => {
      try {
        const arr = normalizeActions(evt);
        if (!arr.length) return;
        for (const m of parseActions(arr)) this.broadcast({ type: 'single', message: m }); // one-by-one, instant
      } catch (e) { console.error('[chat handler]', e); }
    };

    chat.on('start', () => this.broadcast({ type: 'status', text: `Connected to live chat (${this.videoId || 'video'})` }));
    chat.on('end',   () => { this.broadcast({ type: 'status', text: 'Stream ended. Waiting for next live…' }); try { chat.stop(); } catch {}; this.livechat = null; });
    chat.on('error', (e) => { this.broadcast({ type: 'status', text: `Chat error: ${String(e?.message || e)}` }); try { chat.stop(); } catch {}; this.livechat = null; });

    chat.on?.('metadata-update', () => ensureAllChat(chat));
    chat.on('chat-update', handle);
    chat.on('actions',     handle);

    chat.start();
  }
}

/* -------- Live resolver: /channel/{id}/live first, then tab fallback -------- */
async function resolveLiveInfo(yt, channelId) {
  try {
    const info = await yt.getInfo(`https://www.youtube.com/channel/${channelId}/live`);
    if (info?.getLiveChat?.()) return info;
  } catch {}
  try {
    const channel = await yt.getChannel(channelId);
    let list = [];
    try { const liveTab = await channel.getTabByName?.('Live'); list = liveTab?.videos ?? []; } catch {}
    if (!list?.length) list = channel?.videos ?? [];
    const liveItem = (list || []).find(v => v?.is_live);
    const vid = liveItem?.id || liveItem?.video_id;
    if (vid) return await yt.getInfo(vid);
  } catch {}
  return null;
}

/* -------- Make sure we're on ALL chat -------- */
function ensureAllChat(chat) {
  const apply = () => { try { chat.applyFilter?.('LIVE_CHAT'); } catch {} };
  apply();
  setTimeout(apply, 1000);
  setTimeout(apply, 5000);
}

/* ---------------- payload utils ---------------- */
function normalizeActions(evt) {
  if (!evt) return [];
  if (Array.isArray(evt)) return evt;
  if (typeof evt[Symbol.iterator] === 'function') return Array.from(evt);
  if (Array.isArray(evt.actions)) return evt.actions;
  if (evt.actions && typeof evt.actions[Symbol.iterator] === 'function') return Array.from(evt.actions);
  if (evt.action) return [evt.action];
  if (typeof evt === 'object' && (evt.type || evt.item || evt.item_type)) return [evt];
  return [];
}

function parseActions(actions) {
  const out = [];
  for (const act of actions) {
    const t = act?.type || act?.action_type || '';
    if (t && t !== 'AddChatItemAction') continue;

    const item = act?.item || act;
    const itype = item?.type || item?.item_type || '';
    if (!['LiveChatTextMessage','LiveChatPaidMessage','LiveChatMembershipItem'].includes(itype)) continue;

    const author =
      item?.author?.name?.toString?.() ??
      item?.author?.name?.text ??
      item?.author_name?.text ??
      item?.authorName ?? 'User';

    // Message HTML with emoji <img> (prefer Text#toHTML(), fallback to runs parser)
    const html = textToHtml(
      item?.message ??
      item?.message?.text ??
      item?.header_primary_text ??
      item?.headerPrimaryText ??
      null
    );

    // Badges
    const badges = item?.author_badges || item?.authorBadges || [];
    const isMod    = !!badges.find(b => (b?.tooltip || b?.label || '').toLowerCase().includes('moderator'));
    const isOwner  = !!badges.find(b => (b?.tooltip || b?.label || '').toLowerCase().includes('owner'));
    const isMember = !!badges.find(b => (b?.tooltip || b?.label || '').toLowerCase().includes('member'));

    // Collect membership badge image URLs so the overlay can render them
    const member_badges = [];
    for (const b of badges) {
      const tip = (b?.tooltip || b?.label || '').toLowerCase();
      if (!tip.includes('member')) continue;
      const url = pickThumbUrl(
        b?.custom_thumbnail?.thumbnails ||
        b?.thumbnail?.thumbnails ||
        b?.thumbnails ||
        b?.icon?.thumbnails ||
        []
      );
      if (url) member_badges.push(url);
    }

    out.push({ type: 'chat', author, html, isMod, isOwner, isMember, member_badges, rawType: itype });
  }
  return out;
}

function pickThumbUrl(thumbs) {
  if (!Array.isArray(thumbs) || !thumbs.length) return null;
  return thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || null;
}

/* Convert generic Text object (with optional toHTML/runs) into HTML */
function textToHtml(obj) {
  // Prefer Text#toHTML() when available (YouTube emojis render as <img>)
  try {
    if (obj && typeof obj.toHTML === 'function') {
      const html = obj.toHTML();
      if (typeof html === 'string' && html.trim()) return html;
    }
  } catch {}

  // Fallback: if we have runs, use the custom runs parser
  const runs =
    (obj && (obj.runs || obj.text?.runs)) ||
    (Array.isArray(obj) ? obj : null);

  if (Array.isArray(runs) && runs.length) return runsToHtml(runs);

  // Last resort: stringify safely
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  if (typeof obj === 'string') return esc(obj);
  if (obj != null && typeof obj.toString === 'function') return esc(obj.toString());
  return '';
}

/* Convert runs (text + custom emoji) to HTML
   We output <img class="yt-emoji emoji" src="..." data-src="..."> so the client
   can rebuild them with referrerPolicy/crossOrigin BEFORE loading in OBS.
*/
function runsToHtml(runs) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  let out = '';
  for (const r of runs || []) {
    if (r?.text != null) {
      out += esc(r.text);
    } else if (r?.emoji) {
      const em = r.emoji;
      const thumbs = em.image?.thumbnails || em.thumbnails || [];
      const src = thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || '';
      const alt = em.shortcuts?.[0] || em.label || 'emoji';
      if (src) {
        const s = esc(src), a = esc(alt);
        out += `<img class="yt-emoji emoji" src="${s}" data-src="${s}" alt="${a}" />`;
      } else {
        out += esc(alt);
      }
    }
  }
  return out;
}

/* ---------------- ws ---------------- */
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const channelId = url.searchParams.get('channelId');
  if (!channelId) { ws.send(JSON.stringify({ type: 'status', text: 'Missing channelId' })); ws.close(); return; }

  const yt = await YT_READY;
  let mgr = managers.get(channelId);
  if (!mgr) { mgr = new ChatManager(channelId, yt); managers.set(channelId, mgr); mgr.start().catch(() => {}); }
  mgr.addClient(ws);
  ws.send(JSON.stringify({ type: 'status', text: 'Connecting…' }));
});

httpServer.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]', e));
