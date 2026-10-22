'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.38a2 2 0 0 1 1.42.59L11.7 7H18.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5Z"/></svg>',
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4.5 6.5 10l5.5 5.5"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>',
  star: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="iri" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0a6ff"/><stop offset=".45" stop-color="#9b5cff"/><stop offset=".75" stop-color="#5ee0ff"/><stop offset="1" stop-color="#ff8fd8"/></linearGradient></defs><path d="M15 7.5h18a2.5 2.5 0 0 1 2.5 2.5v30.5L24 33l-11.5 7.5V10A2.5 2.5 0 0 1 15 7.5Z" fill="none" stroke="url(#iri)" stroke-width="2.2" stroke-linejoin="round"/><path d="m24 14.5 2.35 4.77 5.27.77-3.81 3.71.9 5.25L24 26.52l-4.71 2.48.9-5.25-3.81-3.71 5.27-.77Z" fill="url(#iri)" opacity=".9"/></svg>',
  window: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="11" rx="2"/><path d="M3 8h14"/></svg>',
  empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.38a2 2 0 0 1 1.42.59L11.7 7H18.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5Z"/></svg>',
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const icon = (name, cls = 'ico') => h('span', { class: cls, html: ICONS[name] });

function faviconURL(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.href;
}

function favicon(pageUrl, cls = 'fav') {
  return h('img', { class: cls, src: faviconURL(pageUrl), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
}

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'Local file';
    if (u.protocol === 'javascript:') return 'Bookmarklet';
    return (u.host || u.protocol.replace(':', '')).replace(/^www\./, '');
  } catch { return url; }
}

const debounce = (fn, ms = 60) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ───────────────────────── Live wallpaper ───────────────────────── */

const video = $('#bg');
const VIDEO_SPEED = 1;
video.defaultPlaybackRate = VIDEO_SPEED;
video.playbackRate = VIDEO_SPEED;
video.addEventListener('loadedmetadata', () => { video.playbackRate = VIDEO_SPEED; });
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
const STILL_AT = 7; // seconds — a well-composed frame used as the reduced-motion poster

function syncVideoSource() {
  // Recreated Metamorphic videos: dark.webm in dark mode, light.webm in light mode.
  const name = darkMQ.matches ? 'dark' : 'light';
  if (video.dataset.name === name) return;
  video.dataset.name = name;
  video.classList.remove('ready');
  video.src = `${name}.webm`;
  video.load();
}

function syncPlayback() {
  if (reduceMQ.matches || document.hidden) video.pause();
  else video.play().catch(() => {});
}

video.addEventListener('loadedmetadata', () => {
  if (reduceMQ.matches) video.currentTime = Math.min(STILL_AT, (video.duration || STILL_AT * 2) / 2);
});
video.addEventListener('loadeddata', () => { video.classList.add('ready'); syncPlayback(); });
video.addEventListener('seeked', () => video.classList.add('ready'));
video.addEventListener('error', () => video.classList.remove('ready'));

darkMQ.addEventListener('change', () => { syncVideoSource(); syncPlayback(); });
reduceMQ.addEventListener('change', syncPlayback);
document.addEventListener('visibilitychange', syncPlayback);
syncVideoSource();

/* ───────────────────────── Bookmarks ───────────────────────── */

const ui = {
  panel: $('#panel'),
  roots: $('#roots'),
  crumbs: $('#crumbs'),
  body: $('#body'),
  foot: $('#foot'),
  filter: $('#filter'),
  q: $('#q'),
  manage: $('#manage'),
};

const ROOT_LABELS = { '1': 'Bookmarks bar', '2': 'Other', '3': 'Mobile' };
const FOLDER_TYPE_LABELS = { 'bookmarks-bar': 'Bookmarks bar', other: 'Other', mobile: 'Mobile' };
const state = {
  tree: null,
  byId: new Map(),
  folderId: localStorage.getItem('livetab.folder'),
  query: '',
  importing: false,
};

