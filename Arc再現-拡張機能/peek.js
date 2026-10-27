// Link preview (like Arc's Peek): Cmd+Shift+click (Ctrl+Shift+click on
// Windows/Linux) a link to view the page in a floating panel without leaving.
(() => {
  if (window.__arcPeekInstalled) return;
  window.__arcPeekInstalled = true;

  const ACCENT = "#5b4cff";
  const FRAME_NAME = "arcpeek-frame";
  let current = null; // { host, close, frame }

  // Inside the preview itself: forward Esc and peek-clicks to the page that
  // owns the preview. Other iframes on normal pages are left alone.
  const inPreview = window !== window.top && window.parent === window.top && window.name === FRAME_NAME;
  if (window !== window.top && !inPreview) return;

  function isPeekClick(e) {
    // Cmd+Shift on Mac, Ctrl+Shift elsewhere. No OS detection: it is easy to get
    // wrong (Chrome reports "macOS", not "Mac"), and accepting either is harmless.
    return e.button === 0 && e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey);
  }

  function linkFromEvent(e) {
    for (const node of e.composedPath()) {
      if (node instanceof Element && node.matches("a[href], area[href]")) return node;
    }
    return null;
  }

  // Capture phase so the page's own handlers and Chrome's default
  // "open in new tab/window" never see the click.
  function onClick(e) {
    if (!isPeekClick(e)) return;
    const a = linkFromEvent(e);
    if (!a) return;
    let url;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (inPreview) window.parent.postMessage({ arcpeek: "open", url: url.href }, "*");
    else openPeek(url.href);
  }
  window.addEventListener("click", onClick, true);
  // Swallow the matching mousedown/mouseup/auxclick so pages don't react to them.
  for (const type of ["mousedown", "mouseup", "auxclick"]) {
    window.addEventListener(
      type,
      (e) => {
        if (isPeekClick(e) && linkFromEvent(e)) e.stopImmediatePropagation();
      },
      true
    );
  }

  if (inPreview) {
    window.parent.postMessage({ arcpeek: "url", url: location.href }, "*");
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !e.defaultPrevented) window.parent.postMessage({ arcpeek: "close" }, "*");
      },
      true
    );
    return;
  }

  // Messages from the previewed page (only accepted from our own iframe).
  window.addEventListener("message", (e) => {
    if (!current?.frame || e.source !== current.frame.contentWindow) return;
    const d = e.data;
    if (d?.arcpeek === "close") current.close();
    else if (typeof d?.url !== "string" || !/^https?:/.test(d.url)) return;
    else if (d.arcpeek === "open") openPeek(d.url);
    else if (d.arcpeek === "url") current.setUrl(d.url);
  });

  async function openPeek(url) {
    if (current) current.close();

    const host = document.createElement("arcpeek-root");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bg {
          position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
          display: flex; align-items: center; justify-content: center;
          animation: fade .15s ease-out;
        }
        @keyframes fade { from { opacity: 0; } }
        @keyframes pop { from { transform: scale(.96); opacity: 0; } }
        .panel {
          width: min(1200px, 92vw); height: 88vh; display: flex; flex-direction: column;
          background: #fff; border-radius: 12px; overflow: hidden;
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
          animation: pop .18s ease-out;
        }
        .bar {
          display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px;
          background: #f4f4f6; border-bottom: 1px solid #e3e3e8;
          font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
          color: #333;
        }
        .url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #666; }
        .url b { color: #222; font-weight: 600; }
        button {
          font: inherit; border: 0; border-radius: 7px; padding: 6px 10px; cursor: pointer;
          background: #e6e6ec; color: #222; white-space: nowrap;
        }
        button:hover { background: #d9d9e2; }
        button.primary { background: ${ACCENT}; color: #fff; }
        button.primary:hover { background: #6f62ff; }
        button.x { background: transparent; font-size: 14px; padding: 4px 8px; color: #555; }
        button.x:hover { background: #e2e2e8; }
        .body { position: relative; flex: 1; background: #fff; }
        iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
        .msg {
          position: absolute; inset: 0; display: flex; flex-direction: column; gap: 12px;
          align-items: center; justify-content: center; text-align: center; padding: 24px;
          font: 500 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif; color: #555;
          background: #fff;
        }
        .spinner {
          width: 28px; height: 28px; border-radius: 50%;
          border: 3px solid #e3e3e8; border-top-color: ${ACCENT}; animation: spin .8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        [hidden] { display: none !important; }
      </style>
      <div class="bg">
        <div class="panel" role="dialog" aria-label="リンクのプレビュー">
          <div class="bar">
            <div class="url"></div>
            <button class="copy" title="URLをコピー">URLをコピー</button>
            <button class="primary open" title="新しいタブで開く">新しいタブで開く</button>
            <button class="x" title="閉じる (Esc)">✕</button>
          </div>
          <div class="body">
            <div class="msg loading"><div class="spinner"></div></div>
            <div class="msg blocked" hidden>
              <div>このページはプレビューで表示できません。</div>
              <button class="primary open">新しいタブで開く</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const urlEl = shadow.querySelector(".url");
    let currentUrl = url; // follows navigation inside the preview
    const setUrl = (next) => {
      currentUrl = next;
      const u = new URL(next);
      const rest = u.pathname + u.search + u.hash;
      const b = document.createElement("b");
      b.textContent = u.host;
      urlEl.replaceChildren(b, document.createTextNode(rest === "/" ? "" : rest));
      urlEl.title = next;
    };
    setUrl(url);

    const body = shadow.querySelector(".body");
    const loading = shadow.querySelector(".loading");
    const blocked = shadow.querySelector(".blocked");

    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden"; // stop the page behind from scrolling

    const close = () => {
      if (current?.host !== host) return;
      current = null;
      host.remove();
      document.documentElement.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey, true);
      chrome.runtime.sendMessage({ type: "arcpeek:close" }).catch(() => {});
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    current = { host, close, setUrl };

    shadow.querySelector(".bg").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) close();
    });
    shadow.querySelector(".x").addEventListener("click", close);
    for (const btn of shadow.querySelectorAll(".open")) {
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "arcpeek:openTab", url: currentUrl }).catch(() => window.open(currentUrl, "_blank"));
        close();
      });
    }
    shadow.querySelector(".copy").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(currentUrl);
        btn.textContent = "コピーしました";
      } catch {
        btn.textContent = "コピー失敗";
      }
      setTimeout(() => (btn.textContent = "URLをコピー"), 1500);
    });
    window.addEventListener("keydown", onKey, true);
    (document.body || document.documentElement).appendChild(host);

    const showBlocked = () => {
      loading.hidden = true;
      blocked.hidden = false;
    };

    // An http page cannot be shown inside an https page (mixed content).
    if (location.protocol === "https:" && url.startsWith("http:")) {
      showBlocked();
      return;
    }

    // Ask the background to allow this page to be framed (many sites forbid it).
    try {
      await chrome.runtime.sendMessage({ type: "arcpeek:open" });
    } catch {
      // Extension was reloaded: the page needs a refresh. Try anyway.
    }
    if (current?.host !== host) return; // closed while waiting

    const iframe = document.createElement("iframe");
    iframe.name = FRAME_NAME;
    current.frame = iframe;
    // No "allow-top-navigation": the previewed page must not be able to
    // navigate this tab away (some sites try to "break out" of frames).
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
    );
    iframe.setAttribute("allow", "fullscreen; clipboard-write");
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    let loaded = false;
    iframe.addEventListener("load", () => {
      loaded = true;
      loading.hidden = true;
    });
    // If nothing has loaded for a long time, offer to open it in a tab instead.
    setTimeout(() => {
      if (!loaded && current?.host === host) showBlocked();
    }, 15000);
    iframe.src = url;
    body.prepend(iframe);
    iframe.focus();
  }
})();
