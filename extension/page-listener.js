// Runs on any page (we included localhost and any, so the merged chat page can use it)
// This file relays the postMessage from the page to the background script via chrome.runtime
window.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.type !== 'MERGEDCHAT_SEND') return;
  // send to extension to dispatch
  try {
    chrome.runtime.sendMessage({ type: 'MERGEDCHAT_SEND', payload: ev.data.payload });
  } catch(err) {
    console.warn('Could not send message to extension runtime', err);
  }
});