function index(node, parent = null, depth = 0) {
  node.parent = parent;
  node.depth = depth;
  state.byId.set(node.id, node);
  let links = 0;
  let folders = 0;
  if (node.children) {
    for (const c of node.children) {
      index(c, node, depth + 1);
      if (c.url) links++;
      else { folders++; links += c.links; }
    }
  }
  node.links = links;
  node.folders = folders;
  return node;
}

const isFolder = (n) => !n.url;
function rootLabel(n) {
  const base = FOLDER_TYPE_LABELS[n.folderType] || (!n.folderType && ROOT_LABELS[n.id]) || n.title || 'Bookmarks';
  // With account bookmark storage, Chromium exposes a local and a synced copy of each root.
  const twins = (state.tree?.children || []).filter((r) => r.folderType && r.folderType === n.folderType);
  return twins.length > 1 && n.syncing ? `${base} · Synced` : base;
}
const nodeTitle = (n) => (n.depth === 1 ? rootLabel(n) : n.title) || (n.url ? hostOf(n.url) : 'Untitled folder');
const visibleRoots = () => (state.tree?.children || []).filter((r) => r.links > 0 || r.folders > 0);

function pathOf(node) {
  const path = [];
  for (let n = node; n && n.depth > 0; n = n.parent) path.unshift(n);
  return path;
}

async function loadBookmarks() {
  const [root] = await chrome.bookmarks.getTree();
  state.byId = new Map();
  state.tree = index(root);
  render();
}

const scheduleReload = debounce(() => { if (!state.importing) loadBookmarks(); }, 80);

for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) {
  chrome.bookmarks[ev]?.addListener(scheduleReload);
}
chrome.bookmarks.onImportBegan?.addListener(() => { state.importing = true; });
chrome.bookmarks.onImportEnded?.addListener(() => { state.importing = false; scheduleReload(); });

function currentFolder() {
  const roots = visibleRoots();
  let f = state.byId.get(state.folderId);
  if (!f || !isFolder(f) || f.depth === 0 || !roots.includes(pathOf(f)[0])) f = roots[0];
  return f;
}

function go(folderId, { focus = true } = {}) {
  const prev = state.folderId;
  state.folderId = folderId;
  localStorage.setItem('livetab.folder', folderId);
  if (state.query) clearFilter(false);
  render({ animate: prev !== folderId ? 'enter' : null });
  if (focus) requestAnimationFrame(() => focusFirstItem());
}

function goUp() {
  const f = currentFolder();
  if (f && f.depth > 1) {
    const child = f.id;
    go(f.parent.id, { focus: false });
    requestAnimationFrame(() => (ui.body.querySelector(`[data-id="${child}"]`) || ui.body.querySelector('.item'))?.focus());
    return true;
  }
  return false;
}

function render({ animate = null } = {}) {
  ui.panel.removeAttribute('aria-busy');
  const roots = visibleRoots();
  const empty = roots.length === 0;
  ui.panel.classList.toggle('is-empty', empty);
  ui.filter.hidden = empty;
  ui.foot.hidden = empty;
  if (empty) {
    ui.roots.replaceChildren(h('div', { class: 'roots-title' }, 'Bookmarks'));
    ui.crumbs.replaceChildren();
    ui.crumbs.hidden = true;
    ui.body.replaceChildren(renderEmptyState());
    return;
  }

  const folder = currentFolder();
  const root = pathOf(folder)[0];
  renderRoots(roots, root);
  renderCrumbs(folder);

  const content = state.query ? renderResults(state.query) : renderFolder(folder);
  ui.body.replaceChildren(content);
  if (animate) {
    content.classList.add(animate);
    ui.body.scrollTop = 0;
  }
  updateScrollShadows();
}

function renderRoots(roots, active) {
  const tabs = roots.map((r) =>
    h('button', {
      class: 'root-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(r === active && !state.query),
      dataset: { id: r.id },
      onclick: () => go(r.id),
    }, h('span', { class: 'root-name' }, rootLabel(r)), h('span', { class: 'count' }, r.links)),
  );
  ui.roots.replaceChildren(...tabs);
}

