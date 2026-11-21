/* ============================================================
 * ui.js — shared UI helpers: theme, toast, modal, DOM utils.
 * ============================================================ */
(function () {
  'use strict';

  // ---- DOM helpers -------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      // FIX: Convert numbers to strings, append nodes directly
      if (typeof c === 'string' || typeof c === 'number') {
        node.appendChild(document.createTextNode(String(c)));
      } else if (c instanceof Node) {
        node.appendChild(c);
      }
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- Theme -------------------------------------------------------
  function applyTheme(theme) {
    const root = document.documentElement;
    let effective = theme;
    if (theme === 'auto') {
      effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    root.setAttribute('data-theme', effective);
  }

  function initTheme() {
    const settings = Storage.getSettings();
    applyTheme(settings.theme || 'auto');
    
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (Storage.getSettings().theme === 'auto') applyTheme('auto');
    });

    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const curr = Storage.getSettings().theme || 'auto';
        const next = curr === 'light' ? 'dark' : curr === 'dark' ? 'auto' : 'light';
        Storage.setSettings({ theme: next });
        applyTheme(next);
        toast(`Theme: ${next}`, 'ok');
      });
    }
  }

  // ---- Toast -------------------------------------------------------
  function toast(msg, type = 'info', duration = 3000) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const t = el('div', { class: `toast ${type}` }, msg);
    region.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 200);
    }, duration);
  }

  // ---- Modal -------------------------------------------------------
  let modalResolve = null;
  function modal({ title, body, actions }) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      const root = document.getElementById('modal-root');
      const titleEl = root.querySelector('.modal-title');
      const bodyEl = root.querySelector('.modal-body');
      const actionsEl = root.querySelector('.modal-actions');
      
      titleEl.textContent = title;
      clear(bodyEl);
      if (typeof body === 'string') bodyEl.innerHTML = body;
      else if (body instanceof Node) bodyEl.appendChild(body);
      
      clear(actionsEl);
      for (const act of actions) {
        const btn = el('button', { 
          class: `btn ${act.type || ''}`, 
          onclick: () => closeModal(act.value) 
        }, act.label);
        actionsEl.appendChild(btn);
      }
      
      root.hidden = false;
      root.querySelector('button').focus();
    });
  }

  function closeModal(value) {
    const root = document.getElementById('modal-root');
    root.hidden = true;
    if (modalResolve) {
      modalResolve(value);
      modalResolve = null;
    }
  }

  function initModal() {
    const root = document.getElementById('modal-root');
    root.querySelector('.modal-backdrop').addEventListener('click', () => closeModal(null));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !root.hidden) closeModal(null);
    });
  }

  // ---- Time formatters ---------------------------------------------
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  window.UI = {
    el, clear,
    initTheme, applyTheme,
    toast, modal, initModal,
    fmtTime, fmtDuration,
  };
})();