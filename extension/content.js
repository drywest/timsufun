// content script runs on YouTube and Twitch pages.
// It listens for window messages (for iframe-based YT chats) and tries to forward them to chat input inside the iframe if necessary.
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'MERGEDCHAT_INJECT') {
    const message = ev.data.text;
    // attempt to find input and send programmatically (same logic as above)
    try {
      let input = document.querySelector('#input') || document.querySelector('yt-live-chat-text-input-field-renderer textarea') || document.querySelector('textarea#input') || document.querySelector('textarea');
      if (!input) return;
      input.focus();
      input.value = message;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const buttons = Array.from(document.querySelectorAll('yt-live-chat-message-input-renderer button, #submit-button, button#send-button')).filter(b=>b.offsetParent !== null);
      if (buttons.length) { buttons[0].click(); return; }
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch(e){}
  }
}, false);