function renderCrumbs(folder) {
  const path = pathOf(folder);
  if (state.query || path.length < 2) {
    ui.crumbs.hidden = true;
    ui.crumbs.replaceChildren();
    return;
  }
  ui.crumbs.hidden = false;
  const parts = [
    h('button', { class: 'crumb-back', type: 'button', title: 'Back (⌫)', 'aria-label': 'Back to parent folder', onclick: goUp, html: ICONS.back }),
  ];
  path.forEach((n, i) => {
    if (i) parts.push(icon('chevron', 'crumb-sep'));
    const last = i === path.length - 1;
    parts.push(last
      ? h('span', { class: 'crumb current', 'aria-current': 'page' }, nodeTitle(n))
      : h('button', { class: 'crumb', type: 'button', onclick: () => go(n.id) }, nodeTitle(n)));
  });
  ui.crumbs.replaceChildren(...parts);
}

function folderMeta(n) {
  const direct = n.children?.length || 0;
  if (!direct) return 'Empty';
  return `${direct} ${direct === 1 ? 'item' : 'items'}`;
}

function previewLinks(n, max = 3) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (out.length >= max) return;
      if (c.url && /^https?:/.test(c.url)) out.push(c);
    }
    for (const c of node.children || []) {
      if (out.length >= max) return;
      if (!c.url) walk(c);
    }
  };
  walk(n);
  return out;
}

function folderCard(n) {
  const previews = previewLinks(n);
  return h('button', {
    class: 'item folder-card',
    type: 'button',
    dataset: { id: n.id },
    title: n.title,
    onclick: () => go(n.id),
  },
  h('span', { class: 'folder-glyph', html: ICONS.folder }),
  h('span', { class: 'item-text' },
    h('span', { class: 'item-title' }, nodeTitle(n)),
    h('span', { class: 'item-sub' }, folderMeta(n))),
  previews.length ? h('span', { class: 'folder-peek', 'aria-hidden': 'true' }, previews.map((p) => favicon(p.url, 'peek'))) : null,
  );
}

const NAVIGABLE = /^(https?|ftp):/i;
const BROWSER_INTERNAL = /^(chrome|edge|brave|helium|about|file|view-source|chrome-extension):/i;

function linkRow(n, { sub, highlight } = {}) {
  const title = n.title || hostOf(n.url);
  const isBookmarklet = /^javascript:/i.test(n.url);
  const a = h('a', {
    class: 'item link' + (isBookmarklet ? ' is-disabled' : ''),
    href: isBookmarklet ? undefined : n.url,
    tabindex: isBookmarklet ? '-1' : undefined,
    dataset: { id: n.id },
    title: isBookmarklet ? `${title}\nBookmarklets can't run from the new tab page` : `${title}\n${n.url}`,
    draggable: 'true',
  },
  h('span', { class: 'fav-wrap' }, favicon(n.url)),
  h('span', { class: 'item-text' },
    h('span', { class: 'item-title' }, highlight ? highlight(title) : title),
    h('span', { class: 'item-sub' }, sub ?? hostOf(n.url))),
  );
  if (!NAVIGABLE.test(n.url) && BROWSER_INTERNAL.test(n.url)) {
    // Extension pages can't link-navigate to browser-internal URLs; hand them to the tabs API.
    const open = (e) => {
      if (e.button > 1) return;
      e.preventDefault();
      const background = e.metaKey || e.ctrlKey || e.button === 1;
      if (background || e.shiftKey) chrome.tabs.create({ url: n.url, active: !background });
      else chrome.tabs.update({ url: n.url });
    };
    a.addEventListener('click', open);
    a.addEventListener('auxclick', open);
  }
  return a;
}

