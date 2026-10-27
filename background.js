// Service worker: starts the picker on the page, takes the actual screenshots,
// and saves files.

// Chrome allows only ~2 captureVisibleTab calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
let lastCaptureAt = 0;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    // chrome://, the Chrome Web Store, etc. do not allow scripts.
    console.warn("ArcShot: cannot run on this page", err);
    await flashBadge(tab.id);
  }
});

async function flashBadge(tabId) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
  await chrome.action.setBadgeText({ tabId, text: "×" });
  await chrome.action.setTitle({ tabId, title: "このページではスクリーンショットを撮れません" });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    chrome.action.setTitle({ tabId, title: "スクリーンショットを撮る" }).catch(() => {});
  }, 2500);
}

async function captureVisible(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "arcshot:capture") {
    captureVisible(sender.tab.windowId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // async response
  }
  if (msg?.type === "arcshot:download") {
    chrome.downloads
      .download({ url: msg.dataUrl, filename: `Screenshot ${timestamp()}.png`, saveAs: false })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});
