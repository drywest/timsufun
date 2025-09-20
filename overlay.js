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

  function isBot(name) {
    const n = String(name || '').toLowerCase().replace(/\s+/g, '');
    return n === 'nightbot' || n === 'streamlabs' || n === 'streamelements';
  }

  // --- WebSocket + frame-batched pushes (animation only; no extra delay) ---
  const inbox = [];
  let rafPending = false;
  function scheduleFlush() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const batch = inbox.splice(0, inbox.length);
      if (batch.length) pushBatch(batch);
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
          inbox.push({ type: 'system', author: 'System', html: escapeHtml(String(msg.text)) });
          scheduleFlush();
        } else if (msg.type === 'single') {
          inbox.push(msg.message); scheduleFlush();
        } else if (msg.type === 'batch') {
          for (const m of msg.messages) inbox.push(m);
          scheduleFlush();
        }
      } catch {}
    };
  }
  connect();

  function pushBatch(items) {
    const fragment = document.createDocumentFragment();
    const newLines = [];
    for (const payload of items) {
      const { author, html, isMod, isOwner, isMember, member_badges, type } = payload || {};
      if (type !== 'system' && isBot(author)) continue;
      const line = buildLine(
        type === 'system' ? 'System' : (author || 'User'),
        type === 'system' ? html || '' : (html || ''),
        !!(payload && payload.isMod),
        !!(payload && payload.isOwner),
        !!(payload && payload.isMember),
        Array.isArray(member_badges) ? member_badges : []
      );
      // start hidden; we fade after push calc
      line.style.opacity = '0';
      line.style.transform = 'translateY(8px)';
      fragment.appendChild(line);
      newLines.push(line);
    }
    if (!newLines.length) return;

    stack.appendChild(fragment);

    // j-chat style push-up (no timing changes to fetching/speed)
    const cs = getComputedStyle(stack);
    const gap = parseFloat(cs.rowGap || cs.gap || '0') || 0;
    let pushBy = 0;
    newLines.forEach(el => { pushBy += el.offsetHeight + gap; });

    stack.style.transition = 'none';
    stack.style.transform = `translateY(${pushBy}px)`;
    stack.getBoundingClientRect();           // invert
    stack.style.transition = '';              // uses --push-ms
    stack.style.transform = 'translateY(0)';  // play

    requestAnimationFrame(() => {
      newLines.forEach(el => el.classList.add('enter'));
      setTimeout(() => {
        newLines.forEach(el => { el.style.opacity = ''; el.style.transform = ''; });
      }, 200);
    });

    const maxKeep = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--max-keep')) || 600;
    while (stack.children.length > maxKeep) stack.removeChild(stack.firstChild);
  }

  function buildLine(author, html, isMod, isOwner, isMember, memberBadges) {
    const line = document.createElement('div');
    line.className = 'line';

    const a = document.createElement('span');
    a.className = 'author';
    a.style.color = nameColor(author || 'User');

    // Badges BEFORE username: owner → mod → membership (primary)
    if (isOwner) a.appendChild(makeBadgeImg(OWNER_IMG, 'owner'));
    if (isMod)   a.appendChild(makeBadgeImg(MOD_IMG,   'mod'));
    if (isMember && memberBadges && memberBadges.length) {
      a.appendChild(makeBadgeImg(memberBadges[0], 'member'));
    }

    a.appendChild(document.createTextNode(`${(author || 'User').toUpperCase()}:`));

    const m = document.createElement('span');
    m.className = 'message';
    m.innerHTML = ` ${html}`;

    normalizeEmojiImages(m);  // YouTube emoji <img>
    normalizeUnicodeEmoji(m); // Native emoji → wrap + scale

    line.appendChild(a);
    line.appendChild(m);
    return line;
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

  // Wrap native Unicode emoji so they visually match text height
  function normalizeUnicodeEmoji(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    nodes.forEach(node => {
      const text = node.nodeValue;
      if (!text) return;

      const quick = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|\uFE0F|\u200D/;
      if (!quick.test(text)) return;

      let emojiSeq;
      try {
        emojiSeq = new RegExp(
          '\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?)*',
          'gu'
        );
      } catch {
        emojiSeq = /(?:[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF])(?:\uFE0F)?(?:\u200D(?:[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF])(?:\uFE0F)?)*/g;
      }

      const frag = document.createDocumentFragment();
      let last = 0;
      text.replace(emojiSeq, (m, offset) => {
        if (offset > last) frag.appendChild(document.createTextNode(text.slice(last, offset)));
        const span = document.createElement('span');
        span.className = 'emoji emoji-char';
        span.textContent = m;
        frag.appendChild(span);
        last = offset + m.length;
        return m;
      });
      if (last === 0) return;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
})();
