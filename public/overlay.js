// public/overlay.js
(function () {
  const stack = document.getElementById('stack');

  // Tuning: ?fs=36&keep=600
  const params = new URLSearchParams(location.search);
  const fontSize = parseInt(params.get('fs') || '36', 10);
  const keepParam = params.get('keep');
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  if (keepParam) document.documentElement.style.setProperty('--max-keep', parseInt(keepParam, 10));

  const channelId = decodeURIComponent(location.pathname.split('/').pop());
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const WS_URL = `${scheme}://${location.host}/ws?channelId=${encodeURIComponent(channelId)}`;

  // Owner/Mod badge assets
  const OWNER_IMG = '/public/badges/owner.png';
  const MOD_IMG   = '/public/badges/mod.gif';

  // Stable vibrant colors
  const colorCache = new Map();
  const palette = ['#FF4D4D','#FF8A4D','#FFCA3A','#8AC926','#52D1DC','#4D96FF','#B04DFF','#FF4DB7','#32D583','#F97066','#12B0E8','#7A5AF8','#EE46BC','#16BDCA'];
  function nameColor(name) {
    if (colorCache.has(name)) return colorCache.get(name);
    let h = 0; for (let i=0;i<name.length;i++) h = Math.imul(31, h) + name.charCodeAt(i) | 0;
    const c = palette[Math.abs(h) % palette.length]; colorCache.set(name, c); return c;
  }

  // Optional bot filter
  function isBot(name) {
    const n = String(name || '').toLowerCase().replace(/\s+/g, '');
    return n === 'nightbot' || n === 'streamlabs' || n === 'streamelements';
  }

  // --- WebSocket + input queue (so multiple messages push in a single tick) ---
  const inbox = [];
  let rafPending = false;

  function scheduleFlush() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const batch = inbox.splice(0, inbox.length);
      for (const payload of batch) pushChat(payload);
    });
  }

  let ws;
  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen   = () => console.log('[overlay] ws connected');
    ws.onclose  = () => setTimeout(connect, 250);
    ws.onerror  = () => ws.close();
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'status') {
          pushLine('System', escapeHtml(String(msg.text)));
        } else if (msg.type === 'single') {
          inbox.push(msg.message); scheduleFlush();
        } else if (msg.type === 'batch') {
          // Push all at once this frame → looks like a single “bulk push”
          for (const m of msg.messages) inbox.push(m);
          scheduleFlush();
        }
      } catch {}
    };
  }
  connect();

  function pushChat(payload) {
    const { author, html, isMod, isOwner, member_badges } = payload || {};
    if (isBot(author)) return;
    pushLine(author || 'User', html || '', !!isMod, !!isOwner, Array.isArray(member_badges) ? member_badges : []);
  }

  function pushLine(author, html, isMod, isOwner, memberBadges) {
    const line = document.createElement('div');
    line.className = 'line enter';

    // AUTHOR span
    const a = document.createElement('span');
    a.className = 'author';
    a.style.color = nameColor(author || 'User');

    // Badges BEFORE username: owner → mod → membership
    if (isOwner) a.appendChild(makeBadgeImg(OWNER_IMG, 'owner'));
    if (isMod)   a.appendChild(makeBadgeImg(MOD_IMG,   'mod'));
    for (const url of (memberBadges || [])) {
      if (!url) continue;
      a.appendChild(makeBadgeImg(url, 'member'));
    }

    // Username text (UPPERCASE + colon)
    a.appendChild(document.createTextNode(`${(author || 'User').toUpperCase()}:`));

    // MESSAGE span
    const m = document.createElement('span');
    m.className = 'message';
    m.innerHTML = ` ${html}`;

    normalizeEmojiImages(m);

    line.appendChild(a);
    line.appendChild(m);

    stack.appendChild(line);
    // Force layout then reveal (batch inserted lines animate together)
    line.getBoundingClientRect();
    line.classList.add('show');

    // Large buffer; drop oldest from top
    const maxKeep = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--max-keep')) || 600;
    while (stack.children.length > maxKeep) stack.removeChild(stack.firstChild);
  }

  function makeBadgeImg(src, alt) {
    const img = document.createElement('img');
    img.alt = alt || 'badge';
    img.style.height = '1em';
    img.style.width = 'auto';
    img.style.verticalAlign = '-0.12em';
    img.style.marginRight = '0.18em';
    img.decoding = 'async';
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    img.crossOrigin = 'anonymous';
    img.src = src;
    return img;
  }

  // Normalize emoji <img> so OBS renders them reliably (and with CORS/referrer set)
  function normalizeEmojiImages(container) {
    const candidates = container.querySelectorAll('img.yt-emoji, img.emoji, img[src*="yt3.ggpht.com"], img[src*="googleusercontent"], img[src*="ggpht"]');
    candidates.forEach(oldImg => {
      const src = oldImg.getAttribute('data-src') || oldImg.getAttribute('src') || '';
      const alt = oldImg.getAttribute('alt') || ':emoji:';

      const newImg = document.createElement('img');
      newImg.alt = alt;
      newImg.className = 'emoji';
      newImg.style.height = '1em';
      newImg.style.width = 'auto';
      newImg.style.verticalAlign = '-0.15em';
      newImg.decoding = 'async';
      newImg.loading = 'eager';
      newImg.referrerPolicy = 'no-referrer';
      newImg.crossOrigin = 'anonymous';
      newImg.onerror = () => {
        const span = document.createElement('span');
        span.textContent = alt;
        oldImg.replaceWith(span);
      };
      newImg.src = src;
      oldImg.replaceWith(newImg);
    });
  }

  function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
})();
