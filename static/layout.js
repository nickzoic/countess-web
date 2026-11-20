/*
 * layout.js: resizable, responsive pane layout for CountESS Web.
 *
 * - Drag a splitter to resize; with a splitter focused, the arrow keys move it
 *   (Shift for bigger steps) and Enter or a double-click puts it back.
 * - The expand button on a pane fills the workspace with it; Esc restores.
 * - On narrow screens the tabs in the app bar choose which pane is shown.
 * - Split positions and the chosen tab are remembered between sessions.
 */
(function () {
  'use strict';

  const STORE_KEY = 'countess-web.layout';
  const DEFAULTS = { x: 0.6, y: 0.62 };
  const MIN_PX = { x: 200, y: 90 };     // smallest a pane may be made, in pixels
  const STEP = 0.02, BIG_STEP = 0.1;     // keyboard steps, as fractions
  const NARROW = window.matchMedia('(max-width: 760px)');

  const workspace = document.getElementById('workspace');
  const root = document.documentElement;
  const panes = Array.from(workspace.querySelectorAll('.pane'));
  const tabs = Array.from(document.querySelectorAll('.tabs [role="tab"]'));
  const splitters = Array.from(workspace.querySelectorAll('.splitter'));

  const ICON_EXPAND = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/></svg>';
  const ICON_RESTORE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14"/></svg>';

  /* ── Remembered state ─────────────────────────────────────────────── */

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && typeof s === 'object') return s;
    } catch (e) { /* storage unavailable or corrupt: use defaults */ }
    return {};
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  const stored = load();
  const state = {
    x: typeof stored.x === 'number' ? stored.x : DEFAULTS.x,
    y: typeof stored.y === 'number' ? stored.y : DEFAULTS.y,
    tab: ['dag', 'config', 'view'].includes(stored.tab) ? stored.tab : 'dag',
  };

  /* ── Splits ───────────────────────────────────────────────────────── */

  // The space the two panes on either side of a splitter share, in pixels.
  function trackSpace(axis) {
    const cs = getComputedStyle(workspace);
    const gap = parseFloat(cs.getPropertyValue('--gap')) || 8;
    if (axis === 'x') {
      return workspace.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gap;
    }
    return workspace.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - gap;
  }

  function clampFraction(axis, f) {
    const space = trackSpace(axis);
    if (space <= 0) return Math.min(Math.max(f, 0.1), 0.9);
    const min = Math.min(MIN_PX[axis] / space, 0.45);
    return Math.min(Math.max(f, min), 1 - min);
  }

  function applySplit(axis, f, persist) {
    f = clampFraction(axis, f);
    state[axis] = f;
    root.style.setProperty(axis === 'x' ? '--split-x' : '--split-y', f.toFixed(4));
    const sp = workspace.querySelector('.splitter[data-axis="' + axis + '"]');
    sp.setAttribute('aria-valuenow', Math.round(f * 100));
    if (persist) save();
  }

  splitters.forEach(sp => {
    const axis = sp.dataset.axis;

    sp.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('is-dragging');
      document.body.classList.add('is-resizing-' + axis);
      const rect = workspace.getBoundingClientRect();
      const cs = getComputedStyle(workspace);
      const start = axis === 'x' ? rect.left + parseFloat(cs.paddingLeft) : rect.top + parseFloat(cs.paddingTop);
      const gap = parseFloat(cs.getPropertyValue('--gap')) || 8;
      const space = trackSpace(axis);

      const move = ev => {
        const pos = (axis === 'x' ? ev.clientX : ev.clientY) - start - gap / 2;
        applySplit(axis, pos / space, false);
      };
      const end = () => {
        sp.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing-' + axis);
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', end);
        sp.removeEventListener('pointercancel', end);
        save();
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', end);
      sp.addEventListener('pointercancel', end);
    });

    sp.addEventListener('dblclick', () => applySplit(axis, DEFAULTS[axis], true));

    sp.addEventListener('keydown', e => {
      const step = e.shiftKey ? BIG_STEP : STEP;
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const fwd = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      let f = null;
      if (e.key === back) f = state[axis] - step;
      else if (e.key === fwd) f = state[axis] + step;
      else if (e.key === 'Home') f = 0;
      else if (e.key === 'End') f = 1;
      else if (e.key === 'Enter') f = DEFAULTS[axis];
      if (f === null) return;
      e.preventDefault();
      applySplit(axis, f, true);
    });
  });

  // Keep the minimum pane sizes honoured as the window changes size.
  window.addEventListener('resize', () => {
    if (NARROW.matches || workspace.dataset.max) return;
    applySplit('x', state.x, false);
    applySplit('y', state.y, false);
  });

  /* ── Expand one pane ──────────────────────────────────────────────── */

  function setMax(name) {
    if (name) workspace.dataset.max = name;
    else delete workspace.dataset.max;
    panes.forEach(p => {
      const btn = p.querySelector('.pane-max');
      const on = p.dataset.pane === name;
      btn.setAttribute('aria-pressed', String(on));
      btn.innerHTML = on ? ICON_RESTORE : ICON_EXPAND;
      const label = btn.getAttribute('aria-label').replace(/^(Expand|Restore)/, on ? 'Restore' : 'Expand');
      btn.setAttribute('aria-label', label);
      btn.title = on ? 'Restore layout (Esc)' : 'Expand';
    });
    if (!name) {
      applySplit('x', state.x, false);
      applySplit('y', state.y, false);
    }
  }

  panes.forEach(p => {
    p.querySelector('.pane-max').addEventListener('click', () => {
      setMax(workspace.dataset.max === p.dataset.pane ? null : p.dataset.pane);
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && workspace.dataset.max && !e.defaultPrevented) {
      const name = workspace.dataset.max;
      setMax(null);
      workspace.querySelector('.pane[data-pane="' + name + '"] .pane-max').focus();
    }
  });

  /* ── Tabs (narrow screens) ────────────────────────────────────────── */

  function selectTab(name, focus) {
    state.tab = name;
    tabs.forEach(t => {
      const on = t.dataset.pane === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    panes.forEach(p => p.classList.toggle('is-active', p.dataset.pane === name));
    save();
  }

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.dataset.pane, false));
    t.addEventListener('keydown', e => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j === null) return;
      e.preventDefault();
      selectTab(tabs[j].dataset.pane, true);
    });
  });

  // Panes are tab panels only while the tabs are showing.
  function syncRoles() {
    panes.forEach(p => {
      if (NARROW.matches) {
        p.setAttribute('role', 'tabpanel');
        p.setAttribute('aria-labelledby', 'tab-' + p.dataset.pane);
      } else {
        p.removeAttribute('role');
        p.setAttribute('aria-labelledby', 'title-' + p.dataset.pane);
      }
    });
    if (NARROW.matches && workspace.dataset.max) setMax(null);
  }
  NARROW.addEventListener('change', syncRoles);

  /* ── Start up ─────────────────────────────────────────────────────── */

  applySplit('x', state.x, false);
  applySplit('y', state.y, false);
  setMax(null);
  selectTab(state.tab, false);
  syncRoles();
})();
