// model-health-ui.js — 模型连通性提醒（配合 server/model-health 后台服务）
//
// 后台服务每 10 分钟检测连通性、每 6 小时真实调用一次；模型设置页本身（Provider / 模型页面）
// 打开时也会实际调用并把结果存进同一份记录。这个脚本只负责页面上的提醒：
//   - 模型设置左栏 Provider / 模型旁显示绿/黄/红小圆点，悬停看原因
//   - 上游出现新模型时，左栏顶部提示「有 N 个新模型可添加」；点「查看」打开对应 Provider 页面并勾好这些模型
//   - Provider 变成失败时，右上角显示一行小字提醒，不会自动消失，点 × 关闭；恢复后自动消失
// 只关失败提醒：localStorage.setItem('piweb.health.alerts','off')
(() => {
  if (window.__piwebModelHealthUi) return;
  window.__piwebModelHealthUi = true;

  const HEALTH = '/__piweb-plugins/api/model-health';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

  async function api(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }
  const health = (path, body) => api(HEALTH + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const style = document.createElement('style');
  style.textContent = `
  .mh-alerts{position:fixed;top:44px;right:14px;z-index:2147481000;display:flex;flex-direction:column;align-items:flex-end;gap:4px;pointer-events:none}
  .mh-alert{pointer-events:auto;display:flex;align-items:center;gap:6px;max-width:min(460px,calc(100vw - 24px));padding:2px 4px 2px 9px;border-radius:999px;
    background:rgba(17,24,39,.82);color:#fff;font:12px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
  .mh-alert span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .mh-alert i{width:7px;height:7px;border-radius:50%;background:#ef4444;flex:none}
  .mh-alert button{border:0;background:none;color:#cbd5e1;cursor:pointer;font-size:14px;line-height:1;padding:0 4px}
  .mh-dot{width:7px;height:7px;border-radius:50%;flex:none;margin-left:4px;background:#9ca3af}
  .mh-dot.green{background:#22c55e}.mh-dot.yellow{background:#f59e0b}.mh-dot.red{background:#ef4444}
  .mh-mdot{width:5px;height:5px;border-radius:50%;flex:none;margin-left:4px}
  .mh-mdot.ok{background:#22c55e;opacity:.7}.mh-mdot.bad{background:#ef4444}
  .mh-bar{margin:6px 8px 2px;padding:6px 8px;border-radius:8px;font-size:12px;line-height:1.5;background:rgba(59,130,246,.09);border:1px solid rgba(59,130,246,.25)}
  .mh-new:empty{display:none}
  .mh-status.mh-bar{background:none;border:0;padding:0 8px;margin:4px 0 0;color:var(--text-dim,#888);font-size:11px}
  .mh-bar button{border:0;background:none;padding:0;margin-left:6px;color:var(--accent,#245bce);cursor:pointer;font:inherit;text-decoration:underline}`;
  document.head.appendChild(style);

  // Opens a provider's page in the Models panel with the given models ticked.
  function openProvider(panel, name, ids) {
    window.__piwebPreselect = { provider: name, ids };
    window.dispatchEvent(new CustomEvent('piweb:preselect-models', { detail: window.__piwebPreselect }));
    const label = ((hcfg && hcfg.providers && hcfg.providers[name] && hcfg.providers[name].name) || name).trim();
    for (const btn of panel.querySelectorAll('.config-sidebar-item:not(.models-sidebar-indented-item)')) {
      const text = (btn.querySelector('.config-sidebar-text') || {}).textContent;
      if (text && text.trim() === label) { btn.click(); break; }
    }
  }

  // ---------- health: alerts + models panel ----------
  let hstate = null;
  let hcfg = null;
  let cfgLoading = null;
  async function pollHealth() {
    try {
      hstate = await health('/status');
    } catch { hstate = null; }
    renderAlerts();
    decorate();
  }
  async function loadCfg() {
    try { hcfg = await api('/api/models-config'); } catch { /* ignore */ }
  }

  let alertsBox = null;
  function renderAlerts() {
    const list = (hstate && hstate.alerts) || [];
    if (localStorage.getItem('piweb.health.alerts') === 'off' || !list.length) { if (alertsBox) alertsBox.innerHTML = ''; return; }
    if (!alertsBox || !alertsBox.isConnected) {
      alertsBox = document.createElement('div');
      alertsBox.className = 'mh-alerts';
      document.body.appendChild(alertsBox);
      alertsBox.addEventListener('click', (e) => {
        const id = e.target.dataset && e.target.dataset.dismiss;
        if (!id) return;
        e.target.closest('.mh-alert').remove();
        health('/dismiss', { id }).then((s) => { hstate = s; }).catch(() => {});
      });
    }
    const sig = JSON.stringify(list.map((a) => [a.id, a.error]));
    if (alertsBox.dataset.sig === sig) return;
    alertsBox.dataset.sig = sig;
    alertsBox.innerHTML = list.map((a) => {
      const tip = `${a.provider} 连接失败（${new Date(a.at).toLocaleString()}）\n${a.error}${a.hint ? '\n' + a.hint : ''}\n恢复后这条提醒会自动消失`;
      return `<div class="mh-alert" title="${esc(tip)}"><i></i><span>模型「${esc(a.provider)}」连接失败：${esc(a.error)}</span><button data-dismiss="${esc(a.id)}" title="关闭">×</button></div>`;
    }).join('');
  }

  const STATUS_TEXT = { green: '正常', yellow: '部分异常', red: '连接失败', unknown: '未检测' };
  function modelsPanel() {
    // the Models panel is the only config panel with model rows (embedded settings have no subtitle)
    const row = document.querySelector('.models-sidebar-model-footer, .models-sidebar-indented-item');
    if (row) return row.closest('.config-panel-surface');
    for (const sub of document.querySelectorAll('.config-panel-subtitle')) {
      if (/models\.json/.test(sub.textContent || '')) return sub.closest('.config-panel-surface');
    }
    return null;
  }
  function setNode(parent, cls, sig, make, prepend) {
    let el = parent.querySelector(':scope > .' + cls.split(' ')[0]);
    if (el && el.dataset.sig === sig) return;
    if (!el) { el = document.createElement(cls.includes('mh-bar') ? 'div' : 'span'); if (prepend) parent.prepend(el); else parent.appendChild(el); }
    el.className = cls;
    el.dataset.sig = sig;
    make(el);
  }
  function decorate() {
    const panel = modelsPanel();
    if (!panel || !hstate) return;
    if (!hcfg) { cfgLoading = cfgLoading || loadCfg().then(() => { cfgLoading = null; if (hcfg) decorate(); }); return; }
    const providers = hcfg.providers || {};
    const byLabel = new Map();
    for (const [n, p] of Object.entries(providers)) byLabel.set(((p && p.name) || n).trim(), n);
    const list = panel.querySelector('.config-sidebar-list');
    if (list) {
      for (const btn of list.querySelectorAll('.config-sidebar-item:not(.models-sidebar-indented-item)')) {
        const label = (btn.querySelector('.config-sidebar-text') || {}).textContent;
        const name = label && byLabel.get(label.trim());
        const rec = name && hstate.providers[name];
        if (!rec) continue;
        const status = rec.status || 'unknown';
        const tip = `${name}：${STATUS_TEXT[status] || status}${rec.reason ? '\n' + rec.reason : ''}${rec.conn && rec.conn.hint ? '\n' + rec.conn.hint : ''}\n连通性检测 ${fmtTime(rec.conn && rec.conn.at)}（每 10 分钟）\n真实调用 ${fmtTime(hstate.call.lastRun)}（每 6 小时）`;
        setNode(btn, 'mh-dot ' + status, status + tip, (el) => { el.title = tip; });
        // model rows that follow inside the same wrapper
        const models = (providers[name] && providers[name].models) || [];
        const rowsEl = [...btn.parentElement.children].filter((c) => c.matches && c.matches('.config-sidebar-item.models-sidebar-indented-item'));
        rowsEl.forEach((row, i) => {
          const m = models[i];
          const t = m && rec.models && rec.models[m.id];
          if (!t) { const old = row.querySelector(':scope > .mh-mdot'); if (old) old.remove(); return; }
          const mt = t.ok ? `调用正常 ${fmtMs(t.ms)}（${fmtTime(t.at)}）` : `调用失败（${fmtTime(t.at)}）：${t.error}${t.detail ? '\n服务商返回：' + t.detail : ''}${t.hint ? '\n' + t.hint : ''}`;
          setNode(row, 'mh-mdot ' + (t.ok ? 'ok' : 'bad'), mt, (el) => { el.title = mt; });
        });
      }
    }
    // top bar: new models + check status
    const aside = panel.querySelector('.config-sidebar');
    if (!aside) return;
    const groups = Object.entries(hstate.groups || {}).filter(([, g]) => g.newModels && g.newModels.length);
    const newSig = JSON.stringify(groups.map(([gid, g]) => [gid, g.newModels]));
    setNode(aside, 'mh-new mh-bar', newSig, (el) => {
      el.innerHTML = groups.map(([gid, g]) => {
        const label = (g.providers[0] || '').replace(/-(Claude|GPT|Gemini|Other)(-\w+)?\d*$/i, '') || hostOf(g.baseUrl);
        return `<div title="${esc(g.newModels.join('\n'))}">「${esc(label)}」有 ${g.newModels.length} 个新模型可添加<button data-add="${gid}">查看</button><button data-ignore="${gid}">忽略</button></div>`;
      }).join('');
    }, true);
    const st = `自动检测：连通性每 10 分钟（上次 ${fmtTime(hstate.conn.lastRun)}）· 真实调用每 6 小时（上次 ${fmtTime(hstate.call.lastRun)}）`;
    const running = hstate.conn.running || hstate.call.running;
    setNode(aside, 'mh-status mh-bar', st + running, (el) => {
      el.innerHTML = `${esc(st)}${running ? ' · 检测中…' : '<button data-run="1">立即检测</button>'}`;
    });
    if (!aside.dataset.mhBound) {
      aside.dataset.mhBound = '1';
      aside.addEventListener('click', (e) => {
        const panel = modelsPanel();
        if (!panel) return;
        const d = e.target.dataset || {};
        if (d.run) {
          e.target.textContent = '检测中…';
          health('/run', { kind: 'all', wait: true }).then((s) => { hstate = s; renderAlerts(); decorate(); }).catch(() => {});
        } else if (d.add) {
          const g = hstate.groups[d.add];
          const pname = g && g.providers.find((n) => providers[n]);
          if (!g || !pname) return;
          openProvider(panel, pname, g.newModels);
        } else if (d.ignore) {
          const g = hstate.groups[d.ignore];
          if (!g) return;
          health('/ignore', { group: d.ignore, ids: g.newModels }).then((s) => { hstate = s; decorate(); }).catch(() => {});
        }
      });
    }
  }

  let raf = 0;
  let panelWasOpen = false;
  new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const open = !!modelsPanel();
      if (open && !panelWasOpen) { hcfg = null; pollHealth(); }
      panelWasOpen = open;
      if (open) decorate();
    });
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(() => { if (!document.hidden) pollHealth(); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollHealth(); });
  pollHealth();

  // The Models page reports each check it runs; refresh the dots right away.
  window.addEventListener('piweb:model-health-changed', () => {
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => { hcfg = null; pollHealth(); }, 400);
  });
  let changedTimer = 0;
})();