function section(label, count, grid) {
  return h('section', { class: 'group' },
    h('h3', { class: 'group-label' }, label, count != null ? h('span', { class: 'count' }, count) : null),
    grid);
}

function renderFolder(folder) {
  const kids = folder.children || [];
  const folders = kids.filter(isFolder);
  const links = kids.filter((c) => c.url);
  const wrap = h('div', { class: 'view' });
  if (!kids.length) {
    wrap.append(h('div', { class: 'folder-empty' },
      icon('empty', 'folder-empty-ico'),
      h('p', { class: 'folder-empty-title' }, 'This folder is empty'),
      h('p', { class: 'folder-empty-sub' }, 'Bookmarks you save here will appear instantly.')));
    return wrap;
  }
  if (folders.length) wrap.append(section('Folders', folders.length, h('div', { class: 'grid folders' }, folders.map(folderCard))));
  if (links.length) wrap.append(section(folders.length ? 'Bookmarks' : nodeTitle(folder), links.length, h('div', { class: 'grid links' }, links.map((n) => linkRow(n)))));
  return wrap;
}

function allLinks(node, out = []) {
  for (const c of node.children || []) {
    if (c.url) out.push(c);
    else allLinks(c, out);
  }
  return out;
}

function makeHighlighter(terms) {
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (text) => {
    const frag = document.createDocumentFragment();
    let last = 0;
    text.replace(re, (m, _g, i) => {
      if (i > last) frag.append(text.slice(last, i));
      frag.append(h('mark', {}, m));
      last = i + m.length;
      return m;
    });
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  };
}

function renderResults(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const n of allLinks(state.tree)) {
    const title = (n.title || '').toLowerCase();
    const url = n.url.toLowerCase();
    const folderPath = pathOf(n.parent).map(nodeTitle).join(' ').toLowerCase();
    if (!terms.every((t) => title.includes(t) || url.includes(t) || folderPath.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (title.startsWith(t)) score += 4;
      else if (title.includes(t)) score += 2;
      if (hostOf(n.url).toLowerCase().startsWith(t)) score += 3;
    }
    scored.push([score, n]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const wrap = h('div', { class: 'view' });
  if (!scored.length) {
    wrap.append(h('div', { class: 'folder-empty' },
      h('p', { class: 'folder-empty-title' }, `No bookmarks match “${query}”`),
      h('p', { class: 'folder-empty-sub' }, 'Try a site name, a word from the title, or a folder name.')));
    return wrap;
  }
  const hl = makeHighlighter(terms);
  const rows = scored.slice(0, 200).map(([, n]) => {
    const where = pathOf(n.parent).map(nodeTitle).join(' › ');
    return linkRow(n, { sub: `${hostOf(n.url)}  ·  ${where}`, highlight: hl });
  });
  wrap.append(section('Results', scored.length, h('div', { class: 'grid links' }, rows)));
  return wrap;
}

function openInternal(url) {
  chrome.tabs.update({ url });
}

function renderEmptyState() {
  return h('div', { class: 'empty view enter' },
    h('div', { class: 'empty-art', html: ICONS.star }),
    h('h2', { class: 'empty-title' }, 'Your bookmarks will live here'),
    h('p', { class: 'empty-text' },
      'Press ', h('kbd', {}, MOD), h('kbd', {}, 'D'), ' on any page to save it.', h('br'),
      'It shows up here the moment you do.'),
    h('div', { class: 'empty-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => openInternal('chrome://bookmarks/') }, 'Open bookmark manager'),
      h('button', { class: 'btn', type: 'button', onclick: () => openInternal('chrome://settings/importData') }, 'Import bookmarks…')),
  );
}

/* ───────────────────────── Filter ───────────────────────── */

function setFilter(value) {
  state.query = value.trim();
  ui.filter.classList.toggle('active', !!value || document.activeElement === ui.q);
  render({ animate: null });
}

function clearFilter(rerender = true) {
  ui.q.value = '';
  state.query = '';
  ui.filter.classList.remove('active');
  if (rerender) render();
}

ui.q.addEventListener('input', () => setFilter(ui.q.value));
ui.q.addEventListener('focus', () => {
  ui.filter.classList.add('active');
  ui.q.placeholder = 'Filter by title, site or folder';
});
ui.q.addEventListener('blur', () => {
  if (!ui.q.value) ui.filter.classList.remove('active');
  ui.q.placeholder = 'Filter';
});
ui.q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    clearFilter();
    ui.q.blur();
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    const first = ui.body.querySelector('.item:not(.is-disabled)');
    if (!first) return;
    e.preventDefault();
    if (e.key === 'Enter') first.click();
    else first.focus();
  }
});
ui.manage.addEventListener('click', () => openInternal('chrome://bookmarks/'));

