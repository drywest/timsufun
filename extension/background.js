chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'MERGEDCHAT_SEND') {
    const { text, sendAll } = msg.payload;
    // find all tabs for twitch and youtube
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        try {
          if (tab.url && tab.url.includes('twitch.tv')) {
            // inject script to send to twitch chat on that tab
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: sendToTwitch,
              args: [text]
            });
          }
          if (tab.url && (tab.url.includes('youtube.com') || tab.url.includes('youtube-nocookie.com'))) {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: sendToYouTube,
              args: [text]
            });
          }
        } catch (e) { console.error(e); }
      }
    });
  }
  return true;
});

// the following functions run in the target tab context (they will be stringified & injected)
// Twitch: try to find the chat textarea and dispatch a keyboard event on the send button.
function sendToTwitch(message) {
  try {
    // Twitch has different DOM depending on if it's the new embed or web chat.
    // Try common selectors:
    const selectors = [
      'textarea[data-a-target="chat-input"]', // new chat
      'textarea.chat-input' // fallback
    ];
    let input = null;
    for (const s of selectors) { input = document.querySelector(s); if (input) break; }
    if (!input) {
      // sometimes input is in an iframe; try to find iframe and focus it (best-effort)
      console.warn('Twitch chat input not found');
      return false;
    }
    // set value via native events
    input.focus();
    input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // find send button near input
    const btn = document.querySelector('button[data-a-target="chat-send-button"]') || document.querySelector('button.chat-send-button');
    if (btn) { btn.click(); return true; }
    // fallback: simulate Enter key
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    input.dispatchEvent(ev);
    return true;
  } catch (e) { console.error(e); return false; }
}

function sendToYouTube(message) {
  try {
    // YouTube live chat input selectors:
    // For classic live chat: #input or #input.yt-live-chat-text-input-field
    // There are multiple embed variants; try a few selectors
    const iframe = document.querySelector('iframe#chatframe') || document.querySelector('iframe[src*="live_chat"]');
    if (iframe && iframe.contentWindow) {
      // if chat is in an iframe, attempt to postMessage to it (best-effort)
      try {
        iframe.contentWindow.postMessage({ type: 'MERGEDCHAT_INJECT', text: message }, '*');
        return true;
      } catch(err){}
    }
    let input = document.querySelector('#input') || document.querySelector('yt-live-chat-text-input-field-renderer textarea') || document.querySelector('textarea#input.yt-live-chat-text-input-field-renderer') || document.querySelector('textarea');
    if (!input) {
      console.warn('YouTube chat input not found');
      return false;
    }
    input.focus();
    // For many modern YT chats, there is a shadow DOM; set value via setRangeText or via event
    input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // find send button
    const buttons = Array.from(document.querySelectorAll('yt-live-chat-message-input-renderer button, #submit-button, button#send-button')).filter(b=>b.offsetParent !== null);
    if (buttons.length) { buttons[0].click(); return true; }
    // fallback: send Enter key
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    input.dispatchEvent(ev);
    return true;
  } catch (e) { console.error(e); return false; }
}
