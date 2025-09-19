// server/server.js
res.writeHead(200, {
Connection: 'keep-alive',
'Content-Type': 'text/event-stream',
'Cache-Control': 'no-cache',
});


// create innertube client
const youtube = await Innertube.create();


// fetch video info
const info = await youtube.getInfo(videoId);
const liveChat = info.getLiveChat();


if (!liveChat) {
res.write(`event: error\ndata: ${JSON.stringify({ message: 'No live chat found for that videoId' })}\n\n`);
res.end();
return;
}


let running = true;


// Send heartbeat every 20s to keep connection alive
const heartbeat = setInterval(() => {
if (!running) return;
res.write(`:\n`); // comment ping
}, 20000);


// Polling loop: use the LiveChat object to fetch next batches
try {
let continuation = liveChat.continuation; // initial continuation


while (running && continuation) {
const response = await liveChat.get(); // fetch page


// response.actions may contain chat actions; fallback to response.content
const items = response.items || response.chats || [];


for (const item of items) {
// Transform item into a simplified message object the overlay expects
const msg = {
id: item.id || item.actionId || (item.listener && item.listener.id) || Math.random().toString(36).slice(2),
author: item.author?.name || item.authorName || (item.authorDetails && item.authorDetails.displayName) || 'unknown',
authorId: item.author?.id || item.authorId || item.authorDetails?.channelId || null,
text: (item.message && item.message.simpleText) || (item.message && item.message.runs && item.message.runs.map(r=>r.text).join('')) || item.content || '',
badges: item.author?.badges || [],
timestamp: Date.now(),
};


// send SSE event
res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
}


// update continuation / sleep according to suggested interval
continuation = response.continuation;


const wait = (response?.pollingIntervalMillis) ? response.pollingIntervalMillis : 1500;
await new Promise(r => setTimeout(r, Math.max(800, wait)));
}
} catch (err) {
console.error('chat stream error', err);
if (running) {
res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
}
} finally {
running = false;
clearInterval(heartbeat);
try { res.end(); } catch (e){}
}
}


// SSE endpoint: client connects and passes ?videoId=VIDEO_ID
app.get('/sse', async (req, res) => {
const videoId = req.query.videoId;
if (!videoId) return res.status(400).json({ error: 'videoId required' });


try {
await streamChatSSE(res, String(videoId));
} catch (err) {
console.error(err);
res.status(500).json({ error: String(err) });
}
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy server running on :${port}`));