/* ───────────────────────── Keyboard navigation ───────────────────────── */

const items = () => [...ui.body.querySelectorAll('.item:not(.is-disabled)')];

function focusFirstItem() {
  items()[0]?.focus({ preventScroll: false });
}

function moveFocus(dir) {
  const list = items();
  if (!list.length) return;
  const cur = document.activeElement;
  const idx = list.indexOf(cur);
  if (idx === -1) { list[0].focus(); return; }
  if (dir === 'left' || dir === 'right') {
    const next = list[idx + (dir === 'right' ? 1 : -1)];
    next?.focus();
    return;
  }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const down = dir === 'down';
  let best = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dy = down ? b.top - r.bottom : r.top - b.bottom;
    if (dy < -2) continue;
    const score = dy * 4 + Math.abs(b.left + b.width / 2 - cx);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) best.focus();
  else if (!down && ui.filter.offsetParent) ui.roots.querySelector('[aria-selected="true"]')?.focus();
}

document.addEventListener('keydown', (e) => {
  const inInput = e.target === ui.q;
  if (inInput) return;
  const mod = e.metaKey || e.ctrlKey || e.altKey;

  if (e.key === '/' && !mod && !ui.filter.hidden) {
    e.preventDefault();
    ui.q.focus();
    return;
  }
  if (e.key === 'Escape' && state.query) { clearFilter(); return; }

  const onTab = e.target.closest?.('.root-tab');
  if (onTab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const tabs = [...ui.roots.querySelectorAll('.root-tab')];
    const next = tabs[(tabs.indexOf(onTab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
    next.focus();
    return;
  }
  if (onTab && e.key === 'ArrowDown') { e.preventDefault(); focusFirstItem(); return; }

  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (arrows[e.key] && !mod && (ui.body.contains(e.target) || e.target === document.body)) {
    e.preventDefault();
    moveFocus(arrows[e.key]);
    return;
  }
  if ((e.key === 'Backspace' && !mod) || (e.key === 'ArrowLeft' && e.altKey) || (e.key === '[' && (e.metaKey || e.ctrlKey))) {
    if (goUp()) e.preventDefault();
    return;
  }
  // Type-to-filter: any printable key starts filtering.
  if (e.key.length === 1 && !mod && e.key !== ' ' && !ui.filter.hidden && !e.target.closest?.('.recent')) {
    ui.q.focus();
  }
});

/* ───────────────────────── Filter shortcut (extension command) ───────────────────────── */

function focusFilterSoon() {
  const until = performance.now() + 3000;
  const tryFocus = () => {
    if (!ui.filter.hidden && ui.panel.getAttribute('aria-busy') !== 'true') {
      ui.q.focus();
      if (document.activeElement === ui.q) return;
    }
    if (performance.now() < until) requestAnimationFrame(tryFocus);
  };
  tryFocus();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'focus-filter') return;
  focusFilterSoon();
  reply({ focused: document.hasFocus() });
});

// filter.html (opened by the filter shortcut) shows its own address in the address bar. Once you leave
// that tab, turn it back into the real new tab page so the address bar is blank next time.
if (location.pathname.endsWith('/filter.html')) {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'hidden') return;
    const me = await chrome.tabs.getCurrent().catch(() => null);
    // Only when you switched to another tab, never while this tab is navigating somewhere you chose.
    if (me?.id == null || me.active || me.pendingUrl) return;
    chrome.tabs.update(me.id, { url: 'chrome://newtab/' }).catch(() => {});
  });
}

