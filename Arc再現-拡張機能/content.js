// Injected into the page when the toolbar button / shortcut is pressed.
// Hover = highlight the element under the cursor, click = capture it.
// Drag = capture a rectangle. Esc = cancel.
(() => {
  // Pressing the button again while active cancels.
  if (window.__arcShot) {
    window.__arcShot.cancel();
    return;
  }

  const MIN_ELEMENT_SIZE = 12; // ignore tiny elements (icons in text, etc.)
  const DRAG_THRESHOLD = 5; // px before a mousedown counts as a drag
  const MAX_CANVAS_HEIGHT = 16000; // CSS px limit for tall element captures
  const ACCENT = "#5b4cff";

  // ---------- UI (inside a shadow root so page CSS cannot interfere) ----------
  const host = document.createElement("arcshot-root");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; }
      .box {
        position: fixed; box-sizing: border-box; pointer-events: none; display: none;
        border: 2px solid ${ACCENT}; border-radius: 4px;
        background: rgba(91, 76, 255, 0.10);
        transition: left .06s ease-out, top .06s ease-out, width .06s ease-out, height .06s ease-out;
      }
      .box.drag {
        background: transparent; border-style: solid; border-radius: 0; transition: none;
        box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.35);
      }
      .label {
        position: fixed; display: none; pointer-events: none;
        font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
        color: #fff; background: ${ACCENT}; padding: 4px 6px; border-radius: 4px; white-space: nowrap;
      }
      .hint {
        position: fixed; left: 50%; top: 16px; transform: translateX(-50%); pointer-events: none;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
        color: #fff; background: rgba(20, 20, 24, 0.85); padding: 8px 14px; border-radius: 999px;
        box-shadow: 0 4px 16px rgba(0,0,0,.25); white-space: nowrap;
        transition: opacity .4s ease;
      }
      .hint.fade { opacity: 0; }
      kbd {
        font: inherit; background: rgba(255,255,255,.18); border-radius: 4px; padding: 0 5px; margin: 0 2px;
      }
    </style>
    <div class="layer"></div>
    <div class="box"></div>
    <div class="label"></div>
    <div class="hint">クリックで要素を撮影 ・ ドラッグで範囲指定 ・ <kbd>↑</kbd><kbd>↓</kbd> 親/子要素 ・ <kbd>Esc</kbd> キャンセル</div>
  `;
  const layer = shadow.querySelector(".layer");
  const box = shadow.querySelector(".box");
  const label = shadow.querySelector(".label");
  (document.body || document.documentElement).appendChild(host);
  setTimeout(() => shadow.querySelector(".hint").classList.add("fade"), 3500);

  // ---------- state ----------
  let mouse = { x: -1, y: -1 };
  let target = null; // element currently highlighted
  let childStack = []; // for ↓ after ↑
  let dragStart = null;
  let dragging = false;
  let busy = false;

  // ---------- element detection ----------
  function elementAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (let el of els) {
      if (el === host || host.contains(el)) continue;
      // Walk up past tiny inline bits so we land on a meaningful block.
      while (el && el !== document.documentElement) {
        const r = el.getBoundingClientRect();
        if (r.width >= MIN_ELEMENT_SIZE && r.height >= MIN_ELEMENT_SIZE) break;
        el = el.parentElement;
      }
      return el || document.documentElement;
    }
    return null;
  }

  function visibleRect(r) {
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right);
    const bottom = Math.min(window.innerHeight, r.bottom);
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function showBox(r, text) {
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    label.textContent = text;
    label.style.display = "block";
    const ly = r.top > 24 ? r.top - 22 : Math.min(r.top + r.height + 4, window.innerHeight - 22);
    label.style.left = Math.max(4, Math.min(r.left, window.innerWidth - label.offsetWidth - 4)) + "px";
    label.style.top = Math.max(4, ly) + "px";
  }

  function describe(el) {
    let name = el.tagName.toLowerCase();
    if (el.id) name += "#" + el.id;
    else if (typeof el.className === "string" && el.className.trim()) {
      name += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    if (name.length > 40) name = name.slice(0, 39) + "…";
    return name;
  }

  function highlight(el) {
    target = el;
    if (!el) {
      box.style.display = "none";
      label.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    showBox(visibleRect(r), `${describe(el)}  ${Math.round(r.width)} × ${Math.round(r.height)}`);
  }

  function updateHover() {
    if (dragging || busy || mouse.x < 0) return;
    const el = elementAt(mouse.x, mouse.y);
    if (el !== target) {
      childStack = [];
      highlight(el);
    } else if (el) {
      highlight(el); // position may have changed (scroll / layout)
    }
  }

  // ---------- events ----------
  function onMouseMove(e) {
    mouse = { x: e.clientX, y: e.clientY };
    if (busy) return;
    if (dragStart) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        dragging = true;
        box.classList.add("drag");
      }
      if (dragging) {
        const r = dragRect(e);
        showBox(r, `${Math.round(r.width)} × ${Math.round(r.height)}`);
      }
      return;
    }
    updateHover();
  }

  function dragRect(e) {
    const x1 = Math.max(0, Math.min(dragStart.x, e.clientX));
    const y1 = Math.max(0, Math.min(dragStart.y, e.clientY));
    const x2 = Math.min(window.innerWidth, Math.max(dragStart.x, e.clientX));
    const y2 = Math.min(window.innerHeight, Math.max(dragStart.y, e.clientY));
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
  }

  function onMouseDown(e) {
    if (busy || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart = { x: e.clientX, y: e.clientY };
    dragging = false;
  }

  function onMouseUp(e) {
    if (busy || e.button !== 0 || !dragStart) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragging) {
      const r = dragRect(e);
      dragStart = null;
      dragging = false;
      box.classList.remove("drag");
      if (r.width < 3 || r.height < 3) return;
      captureRegion(r);
    } else {
      dragStart = null;
      const el = target || elementAt(e.clientX, e.clientY);
      if (el) captureElement(el);
    }
  }

  function onKeyDown(e) {
    if (busy) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "ArrowUp" && target) {
      e.preventDefault();
      e.stopPropagation();
      const parent = target.parentElement;
      if (parent) {
        childStack.push(target);
        highlight(parent);
      }
    } else if (e.key === "ArrowDown" && target) {
      e.preventDefault();
      e.stopPropagation();
      if (childStack.length) highlight(childStack.pop());
    } else if (e.key === "Enter" && target) {
      e.preventDefault();
      e.stopPropagation();
      captureElement(target);
    }
  }

  const onScroll = () => updateHover();
  const blockEvent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  layer.addEventListener("mousemove", onMouseMove);
  layer.addEventListener("mousedown", onMouseDown);
  layer.addEventListener("click", blockEvent);
  layer.addEventListener("contextmenu", (e) => {
    blockEvent(e);
    cancel();
  });
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  function teardownPicker() {
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    host.remove();
  }

  function cancel() {
    teardownPicker();
    delete window.__arcShot;
  }

  window.__arcShot = { cancel };

  // ---------- capture helpers ----------
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function settle(ms = 80) {
    await nextFrame();
    await nextFrame();
    await sleep(ms);
  }

  async function captureViewport() {
    const res = await chrome.runtime.sendMessage({ type: "arcshot:capture" });
    if (!res?.ok) throw new Error(res?.error || "capture failed");
    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    return img;
  }

  // Hide the overlay so it is not in the screenshot.
  async function hideOverlay() {
    busy = true;
    host.style.display = "none";
    await settle();
  }

  async function captureRegion(r) {
    await hideOverlay();
    try {
      const img = await captureViewport();
      const s = img.naturalWidth / window.innerWidth;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(r.width * s);
      canvas.height = Math.round(r.height * s);
      canvas.getContext("2d").drawImage(
        img,
        Math.round(r.left * s), Math.round(r.top * s), canvas.width, canvas.height,
        0, 0, canvas.width, canvas.height
      );
      await finish(canvas);
    } catch (err) {
      fail(err);
    }
  }

  async function captureElement(el) {
    await hideOverlay();
    const startX = window.scrollX;
    const startY = window.scrollY;
    const restored = [];
    try {
      // Fixed / sticky headers etc. would cover the element: hide them while capturing.
      hideFloatingElements(el, restored);
      await settle();
      let r = el.getBoundingClientRect();
      const fitsViewport = r.width <= window.innerWidth && r.height <= window.innerHeight;
      const fullyVisible = r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;

      if (fitsViewport) {
        if (!fullyVisible) {
          el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
          await settle(150);
        }
        r = visibleRect(el.getBoundingClientRect());
        const img = await captureViewport();
        const s = img.naturalWidth / window.innerWidth;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(r.width * s);
        canvas.height = Math.round(r.height * s);
        canvas.getContext("2d").drawImage(
          img,
          Math.round(r.left * s), Math.round(r.top * s), canvas.width, canvas.height,
          0, 0, canvas.width, canvas.height
        );
        await finish(canvas);
      } else {
        await captureTallElement(el);
      }
    } catch (err) {
      fail(err);
    } finally {
      for (const [node, value, priority] of restored) node.style.setProperty("visibility", value, priority);
      window.scrollTo({ left: startX, top: startY, behavior: "instant" });
    }
  }

  // Element taller than the window: scroll through it and stitch the pieces.
  async function captureTallElement(el) {
    el.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
    await settle(150);

    let r = el.getBoundingClientRect();
    const totalH = Math.min(r.height, MAX_CANVAS_HEIGHT);
    const vis0 = visibleRect(r);
    const colLeft = vis0.left; // horizontal slice we keep (viewport-clamped)
    const colWidth = vis0.width;
    let canvas = null;
    let ctx = null;
    let s = 1;
    let covered = 0;

    while (covered < totalH - 0.5) {
      r = el.getBoundingClientRect();
      const top = Math.max(0, r.top);
      const bottom = Math.min(window.innerHeight, r.bottom, r.top + totalH);
      const img = await captureViewport();
      if (!canvas) {
        s = img.naturalWidth / window.innerWidth;
        canvas = document.createElement("canvas");
        canvas.width = Math.round(colWidth * s);
        canvas.height = Math.round(totalH * s);
        ctx = canvas.getContext("2d");
      }
      // Part of the element that is on screen, in element coordinates.
      const from = Math.max(top - r.top, covered);
      const to = bottom - r.top;
      if (to > from) {
        const sy = (r.top + from) * s;
        const h = (to - from) * s;
        ctx.drawImage(img, colLeft * s, sy, colWidth * s, h, 0, from * s, colWidth * s, h);
        covered = to;
      }

      if (covered >= totalH - 0.5) break;

      const before = window.scrollY;
      window.scrollTo({ left: window.scrollX, top: before + (r.top + covered), behavior: "instant" });
      await settle(120);
      if (Math.abs(window.scrollY - before) < 1) break; // cannot scroll further
    }

    if (covered < totalH - 0.5) {
      // Could not reach the bottom (e.g. element inside its own scroll box): trim.
      const trimmed = document.createElement("canvas");
      trimmed.width = canvas.width;
      trimmed.height = Math.max(1, Math.round(covered * s));
      trimmed.getContext("2d").drawImage(canvas, 0, 0);
      canvas = trimmed;
    }
    await finish(canvas);
  }

  function hideFloatingElements(target, restored) {
    for (const node of document.querySelectorAll("body *")) {
      if (node === host || node.contains(target) || target.contains(node)) continue;
      const pos = getComputedStyle(node).position;
      if (pos === "fixed" || pos === "sticky") {
        restored.push([node, node.style.getPropertyValue("visibility"), node.style.getPropertyPriority("visibility")]);
        node.style.setProperty("visibility", "hidden", "important");
      }
    }
  }

  // ---------- result ----------
  async function finish(canvas) {
    teardownPicker();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const dataUrl = canvas.toDataURL("image/png");
    let copied = false;
    try {
      window.focus();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      copied = true;
    } catch (err) {
      console.warn("ArcShot: clipboard write failed", err);
    }
    showToast(dataUrl, copied);
    delete window.__arcShot;
  }

  function fail(err) {
    console.error("ArcShot:", err);
    teardownPicker();
    delete window.__arcShot;
    showToast(null, false, "スクリーンショットに失敗しました");
  }

  function showToast(dataUrl, copied, errorText) {
    const t = document.createElement("arcshot-toast");
    t.style.cssText = "all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;";
    const sh = t.attachShadow({ mode: "closed" });
    sh.innerHTML = `
      <style>
        .card {
          display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 10px;
          background: rgba(24, 24, 28, 0.94); color: #fff; border-radius: 12px;
          box-shadow: 0 10px 30px rgba(0,0,0,.3);
          font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
          animation: in .18s ease-out;
        }
        @keyframes in { from { transform: translateY(10px); opacity: 0; } }
        img {
          width: 64px; height: 48px; object-fit: cover; border-radius: 6px; background: #333;
          cursor: zoom-in; display: block;
        }
        .text { display: flex; flex-direction: column; gap: 2px; }
        .sub { color: #aaa; font-size: 11px; }
        button {
          font: inherit; color: #fff; background: rgba(255,255,255,.12); border: 0; border-radius: 8px;
          padding: 6px 10px; cursor: pointer;
        }
        button:hover { background: rgba(255,255,255,.22); }
        button.primary { background: ${ACCENT}; }
        button.primary:hover { background: #6f62ff; }
        .x { background: transparent; padding: 6px; color: #aaa; }
      </style>
      <div class="card">
        ${dataUrl ? `<img alt="">` : ""}
        <div class="text">
          <div class="title"></div>
          <div class="sub"></div>
        </div>
        ${dataUrl ? `<button class="copy"${copied ? " hidden" : ""}>コピー</button><button class="primary save">保存</button>` : ""}
        <button class="x" title="閉じる">✕</button>
      </div>
    `;
    const title = sh.querySelector(".title");
    const sub = sh.querySelector(".sub");
    if (errorText) {
      title.textContent = errorText;
      sub.textContent = "ページを再読み込みして再度お試しください";
    } else {
      title.textContent = copied ? "クリップボードにコピーしました" : "スクリーンショットを撮りました";
      sub.textContent = copied ? "⌘V / Ctrl+V で貼り付けできます" : "「コピー」または「保存」を選んでください";
    }

    let timer = null;
    const close = () => t.remove();
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(close, 6000);
    };
    sh.querySelector(".x").addEventListener("click", close);
    t.addEventListener("mouseenter", () => clearTimeout(timer));
    t.addEventListener("mouseleave", arm);

    if (dataUrl) {
      const img = sh.querySelector("img");
      img.src = dataUrl;
      img.title = "クリックで拡大表示";
      img.addEventListener("click", () => openPreview(dataUrl));
      sh.querySelector(".save").addEventListener("click", async () => {
        const res = await chrome.runtime.sendMessage({ type: "arcshot:download", dataUrl });
        title.textContent = res?.ok ? "保存しました" : "保存に失敗しました";
        sub.textContent = res?.ok ? "ダウンロードフォルダを確認してください" : res?.error || "";
      });
      sh.querySelector(".copy").addEventListener("click", async (e) => {
        try {
          const blob = await (await fetch(dataUrl)).blob();
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          title.textContent = "クリップボードにコピーしました";
          sub.textContent = "⌘V / Ctrl+V で貼り付けできます";
          e.currentTarget.hidden = true;
        } catch {
          sub.textContent = "コピーできませんでした。「保存」をお使いください";
        }
      });
    }

    (document.body || document.documentElement).appendChild(t);
    arm();
  }

  function openPreview(dataUrl) {
    const p = document.createElement("arcshot-preview");
    p.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const sh = p.attachShadow({ mode: "closed" });
    sh.innerHTML = `
      <style>
        .bg { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: flex;
              align-items: center; justify-content: center; cursor: zoom-out; }
        img { max-width: 92vw; max-height: 92vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.5);
              background: repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
      </style>
      <div class="bg"><img alt=""></div>
    `;
    sh.querySelector("img").src = dataUrl;
    const close = () => {
      p.remove();
      window.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    sh.querySelector(".bg").addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    (document.body || document.documentElement).appendChild(p);
  }

  // Initial highlight is drawn on the first mouse move.
})();
