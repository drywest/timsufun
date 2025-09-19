// public/overlay.js

const qs = new URLSearchParams(location.search);
const VIDEO_ID = qs.get("video");
const CHANNEL_ID = qs.get("channel");

const chatEl = document.getElementById("chat");

function escapeHTML(s) {
  return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function runsToHTML(runs = []) {
  return runs.map(run => {
    if (run.text) {
      return escapeHTML(run.text);
    }
    if (run.emoji) {
      // YouTube custom emoji ships as "image" (thumbnail/sources)
      const src =
        run.emoji?.image?.sources?.[0]?.url ||
        run.emoji?.image?.thumbnails?.slice(-1)?.[0]?.url;
      if (src) return `<img class="emoji" alt="" src="${src}">`;
      // Fallback to unicode if present
      if (run.emoji.emoji_id) return run.emoji.emoji_id;
    }
    return "";
  }).join("");
}

function pushMessage(author, runs) {
  const html = `<span class="msg__author">${escapeHTML(author).toUpperCase()}:</span> <span class="msg__text">${runsToHTML(runs)}</span>`;
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = html;
  chatEl.appendChild(div);

  // Keep last ~300 lines (plenty while staying safe)
  const max = 300;
  while (chatEl.children.length > max) chatEl.removeChild(chatEl.firstChild);
}

function connect() {
  if (!VIDEO_ID && !CHANNEL_ID) {
    const div = document.createElement("div");
    div.className = "msg";
    div.textContent = "Missing ?video=VIDEO_ID or ?channel=CHANNEL_ID";
    chatEl.appendChild(div);
    return;
  }

  const params = new URLSearchParams();
  if (VIDEO_ID) params.set("video", VIDEO_ID);
  if (CHANNEL_ID) params.set("channel", CHANNEL_ID);

  const es = new EventSource(`/sse?${params.toString()}`);

  es.addEventListener("chat", (e) => {
    try {
      const msg = JSON.parse(e.data);
      pushMessage(msg.author || "User", msg.runs || []);
    } catch {}
  });

  es.addEventListener("status", (e) => {
    // Optional: show one-line status messages if needed
    try {
      const s = JSON.parse(e.data);
      if (s?.error) {
        const div = document.createElement("div");
        div.className = "msg";
        div.textContent = s.error;
        chatEl.appendChild(div);
      }
    } catch {}
  });

  es.onerror = () => {
    // If connection dies, browser will retry automatically. Nothing to do.
  };
}

connect();
