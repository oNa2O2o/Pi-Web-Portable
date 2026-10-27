/* Pi Web 悬浮剪贴板 —— 独立脚本，通过 index.html 注入，不依赖页面打包代码。
 * 功能：选中文字记录 / 拖拽文字到气泡记录 / 查看、搜索、编辑、置顶、删除 /
 *       一键复制、插入到输入框、把条目拖出到任意输入框。数据存 localStorage，多标签页同步。
 */
(function () {
  "use strict";
  if (window.__piClipboardLoaded) return;
  window.__piClipboardLoaded = true;

  var STORE_KEY = "pi-web-clipboard:v1";
  var POS_KEY = "pi-web-clipboard:pos";
  var MAX_ITEMS = 300;
  var MAX_TEXT = 200000;

  // ---------- 数据 ----------
  function loadItems() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (raw && Array.isArray(raw.items)) return raw.items.filter(function (i) { return i && typeof i.text === "string"; });
    } catch (e) {}
    return [];
  }
  var items = loadItems();
  function saveItems() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ items: items })); }
    catch (e) { toast("保存失败：浏览器存储空间不足"); }
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function sortedItems() {
    return items.slice().sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updated || b.created) - (a.updated || a.created);
    });
  }
  function addItem(text) {
    if (typeof text !== "string") return false;
    text = text.replace(/\r\n/g, "\n");
    if (!text.trim()) return false;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    var now = Date.now();
    var dup = items.find(function (i) { return i.text === text; });
    if (dup) { dup.updated = now; }
    else {
      items.push({ id: uid(), text: text, created: now, updated: now, pinned: false });
      // 超出上限时优先淘汰最旧的非置顶条目
      var unpinned = items.filter(function (i) { return !i.pinned; }).sort(function (a, b) { return a.updated - b.updated; });
      while (items.length > MAX_ITEMS && unpinned.length) {
        var victim = unpinned.shift();
        items = items.filter(function (i) { return i !== victim; });
      }
    }
    saveItems();
    render();
    bump();
    toast(dup ? "已存在，已移到最前" : "已记录到剪贴板");
    return true;
  }

  // ---------- 复制 / 插入 ----------
  function copyText(text) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      ta.remove();
      return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }

  var lastEditable = null;
  function isEditable(el) {
    if (!el || el === host) return false;
    if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (el.tagName === "INPUT") return /^(text|search|url|email|)$/i.test(el.type || "") && !el.readOnly && !el.disabled;
    return !!el.isContentEditable;
  }
  document.addEventListener("focusin", function (e) {
    if (isEditable(e.target)) lastEditable = e.target;
  }, true);

  function findComposer() {
    if (lastEditable && lastEditable.isConnected) return lastEditable;
    var list = Array.prototype.filter.call(document.querySelectorAll("textarea"), function (t) {
      return t.offsetParent !== null && isEditable(t);
    });
    return list[list.length - 1] || null;
  }

  function insertText(text) {
    var el = findComposer();
    if (!el) {
      copyText(text);
      toast("没找到输入框，已复制到系统剪贴板");
      return;
    }
    el.focus();
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) {}
    if (!ok && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      var start = el.selectionStart != null ? el.selectionStart : el.value.length;
      var end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
      var next = el.value.slice(0, start) + text + el.value.slice(end);
      var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, next); // 兼容 React 受控组件
      el.dispatchEvent(new Event("input", { bubbles: true }));
      try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) {}
    }
    toast("已插入到输入框");
  }

  // ---------- 界面 ----------
  var host = document.createElement("div");
  host.id = "pi-clipboard-host";
  host.setAttribute("translate", "no");
  host.style.cssText = "position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483000;";
  var root = host.attachShadow({ mode: "open" });

  root.innerHTML = [
    "<style>",
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
    ".v{--bg:#ffffff;--bg2:#f5f6f8;--fg:#1f2328;--fg2:#6b7280;--bd:#e3e5e8;--ac:#6d5efc;--ac2:#ece9ff;--danger:#e5484d;--shadow:0 10px 30px rgba(0,0,0,.15),0 2px 8px rgba(0,0,0,.08)}",
    ".v.dark{--bg:#1e1f23;--bg2:#2a2c31;--fg:#e8e9ec;--fg2:#9aa0aa;--bd:#383b42;--ac:#8b7fff;--ac2:#2f2b4d;--danger:#ff6b6f;--shadow:0 10px 30px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.3)}",
    ".bubble{position:fixed;width:48px;height:48px;border-radius:50%;background:var(--ac);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--shadow);user-select:none;touch-action:none;transition:transform .18s,width .18s,height .18s,opacity .2s;opacity:.88}",
    ".bubble:hover{opacity:1;transform:scale(1.06)}",
    ".bubble svg{width:22px;height:22px;pointer-events:none}",
    ".bubble .badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--danger);color:#fff;font-size:11px;line-height:18px;text-align:center;font-weight:600;pointer-events:none}",
    ".bubble.dropmode{opacity:1;transform:scale(1.35);outline:3px dashed #fff;outline-offset:-7px}",
    ".bubble.dropover{transform:scale(1.55);background:#22a06b}",
    ".bubble.bump{animation:bump .45s}",
    "@keyframes bump{30%{transform:scale(1.3)}60%{transform:scale(.92)}100%{transform:scale(1)}}",
    ".droptip{position:fixed;padding:4px 8px;border-radius:6px;background:var(--fg);color:var(--bg);font-size:12px;white-space:nowrap;pointer-events:none;display:none}",
    ".panel{position:fixed;width:360px;max-width:calc(100vw - 16px);height:min(560px,calc(100vh - 32px));background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:14px;box-shadow:var(--shadow);display:none;flex-direction:column;overflow:hidden;font-size:13px}",
    ".panel.open{display:flex}",
    ".panel.dropover{outline:2px dashed var(--ac);outline-offset:-4px}",
    ".hd{display:flex;align-items:center;gap:6px;padding:10px 10px 8px 14px;border-bottom:1px solid var(--bd)}",
    ".hd .t{font-weight:600;font-size:14px;flex:1}",
    ".ib{border:none;background:transparent;color:var(--fg2);width:28px;height:28px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:15px}",
    ".ib:hover{background:var(--bg2);color:var(--fg)}",
    ".tools{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--bd)}",
    ".search{flex:1;min-width:0;height:30px;border:1px solid var(--bd);border-radius:8px;padding:0 10px;background:var(--bg2);color:var(--fg);font-size:13px;outline:none}",
    ".search:focus{border-color:var(--ac)}",
    ".btn{height:30px;padding:0 10px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);cursor:pointer;font-size:12px;white-space:nowrap}",
    ".btn:hover{border-color:var(--ac);color:var(--ac)}",
    ".btn.pri{background:var(--ac);border-color:var(--ac);color:#fff}",
    ".btn.pri:hover{filter:brightness(1.08);color:#fff}",
    ".list{flex:1;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px}",
    ".empty{color:var(--fg2);text-align:center;padding:40px 16px;line-height:1.8}",
    ".item{border:1px solid var(--bd);border-radius:10px;background:var(--bg2);padding:8px 10px;position:relative}",
    ".item.pinned{border-color:var(--ac);background:var(--ac2)}",
    ".item[draggable=true]{cursor:grab}",
    ".txt{white-space:pre-wrap;word-break:break-word;line-height:1.55;max-height:7.75em;overflow:hidden;cursor:text;user-select:text}",
    ".item.expanded .txt{max-height:none}",
    ".more{color:var(--ac);font-size:12px;cursor:pointer;margin-top:2px;display:inline-block}",
    ".meta{display:flex;align-items:center;gap:2px;margin-top:6px;color:var(--fg2);font-size:11px}",
    ".meta .sp{flex:1}",
    ".meta .ib{width:26px;height:24px;font-size:12px}",
    ".meta .ib.on{color:var(--ac)}",
    ".meta .ib.del:hover{color:var(--danger)}",
    ".act{height:24px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:var(--fg2);cursor:pointer;font-size:12px}",
    ".act:hover{background:var(--bg);color:var(--ac)}",
    ".ed{width:100%;min-height:90px;max-height:50vh;resize:vertical;border:1px solid var(--ac);border-radius:8px;padding:8px;background:var(--bg);color:var(--fg);font-size:13px;line-height:1.55;outline:none}",
    ".edbar{display:flex;justify-content:flex-end;gap:6px;margin-top:6px;align-items:center}",
    ".edbar .hint{flex:1;color:var(--fg2);font-size:11px}",
    ".ft{padding:6px 12px;border-top:1px solid var(--bd);color:var(--fg2);font-size:11px;line-height:1.5}",
    ".selbtn{position:fixed;display:none;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:8px;background:var(--fg);color:var(--bg);font-size:12px;cursor:pointer;box-shadow:var(--shadow);user-select:none;white-space:nowrap}",
    ".selbtn:hover{background:var(--ac);color:#fff}",
    ".toast{position:fixed;padding:7px 12px;border-radius:8px;background:var(--fg);color:var(--bg);font-size:12px;pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap}",
    ".toast.show{opacity:.95}",
    "mark{background:#ffd54a;color:#000;border-radius:2px}",
    "@media (max-width:600px){.panel{left:8px!important;right:8px!important;width:auto;top:auto!important;bottom:8px!important;height:70vh}}",
    "</style>",
    "<div class='v'>",
    "  <div class='bubble' title='剪贴板（点击打开，拖动可移动；可把选中的文字拖到这里）'>",
    "    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='8' y='2' width='8' height='4' rx='1'/><path d='M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'/><path d='M9 12h6M9 16h4'/></svg>",
    "    <span class='badge'></span>",
    "  </div>",
    "  <div class='droptip'>松开即可记录</div>",
    "  <div class='panel' role='dialog' aria-label='剪贴板'>",
    "    <div class='hd'><span class='t'>剪贴板</span>",
    "      <button class='ib' data-a='paste' title='从系统剪贴板读取并记录'>⇩</button>",
    "      <button class='ib' data-a='clear' title='清空未置顶的记录'>🗑</button>",
    "      <button class='ib' data-a='close' title='关闭 (Esc)'>✕</button>",
    "    </div>",
    "    <div class='tools'><input class='search' placeholder='搜索记录…'/><button class='btn pri' data-a='new'>＋ 新建</button></div>",
    "    <div class='list'></div>",
    "    <div class='ft'>选中文字后点「记录」、按 Alt+Shift+C，或直接把文字拖到气泡/面板。条目可拖进输入框，双击可编辑。</div>",
    "  </div>",
    "  <div class='selbtn'>📋 记录</div>",
    "  <div class='toast'></div>",
    "</div>"
  ].join("");

  var $ = function (s) { return root.querySelector(s); };
  var view = $(".v"), bubble = $(".bubble"), badge = $(".badge"), panel = $(".panel"), list = $(".list"),
      search = $(".search"), selbtn = $(".selbtn"), toastEl = $(".toast"), droptip = $(".droptip");

  // 主题跟随 Pi Web（html.dark）
  function syncTheme() { view.classList.toggle("dark", document.documentElement.classList.contains("dark")); }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

  // ---------- 气泡位置 / 拖动 ----------
  // 自由位置：用屏幕比例保存（fx/fy），窗口缩放后仍在相对位置
  var SIZE = 48, MARGIN = 6;
  var pos = { fx: null, fy: null };
  try {
    var p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (p && typeof p.fx === "number" && typeof p.fy === "number") pos = p;
    else if (p && (p.side === "left" || p.side === "right")) { // 兼容旧版贴边位置
      pos.fx = p.side === "left" ? 0 : 1;
      pos.fy = p.top != null ? p.top / Math.max(1, window.innerHeight - SIZE) : null;
    }
  } catch (e) {}
  function clampTop(t) { return Math.max(MARGIN, Math.min(window.innerHeight - SIZE - MARGIN, t)); }
  function clampLeft(l) { return Math.max(MARGIN, Math.min(window.innerWidth - SIZE - MARGIN, l)); }
  function bubbleXY() {
    var fx = pos.fx == null ? 1 : pos.fx, fy = pos.fy == null ? 0.75 : pos.fy;
    return { x: clampLeft(fx * (window.innerWidth - SIZE)), y: clampTop(fy * (window.innerHeight - SIZE)) };
  }
  function placeBubble() {
    var b = bubbleXY();
    bubble.style.left = b.x + "px";
    bubble.style.top = b.y + "px";
    if (panel.classList.contains("open")) placePanel();
  }
  function placePanel() {
    var b = bubbleXY();
    var pw = Math.min(360, window.innerWidth - 16);
    var ph = Math.min(560, window.innerHeight - 32);
    // 面板放在气泡左/右空间更大的一侧，垂直方向尽量对齐气泡
    var spaceR = window.innerWidth - (b.x + SIZE), spaceL = b.x;
    var left = spaceR >= pw + 18 || spaceR >= spaceL ? b.x + SIZE + 10 : b.x - 10 - pw;
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
    var top = b.y + SIZE / 2 > window.innerHeight / 2 ? b.y + SIZE - ph : b.y;
    top = Math.max(16, Math.min(window.innerHeight - ph - 16, top));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }
  window.addEventListener("resize", placeBubble);

  var dragState = null;
  bubble.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    var r = bubble.getBoundingClientRect();
    dragState = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    bubble.setPointerCapture(e.pointerId);
  });
  bubble.addEventListener("pointermove", function (e) {
    if (!dragState) return;
    if (!dragState.moved && Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) < 5) return;
    dragState.moved = true;
    bubble.style.transition = "none";
    bubble.style.left = clampLeft(e.clientX - dragState.dx) + "px";
    bubble.style.top = clampTop(e.clientY - dragState.dy) + "px";
  });
  bubble.addEventListener("pointerup", function (e) {
    if (!dragState) return;
    var moved = dragState.moved;
    dragState = null;
    bubble.style.transition = "";
    if (moved) {
      pos.fx = parseFloat(bubble.style.left) / Math.max(1, window.innerWidth - SIZE);
      pos.fy = parseFloat(bubble.style.top) / Math.max(1, window.innerHeight - SIZE);
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (err) {}
      placeBubble();
    } else {
      togglePanel();
    }
  });
  bubble.addEventListener("pointercancel", function () { dragState = null; bubble.style.transition = ""; placeBubble(); });

  function togglePanel(force) {
    var open = force != null ? force : !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    if (open) { placePanel(); render(); setTimeout(function () { if (window.innerWidth > 600) search.focus(); }, 0); }
  }

  // ---------- 提示 ----------
  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    var r = bubble.getBoundingClientRect();
    toastEl.style.top = Math.max(8, r.top - 38) + "px";
    toastEl.classList.add("show");
    // 先渲染再按宽度贴边
    var w = toastEl.offsetWidth;
    toastEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + SIZE / 2 - w / 2)) + "px";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1600);
  }
  function bump() {
    bubble.classList.remove("bump");
    void bubble.offsetWidth;
    bubble.classList.add("bump");
  }

  // ---------- 渲染列表 ----------
  var editingId = null;
  var expanded = {};
  function fmtTime(t) {
    var d = new Date(t), now = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return "今天 " + hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function highlight(node, text, q) {
    if (!q) { node.textContent = text; return; }
    var lower = text.toLowerCase(), ql = q.toLowerCase(), i = 0, j;
    while ((j = lower.indexOf(ql, i)) !== -1) {
      node.appendChild(document.createTextNode(text.slice(i, j)));
      node.appendChild(el("mark", null, text.slice(j, j + q.length)));
      i = j + q.length;
    }
    node.appendChild(document.createTextNode(text.slice(i)));
  }

  var internalDrag = false;
  function render() {
    badge.textContent = items.length ? (items.length > 99 ? "99+" : String(items.length)) : "";
    badge.style.display = items.length ? "" : "none";
    $(".hd .t").textContent = "剪贴板" + (items.length ? "（" + items.length + "）" : "");
    if (!panel.classList.contains("open")) return;

    var q = search.value.trim();
    var data = sortedItems().filter(function (i) { return !q || i.text.toLowerCase().indexOf(q.toLowerCase()) !== -1; });
    list.textContent = "";
    if (!data.length) {
      var em = el("div", "empty");
      em.textContent = q ? "没有匹配的记录" : "还没有记录。\n选中页面上的文字点「📋 记录」，\n或把文字直接拖到气泡上。";
      em.style.whiteSpace = "pre-line";
      list.appendChild(em);
      return;
    }
    data.forEach(function (item) {
      var card = el("div", "item" + (item.pinned ? " pinned" : "") + (expanded[item.id] ? " expanded" : ""));
      card.dataset.id = item.id;

      if (editingId === item.id) {
        var ta = el("textarea", "ed");
        ta.value = item.text;
        var bar = el("div", "edbar");
        bar.appendChild(el("span", "hint", "Ctrl+Enter 保存 · Esc 取消"));
        var cancel = el("button", "btn", "取消");
        var save = el("button", "btn pri", "保存");
        bar.appendChild(cancel); bar.appendChild(save);
        var doSave = function () {
          var v = ta.value.replace(/\r\n/g, "\n");
          if (!v.trim()) { removeItem(item.id); }
          else { item.text = v.slice(0, MAX_TEXT); item.updated = Date.now(); }
          editingId = null; saveItems(); render(); toast("已保存");
        };
        save.onclick = doSave;
        var doCancel = function () {
          editingId = null;
          if (!item.text.trim()) removeItem(item.id); else render();
        };
        cancel.onclick = doCancel;
        ta.addEventListener("keydown", function (e) {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); }
          else if (e.key === "Escape") { e.preventDefault(); doCancel(); }
        });
        card.appendChild(ta); card.appendChild(bar);
        list.appendChild(card);
        setTimeout(function () {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          ta.style.height = Math.min(ta.scrollHeight + 4, window.innerHeight * 0.5) + "px";
        }, 0);
        return;
      }

      var txt = el("div", "txt");
      highlight(txt, item.text, q);
      txt.title = "双击编辑";
      txt.ondblclick = function () { editingId = item.id; render(); };
      card.appendChild(txt);

      var lines = item.text.split("\n").length;
      if (lines > 5 || item.text.length > 220) {
        var more = el("span", "more", expanded[item.id] ? "收起" : "展开全部");
        more.onclick = function () { expanded[item.id] = !expanded[item.id]; render(); };
        card.appendChild(more);
      }

      var meta = el("div", "meta");
      meta.appendChild(el("span", null, fmtTime(item.updated || item.created) + " · " + item.text.length + " 字"));
      meta.appendChild(el("span", "sp"));
      var bCopy = el("button", "act", "复制");
      bCopy.onclick = function () {
        copyText(item.text).then(function (ok) { toast(ok ? "已复制，可直接 Ctrl+V 粘贴" : "复制失败，请手动选择文字复制"); });
      };
      var bIns = el("button", "act", "插入");
      bIns.title = "插入到聊天输入框光标处";
      bIns.onclick = function () { insertText(item.text); };
      var bEdit = el("button", "ib", "✎"); bEdit.title = "编辑";
      bEdit.onclick = function () { editingId = item.id; render(); };
      var bPin = el("button", "ib" + (item.pinned ? " on" : ""), "📌"); bPin.title = item.pinned ? "取消置顶" : "置顶";
      bPin.onclick = function () { item.pinned = !item.pinned; saveItems(); render(); };
      var bDel = el("button", "ib del", "✕"); bDel.title = "删除";
      bDel.onclick = function () { removeItem(item.id); };
      [bCopy, bIns, bEdit, bPin, bDel].forEach(function (b) { meta.appendChild(b); });
      card.appendChild(meta);

      // 条目可拖出到任意输入框
      card.draggable = true;
      card.addEventListener("dragstart", function (e) {
        if (e.target !== card) return;
        internalDrag = true;
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", item.text);
      });
      card.addEventListener("dragend", function () { internalDrag = false; });

      list.appendChild(card);
    });
  }
  function removeItem(id) {
    items = items.filter(function (i) { return i.id !== id; });
    if (editingId === id) editingId = null;
    saveItems(); render();
  }

  // 头部按钮
  root.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-a]");
    if (!b) return;
    var a = b.dataset.a;
    if (a === "close") togglePanel(false);
    else if (a === "new") {
      var item = { id: uid(), text: "", created: Date.now(), updated: Date.now(), pinned: false };
      // 新建空条目 —— 取消或保存为空时自动删除
      items.push(item);
      editingId = item.id;
      search.value = "";
      render();
    }
    else if (a === "clear") {
      var n = items.filter(function (i) { return !i.pinned; }).length;
      if (!n) { toast("没有可清空的记录"); return; }
      if (confirm("清空 " + n + " 条未置顶的记录？")) { items = items.filter(function (i) { return i.pinned; }); saveItems(); render(); }
    }
    else if (a === "paste") {
      if (!navigator.clipboard || !navigator.clipboard.readText || !window.isSecureContext) {
        toast("当前连接不支持读取剪贴板，请点「新建」后 Ctrl+V");
        return;
      }
      navigator.clipboard.readText().then(function (t) {
        if (!addItem(t)) toast("系统剪贴板里没有文字");
      }, function () { toast("浏览器拒绝读取剪贴板，请点「新建」后 Ctrl+V"); });
    }
  });
  search.addEventListener("input", render);
  search.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Escape") togglePanel(false); });
  // 面板内按键不要触发 Pi Web 的全局快捷键
  panel.addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Escape" && !editingId) togglePanel(false);
  });

  // 点面板外关闭（拖拽中、编辑中不关闭）
  document.addEventListener("pointerdown", function (e) {
    if (!panel.classList.contains("open") || editingId) return;
    if (e.composedPath().indexOf(host) !== -1) return;
    togglePanel(false);
  }, true);

  // ---------- 选中文字 → 「记录」小按钮 ----------
  var pendingSel = "";
  function getSelectedText() {
    var a = document.activeElement;
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && a !== host) {
      try {
        if (a.selectionStart != null && a.selectionEnd > a.selectionStart) return a.value.slice(a.selectionStart, a.selectionEnd);
      } catch (e) {}
    }
    var s = window.getSelection();
    return s ? s.toString() : "";
  }
  function hideSelBtn() { selbtn.style.display = "none"; pendingSel = ""; }
  function maybeShowSelBtn(evt) {
    if (evt && evt.composedPath && evt.composedPath().indexOf(host) !== -1) return;
    setTimeout(function () {
      var text = getSelectedText();
      if (!text.trim()) { hideSelBtn(); return; }
      pendingSel = text;
      var x, y;
      var s = window.getSelection();
      var a = document.activeElement;
      var inField = a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT");
      if (!inField && s && s.rangeCount) {
        var rects = s.getRangeAt(0).getClientRects();
        var r = rects.length ? rects[rects.length - 1] : s.getRangeAt(0).getBoundingClientRect();
        x = r.right; y = r.bottom;
      }
      if ((x == null || (!x && !y)) && evt && evt.clientX != null) { x = evt.clientX; y = evt.clientY; }
      if (x == null && evt && evt.changedTouches && evt.changedTouches[0]) { x = evt.changedTouches[0].clientX; y = evt.changedTouches[0].clientY; }
      if (x == null) { hideSelBtn(); return; }
      selbtn.style.display = "flex";
      var w = selbtn.offsetWidth || 70;
      var left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 6));
      var top = y + 8;
      if (top + 36 > window.innerHeight) top = y - 40;
      selbtn.style.left = left + "px";
      selbtn.style.top = Math.max(8, top) + "px";
    }, 10);
  }
  document.addEventListener("mouseup", maybeShowSelBtn, true);
  document.addEventListener("touchend", maybeShowSelBtn, true);
  document.addEventListener("keyup", function (e) { if (e.shiftKey || e.key === "Shift") maybeShowSelBtn(e); }, true);
  document.addEventListener("pointerdown", function (e) {
    if (e.composedPath().indexOf(selbtn) !== -1) return;
    hideSelBtn();
  }, true);
  window.addEventListener("scroll", hideSelBtn, true);
  // mousedown 阻止默认，避免点按钮时丢失选区
  selbtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
  selbtn.addEventListener("click", function () {
    var t = pendingSel || getSelectedText();
    hideSelBtn();
    addItem(t);
  });

  // 快捷键：Alt+Shift+C 记录选中文字；Alt+Shift+V 打开/关闭剪贴板
  document.addEventListener("keydown", function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code === "KeyC") {
      var t = getSelectedText();
      if (t.trim()) { e.preventDefault(); hideSelBtn(); addItem(t); }
    } else if (e.code === "KeyV") {
      e.preventDefault(); togglePanel();
    }
  }, true);

  // ---------- 把文字拖到气泡 / 面板 ----------
  function hasText(dt) {
    if (!dt) return false;
    var types = Array.prototype.slice.call(dt.types || []);
    return types.indexOf("text/plain") !== -1 && types.indexOf("Files") === -1;
  }
  var dragDepth = 0;
  function setDropMode(on) {
    bubble.classList.toggle("dropmode", on);
    if (on) {
      var r = bubble.getBoundingClientRect();
      droptip.textContent = "拖到这里记录";
      droptip.style.display = "block";
      droptip.style.top = (r.top - 30) + "px";
      droptip.style.left = Math.max(8, Math.min(window.innerWidth - 100, r.left - 20)) + "px";
    } else {
      droptip.style.display = "none";
      bubble.classList.remove("dropover");
      panel.classList.remove("dropover");
    }
  }
  document.addEventListener("dragstart", function (e) {
    if (internalDrag) return;
    setTimeout(function () { if (!internalDrag) setDropMode(true); }, 0);
  }, true);
  document.addEventListener("dragend", function () { dragDepth = 0; setDropMode(false); }, true);
  // 从其他窗口/应用拖入的文字
  document.addEventListener("dragenter", function (e) {
    if (!internalDrag && hasText(e.dataTransfer)) { dragDepth++; setDropMode(true); }
  }, true);
  document.addEventListener("dragleave", function (e) {
    if (!internalDrag && hasText(e.dataTransfer) && --dragDepth <= 0) { dragDepth = 0; if (!e.relatedTarget) setDropMode(false); }
  }, true);
  document.addEventListener("drop", function () { dragDepth = 0; setTimeout(function () { setDropMode(false); }, 0); }, true);

  [bubble, panel].forEach(function (target) {
    target.addEventListener("dragover", function (e) {
      if (internalDrag || !hasText(e.dataTransfer)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      target.classList.add("dropover");
      if (target === bubble) droptip.textContent = "松开即可记录";
    });
    target.addEventListener("dragleave", function (e) {
      if (target.contains(e.relatedTarget)) return;
      target.classList.remove("dropover");
      if (target === bubble) droptip.textContent = "拖到这里记录";
    });
    target.addEventListener("drop", function (e) {
      if (internalDrag) return;
      var t = e.dataTransfer && e.dataTransfer.getData("text/plain");
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      target.classList.remove("dropover");
      setDropMode(false);
      dragDepth = 0;
      addItem(t);
    });
  });

  // 多标签页同步
  window.addEventListener("storage", function (e) {
    if (e.key === STORE_KEY) { items = loadItems(); if (!editingId) render(); else badge.textContent = String(items.length); }
  });

  // ---------- 挂载（等 React 水合完成后再插入，并防止被重渲染移除） ----------
  function mount() {
    if (!host.isConnected) document.body.appendChild(host);
    placeBubble();
    render();
  }
  function start() {
    var go = function () { mount(); setInterval(function () { if (!host.isConnected) mount(); }, 2000); };
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2500 }); else setTimeout(go, 800);
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);

  window.piClipboard = { add: addItem, open: function () { togglePanel(true); }, items: function () { return sortedItems(); } };
})();