if (location.hash === '#filter' || new URLSearchParams(location.search).has('filter')) {
  history.replaceState(null, '', location.pathname);
  focusFilterSoon();
}

/* ───────────────────────── Scroll edge fades ───────────────────────── */

function updateScrollShadows() {
  const b = ui.body;
  ui.panel.classList.toggle('fade-top', b.scrollTop > 4);
  ui.panel.classList.toggle('fade-bottom', b.scrollTop + b.clientHeight < b.scrollHeight - 4);
}
ui.body.addEventListener('scroll', updateScrollShadows, { passive: true });
addEventListener('resize', debounce(updateScrollShadows, 100));

/* ───────────────────────── Recently closed ───────────────────────── */

const recent = { el: $('#recent'), list: $('#recentList') };
const OWN_NTP = chrome.runtime.getURL(''); // newtab.html and filter.html
const SKIP_URL = (u) => !u || u.startsWith(OWN_NTP) || /^chrome:\/\/(newtab|new-tab-page)/.test(u) || u.startsWith('chrome-search://');
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function timeAgo(sec) {
  const diff = Math.round(sec - Date.now() / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

async function restore(sessionId, isTab) {
  const current = await chrome.tabs.getCurrent().catch(() => null);
  await chrome.sessions.restore(sessionId);
  // A restored tab opens next to us — close this now-redundant new tab so it feels like "go back".
  if (isTab && current?.id != null) chrome.tabs.remove(current.id).catch(() => {});
}

async function loadRecent() {
  let sessions = [];
  try {
    sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  } catch { /* sessions unavailable */ }
  const chips = [];
  for (const s of sessions) {
    if (chips.length >= 8) break;
    if (s.tab) {
      const t = s.tab;
      if (SKIP_URL(t.url) || !t.sessionId) continue;
      const title = t.title || hostOf(t.url);
      chips.push(h('button', {
        class: 'chip',
        type: 'button',
        title: `${title}\n${t.url}\nClosed ${timeAgo(s.lastModified)} — click to restore`,
        onclick: () => restore(t.sessionId, true),
      }, favicon(t.url, 'chip-fav'), h('span', { class: 'chip-text' }, title)));
    } else if (s.window) {
      const tabs = (s.window.tabs || []).filter((t) => !SKIP_URL(t.url));
      if (!tabs.length || !s.window.sessionId) continue;
      chips.push(h('button', {
        class: 'chip chip-window',
        type: 'button',
        title: `Window with ${tabs.length} tabs\n${tabs.slice(0, 6).map((t) => '• ' + (t.title || hostOf(t.url))).join('\n')}\nClosed ${timeAgo(s.lastModified)} — click to restore`,
        onclick: () => restore(s.window.sessionId, false),
      },
      h('span', { class: 'chip-stack' }, tabs.slice(0, 3).map((t) => favicon(t.url, 'chip-fav'))),
      h('span', { class: 'chip-text' }, `Window · ${tabs.length} tabs`)));
    }
  }
  recent.list.replaceChildren(...chips);
  recent.el.hidden = chips.length === 0;
}

chrome.sessions?.onChanged?.addListener(debounce(loadRecent, 120));

/* ───────────────────────── Boot ───────────────────────── */

document.documentElement.classList.toggle('is-mac', IS_MAC);
loadBookmarks().catch((err) => {
  ui.panel.removeAttribute('aria-busy');
  ui.body.replaceChildren(h('div', { class: 'folder-empty' },
    h('p', { class: 'folder-empty-title' }, 'Bookmarks are unavailable'),
    h('p', { class: 'folder-empty-sub' }, String(err?.message || err))));
});
loadRecent();
