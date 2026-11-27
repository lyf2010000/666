(function () {
  'use strict';
  const data = window.__REPORT__ || {};
  const storagePrefix = 'schematic-review:';
  const cards = Array.from(document.querySelectorAll('.finding'));
  const state = { severity: 'all', category: 'all', page: 'all', q: '' };
  let storageOK = true;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1800);
  }
  function storageGet(key) {
    if (!storageOK) return null;
    try { return localStorage.getItem(key); } catch { storageOK = false; return null; }
  }
  function storageSet(key, val) {
    if (!storageOK) return false;
    try { localStorage.setItem(key, val); return true; } catch { storageOK = false; return false; }
  }

  function applyFilters() {
    let shown = 0;
    for (const card of cards) {
      const sev = card.dataset.severity || '';
      const cat = card.dataset.category || '';
      const page = card.dataset.page || '';
      const text = (card.dataset.search || '').toLowerCase();
      const ok = (state.severity === 'all' || sev === state.severity) &&
        (state.category === 'all' || cat === state.category) &&
        (state.page === 'all' || page === state.page) &&
        (!state.q || text.includes(state.q));
      card.hidden = !ok;
      if (ok) shown++;
    }
    const counter = $('#visible-count');
    if (counter) counter.textContent = String(shown);
    const empty = $('#filter-empty');
    if (empty) empty.hidden = shown !== 0 || cards.length === 0;
  }

  for (const chip of $all('.severity-chip')) {
    chip.addEventListener('click', () => {
      state.severity = chip.dataset.severity || 'all';
      for (const c of $all('.severity-chip')) c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
      applyFilters();
    });
  }
  const catSel = $('#filter-category');
  if (catSel) catSel.addEventListener('change', () => { state.category = catSel.value; applyFilters(); });
  const pageSel = $('#filter-page');
  if (pageSel) pageSel.addEventListener('change', () => { state.page = pageSel.value; applyFilters(); });
  const search = $('#search');
  if (search) search.addEventListener('input', () => { state.q = search.value.trim().toLowerCase(); applyFilters(); });

  // Lightbox
  const lightbox = $('#lightbox');
  const lightboxImg = $('#lightbox-img');
  document.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      const target = document.getElementById(jump.dataset.jump);
      if (target) {
        target.hidden = false;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.style.outline = '2px solid #0f766e';
        setTimeout(() => { target.style.outline = ''; }, 1600);
      }
      return;
    }
    const img = e.target.closest('.shot img');
    if (img && lightbox && lightboxImg) {
      lightboxImg.src = img.src;
      lightbox.hidden = false;
      return;
    }
    if (e.target.closest('.lightbox-close') || e.target === lightbox) {
      if (lightbox) lightbox.hidden = true;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const text = copy.dataset.copy;
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('已复制: ' + text)).catch(() => toast(text));
      else toast(text);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox) lightbox.hidden = true;
  });

  // Review marks
  function loadState(findingKey) {
    const raw = storageGet(storagePrefix + findingKey);
    if (!raw) return { status: 'pending', note: '' };
    try { return JSON.parse(raw); } catch { return { status: 'pending', note: '' }; }
  }
  function saveState(findingKey, value) {
    const ok = storageSet(storagePrefix + findingKey, JSON.stringify(value));
    if (!ok) toast('当前环境无法保存评审标记，请使用导出纪要');
    return ok;
  }

  for (const card of cards) {
    const key = card.dataset.findingKey;
    if (!key) continue;
    const saved = loadState(key);
    const buttons = $all('.review-state-btn', card);
    const note = $('.review-note', card);
    if (note) note.value = saved.note || '';
    const sync = () => {
      for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.status === saved.status ? 'true' : 'false');
      const label = $('.review-state', card);
      if (label) label.textContent = saved.status;
    };
    sync();
    for (const b of buttons) {
      b.addEventListener('click', () => {
        saved.status = b.dataset.status;
        saved.updatedAt = new Date().toISOString();
        saveState(key, saved);
        sync();
      });
    }
    if (note) {
      note.addEventListener('change', () => {
        saved.note = note.value;
        saved.updatedAt = new Date().toISOString();
        saveState(key, saved);
      });
    }
  }

  // Export review minutes
  const exportBtn = $('#export-minutes');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const lines = ['# 原理图审查纪要', '', `- 运行: ${data.runId || ''}`, `- 生成: ${new Date().toISOString()}`, ''];
      for (const card of cards) {
        const key = card.dataset.findingKey || '';
        const s = loadState(key);
        const title = $('.finding-title', card)?.textContent || '';
        const id = card.dataset.id || '';
        const sev = card.dataset.severity || '';
        lines.push(`## ${id} [${sev}] ${title}`);
        lines.push(`- 状态: ${s.status || 'pending'}`);
        if (s.note) lines.push(`- 备注: ${s.note}`);
        lines.push('');
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `schematic-review-${data.runId || 'minutes'}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  if (!storageOK) {
    const hint = $('#storage-hint');
    if (hint) hint.hidden = false;
  }
  applyFilters();
})();
