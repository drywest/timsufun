// server/server.js
// Node server: resolves channelId -> live video, exposes:
//  - POST /create  { channelId }  => { key, overlayUrl }
//  - GET  /links/:key  => mapping info
//  - GET  /sse?key=KEY  => Server-Sent Events streaming chat for that channel's current live video
//
// Install: npm i
// Run:   node server/server.js

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Innertube } from 'youtubei.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');

async function ensureDataFile() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(LINKS_FILE);
  } catch (e) {
    await fs.writeFile(LINKS_FILE, JSON.stringify({}), 'utf8');
  }
}

async function readLinks() {
  await ensureDataFile();
  const raw = await fs.readFile(LINKS_FILE, 'utf8');
  return JSON.parse(raw || '{}');
}
async function writeLinks(obj) {
  await ensureDataFile();
  await fs.writeFile(LINKS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function genKey() {
  return crypto.randomBytes(6).toString('base64url'); // short URL-safe key
}

// Utility: try to parse attributed text runs returned by youtubei
function runsToHtml(runs) {
  if (!runs) return '';
  // runs is array of { text, emoji?, navigationEndpoint? ...}
  let out = '';
  for (const r of runs) {
    if (typeof r === 'string') {
      out += escapeHtml(r);
      continue;
    }
    if (r.text) {
      out += escapeHtml(r.text);
    } else if (r.emoji) {
      // emoji object may contain thumbnails or image
      const emoji = r.emoji;
      let src = null;
      if (emoji.image && emoji.image.url) src = emoji.image.url;
      else if (emoji.thumbnails && emoji.thumbnails[0] && emoji.thumbnails[0].url) src = emoji.thumbnails[0].url;
      else if (emoji.hostedAnimateUrl) src = emoji.hostedAnimateUrl;
      if (src) {
        out += `<img class="yt-emoji" src="${escapeAttr(src)}" alt="${escapeHtml(emoji.shortcut || emoji.text || '')}" />`;
      } else if (emoji.emojiText) {
        out += escapeHtml(emoji.emojiText);
      } else {
        out += escapeHtml(JSON.stringify(emoji).slice(0, 6));
      }
    } else {
      // fallback to entire object
      out += escapeHtml(r.text || JSON.stringify(r));
    }
  }
  return out;
}
function escapeHtml(s) {
  return String(s || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}
function escapeAttr(s) {
  return String(s || '').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

async function resolveLiveVideoIdForChannel(youtube, channelId) {
  // Strategy:
  // - use getChannel(channelId) and look for live content in channel's tabs/contents
  // - fallback: search "channelId live" (we'll try channel endpoint first)
  try {
    const channel = await youtube.getChannel(channelId);
    // the channel object has tabs / contents...
    // youtubei returns a lot of structure; simplest approach: inspect channel.playlist or related.
    // We'll attempt to locate 'live' video by checking uploads or the "live" continuation content.
    // Many times channel.getLiveStream() is not available; so we iterate channel.data?.contents
    // The youtubei.js Channel object sometimes exposes `channel.latestUploads` etc. We'll inspect general info:
    const live = channel?.metadata?.isLive || channel?.hasActiveLiveStream;
    // try channel.getLiveStream if supported
    if (typeof channel.getLiveStream === 'function') {
      try {
        const liveVid = await channel.getLiveStream();
        if (liveVid && liveVid.id) return liveVid.id;
      } catch (e) {
        // ignore
      }
    }

    // Try to inspect two common places in returned channel object:
    // 1) channel.videos or channel.videos?.items
    const possibleIds = new Set();

    try {
      // using search for "channelId live" as fallback:
      const search = await youtube.search(`${channelId} live`, { type: 'video' });
      if (search && search.length) {
        for (const item of search) {
          if (item.isLive) return item.id;
        }
      }
    } catch (e) { /* ignore */ }

    // fallback: attempt to fetch the channel's browse endpoint and search for "isLive"
    try {
      const browse = await youtube.browse(channelId);
      const items = JSON.stringify(browse).toLowerCase();
      const m = items.match(/videoid\":\"([a-z0-9_-]{5,})\",\"islive\":true/);
      if (m) return m[1];
    } catch (e) { /* ignore */ }

    // If nothing found, return null
    return null;
  } catch (err) {
    console.warn('resolveLiveVideoIdForChannel error', err?.message || err);
    return null;
  }
}

async function streamChatSSE(res, youtube, channelId) {
  res.writeHead(200, {
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no' // for nginx: disable buffering
  });

  let ended = false;
  const ping = setInterval(() => {
    if (ended) return;
    // send a bare comment to keep connection alive
    res.write(':\n\n');
  }, 20000);

  try {
    // Attempt to resolve a live video quickly
    let videoId = await resolveLiveVideoIdForChannel(youtube, channelId);
    if (!videoId) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'No active live found for channel.' })}\n\n`);
      res.end();
      clearInterval(ping);
      return;
    }

    // create live chat instance via getInfo
    const info = await youtube.getInfo(videoId);
    const liveChat = info.getLiveChat();
    if (!liveChat) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Live chat not available for this video.' })}\n\n`);
      res.end();
      clearInterval(ping);
      return;
    }

    // polling loop
    let running = true;
    while (running) {
      try {
        const response = await liveChat.get(); // returns page of chat content
        // Response likely contains .actions or .items or .chats - check common keys
        const items = response.items || response.actions || response.chats || [];
        for (const it of items) {
          // Build normalized message
          // message text may be in it.message.runs or it.message.simpleText etc.
          let textHtml = '';
          if (it.message) {
            if (it.message.simpleText) {
              textHtml = escapeHtml(it.message.simpleText);
            } else if (it.message.runs) {
              textHtml = runsToHtml(it.message.runs);
            } else if (typeof it.message === 'string') {
              textHtml = escapeHtml(it.message);
            } else {
              textHtml = escapeHtml(JSON.stringify(it.message).slice(0, 240));
            }
          } else if (it.simpleText) {
            textHtml = escapeHtml(it.simpleText);
          } else if (it.text) {
            textHtml = escapeHtml(it.text);
          } else {
            textHtml = '';
          }

          const author = it.author?.name || it.authorName || it.authorDetails?.displayName || (it.authorNameText && it.authorNameText.simpleText) || 'unknown';
          const authorId = it.author?.id || it.authorId || it.authorDetails?.channelId || null;

          const msg = {
            id: it.id || it.actionId || Math.random().toString(36).slice(2),
            videoId,
            channelId,
            author,
            authorId,
            text: textHtml,
            raw: undefined,
            timestamp: Date.now()
          };

          // Send event
          res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
        }

        // If video went offline and response signals something, attempt to re-resolve
        // Some responses include continuation or .isReplay etc.
        const wait = response.pollingIntervalMillis || 1500;
        await new Promise(r => setTimeout(r, Math.max(800, wait || 1500)));

        // If continuation disappears or web indicates live ended, re-resolve live video
        if (!response.continuation && (!response.items || response.items.length === 0)) {
          // Try re-resolve new live video
          const newVid = await resolveLiveVideoIdForChannel(youtube, channelId);
          if (!newVid) {
            // if none found, end SSE with message and exit
            res.write(`event: info\ndata: ${JSON.stringify({ message: 'Live ended or not found (will retry)' })}\n\n`);
            // Wait a bit and then attempt to re-resolve repeatedly
            await new Promise(r => setTimeout(r, 5000));
            const attempt = await resolveLiveVideoIdForChannel(youtube, channelId);
            if (attempt && attempt !== videoId) {
              videoId = attempt;
              // get new liveChat object for the new video
              const newInfo = await youtube.getInfo(videoId);
              const newLive = newInfo.getLiveChat();
              if (newLive) {
                // replace liveChat reference and continue
                // note: liveChat is a closure variable - for simplicity, reassign
                Object.assign(liveChat, newLive);
                continue;
              } else {
                running = false;
                break;
              }
            } else {
              // no live found; end stream
              running = false;
              break;
            }
          } else {
            // switch videoId and continue
            videoId = newVid;
            const newInfo = await youtube.getInfo(videoId);
            const newLive = newInfo.getLiveChat();
            if (newLive) {
              Object.assign(liveChat, newLive);
              continue;
            } else {
              running = false;
              break;
            }
          }
        }
      } catch (err) {
        // send error event but keep the connection open and try to continue
        console.error('chat poll error', err?.message || err);
        res.write(`event: error\ndata: ${JSON.stringify({ message: String(err?.message || err) })}\n\n`);
        // wait then try again
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    res.write(`event: info\ndata: ${JSON.stringify({ message: 'Stream ended' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('streamChatSSE top error', err?.message || err);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(err?.message || err) })}\n\n`);
      res.end();
    } catch (e) {}
  } finally {
    clearInterval(ping);
  }
}

async function main() {
  await ensureDataFile();
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public'))); // serve overlay + UI

  // create Innertube client singleton
  const youtube = await Innertube.create();

  // POST /create { channelId } -> { key, overlayUrl }
  app.post('/create', async (req, res) => {
    try {
      const { channelId } = req.body;
      if (!channelId) return res.status(400).json({ error: 'channelId required' });

      const links = await readLinks();

      // check if a mapping already exists for this channel (reuse)
      for (const [k, v] of Object.entries(links)) {
        if (v.channelId === channelId) {
          const overlayUrl = `${req.protocol}://${req.get('host')}/overlay.html?key=${k}`;
          return res.json({ key: k, overlayUrl, mapping: v });
        }
      }

      const key = genKey();
      const mapping = {
        channelId,
        createdAt: Date.now()
      };
      links[key] = mapping;
      await writeLinks(links);

      const overlayUrl = `${req.protocol}://${req.get('host')}/overlay.html?key=${key}`;
      return res.json({ key, overlayUrl, mapping });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /links/:key -> mapping
  app.get('/links/:key', async (req, res) => {
    const key = req.params.key;
    const links = await readLinks();
    const m = links[key];
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json({ key, mapping: m });
  });

  // SSE endpoint: /sse?key=KEY
  app.get('/sse', async (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'key required' });

    const links = await readLinks();
    const mapping = links[key];
    if (!mapping) return res.status(404).json({ error: 'key not found' });

    const channelId = mapping.channelId;
    // Start SSE streaming for this channelId
    try {
      await streamChatSSE(res, youtube, channelId);
    } catch (err) {
      console.error('sse error', err);
      try { res.end(); } catch (e) {}
    }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server listening on http://0.0.0.0:${port}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
