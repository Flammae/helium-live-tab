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
  return h('img', { class: cls, src: faviconURL(pageUrl), alt: '', decoding: 'async', draggable: 'false' });
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
  scroll: $('#panelScroll'),
  roots: $('#roots'),
  crumbs: $('#crumbs'),
  body: $('#body'),
  foot: $('#foot'),
  manage: $('#manage'),
};

const ROOT_LABELS = { '1': 'Bookmarks bar', '2': 'Other', '3': 'Mobile' };
const FOLDER_TYPE_LABELS = { 'bookmarks-bar': 'Bookmarks bar', other: 'Other', mobile: 'Mobile' };
const state = {
  tree: null,
  byId: new Map(),
  folderId: localStorage.getItem('livetab.folder'),
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

function go(folderId) {
  const prev = state.folderId;
  state.folderId = folderId;
  localStorage.setItem('livetab.folder', folderId);
  render({ animate: prev !== folderId ? 'enter' : null });
}

function goUp() {
  const f = currentFolder();
  if (f && f.depth > 1) {
    rover.key = `bm:${f.id}`;
    go(f.parent.id);
    return true;
  }
  return false;
}

function render({ animate = null } = {}) {
  if (!boot.pending) ui.panel.removeAttribute('aria-busy');
  const roots = visibleRoots();
  const empty = roots.length === 0;
  ui.panel.classList.toggle('is-empty', empty);
  const hadFocus = ui.body.contains(document.activeElement);
  ui.foot.hidden = empty;
  if (empty) {
    ui.roots.replaceChildren(h('div', { class: 'roots-title' }, 'Bookmarks'));
    ui.crumbs.replaceChildren();
    ui.crumbs.hidden = true;
    ui.body.replaceChildren(renderEmptyState());
    refreshLane({ restore: hadFocus });
    return;
  }

  const folder = currentFolder();
  const root = pathOf(folder)[0];
  renderRoots(roots, root);
  renderCrumbs(folder);

  const content = renderFolder(folder);
  ui.body.replaceChildren(content);
  if (animate) {
    content.classList.add(animate);
    if (ui.scroll) ui.scroll.scrollTop = 0; else ui.body.scrollTop = 0;
  }
  refreshLane({ restore: hadFocus, fallback: ui.body });
  updateScrollShadows();
}

function renderRoots(roots, active) {
  const tabs = roots.map((r) =>
    h('button', {
      class: 'root-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(r === active),
      dataset: { id: r.id },
      onclick: () => go(r.id),
    }, h('span', { class: 'root-name' }, rootLabel(r)), h('span', { class: 'count' }, r.links)),
  );
  ui.roots.replaceChildren(...tabs);
}

function renderCrumbs(folder) {
  const path = pathOf(folder);
  if (path.length < 2) {
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
    dataset: { id: n.id, key: `bm:${n.id}` },
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

function linkRow(n) {
  const title = n.title || hostOf(n.url);
  const isBookmarklet = /^javascript:/i.test(n.url);
  const a = h('a', {
    class: 'item link' + (isBookmarklet ? ' is-disabled' : ''),
    href: isBookmarklet ? undefined : n.url,
    tabindex: isBookmarklet ? '-1' : undefined,
    dataset: { id: n.id, key: `bm:${n.id}` },
    title: isBookmarklet ? `${title}\nBookmarklets can't run from the new tab page` : `${title}\n${n.url}`,
    draggable: 'true',
  },
  h('span', { class: 'fav-wrap' }, favicon(n.url)),
  h('span', { class: 'item-text' },
    h('span', { class: 'item-title' }, title),
    h('span', { class: 'item-sub' }, hostOf(n.url))),
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
    h('h3', { class: 'group-label' }, h('span', { class: 'group-label-text' }, label, count != null ? h('span', { class: 'count' }, count) : null)),
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

ui.manage.addEventListener('click', () => openInternal('chrome://bookmarks/'));

/* ───────────────────────── Keyboard navigation ───────────────────────── */

// One roving lane across the panel: open tabs → recently closed → bookmarks. Exactly one lane
// element has tabindex=0; arrows move between the rest. Infinite-scroll clones are never in it.
const LANE = '.open-tabs-list .chip-main, .recent-list .chip:not(.is-clone), #body .item:not(.is-disabled)';
const rover = { key: null, bySection: new Map() };
// Focus is only ever moved programmatically while the user is driving the panel with the keyboard,
// so a new tab never pulls focus away from the address bar (or anything else).
const kbd = { active: false };

const laneKey = (el) => el.dataset.key;
const lane = () => [...document.querySelectorAll(LANE)].filter((el) => el.getClientRects().length);
const sections = () => [$('#openTabs'), $('#recent'), ui.body];
const sectionOf = (el) => sections().find((s) => s.contains(el));
const byKey = (key, list = lane()) => (key ? list.find((el) => laneKey(el) === key) : null);

// Instant, not smooth: a smooth scroll is still in flight when the next arrow press lands, which left
// focus on chips scrolled out of view in the Recently closed strip.
function focusEl(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const l = recent.list;
  if (l.contains(el) && l.scrollWidth > l.clientWidth + 8 && l.scrollWidth - l.clientWidth - l.scrollLeft < 240) {
    appendChipSet(l);
  }
}

// The Recently closed strip is two masonry rows scrolling sideways, repeated by clone sets (each row's
// clones stay in that row). Left/right walk along the current row; up/down switch rows. Clones are
// never focused: when the next chip in the row is a clone, it trades places with its original
// (identical width, so nothing moves) and the original takes focus, so the walk keeps going through
// the infinite strip with one focus target per session.
const stripX = (el) => el.getBoundingClientRect().left + recent.list.scrollLeft;
const stripRow = (el) => [...recent.list.children].indexOf(el.closest('.recent-row'));
const stripChips = () => [...recent.list.querySelectorAll('.recent-row > .chip')];

function claimChip(el) {
  if (!el?.classList.contains('is-clone')) return el;
  const orig = stripChips().find((c) => !c.classList.contains('is-clone') && c.dataset.key === el.dataset.key);
  if (!orig) return null;
  const mark = document.createComment('');
  orig.replaceWith(mark);
  el.replaceWith(orig);
  mark.replaceWith(el);
  return orig;
}

const rowChips = (row) => [...(recent.list.children[row]?.children || [])].filter((el) => el.matches('.chip'));

/** Next chip along the same row, or at a row end the first/last session of the neighbouring row. */
function stripStep(cur, step) {
  const row = stripRow(cur);
  const at = rowChips(row).indexOf(cur);
  let next = rowChips(row)[at + step];
  // Rows differ in length, so the shorter one can run out before the strip-wide append in focusEl.
  if (!next && step > 0 && recent.list.querySelector('.is-clone')) {
    appendChipSet(recent.list);
    next = rowChips(row)[at + 1];
  }
  if (next) return next;
  const other = rowChips(row + step).filter((el) => !el.classList.contains('is-clone'));
  return step > 0 ? other[0] || null : other[other.length - 1] || null;
}

function ordered(list) {
  const strip = list.filter((el) => recent.list.contains(el))
    .sort((a, b) => stripRow(a) - stripRow(b) || stripX(a) - stripX(b));
  if (!strip.length) return list;
  const at = list.findIndex((el) => recent.list.contains(el));
  const rest = list.filter((el) => !recent.list.contains(el));
  return [...rest.slice(0, at), ...strip, ...rest.slice(at)];
}

function setRover(el) {
  for (const other of document.querySelectorAll('[data-key][tabindex="0"]')) if (other !== el) other.tabIndex = -1;
  el.tabIndex = 0;
  rover.key = laneKey(el);
  const sec = sectionOf(el);
  if (sec) rover.bySection.set(sec, rover.key);
}

/** Re-apply tabindexes after a re-render; put focus back only if it was already in the lane. */
function refreshLane({ restore = false, fallback = null } = {}) {
  const list = lane();
  for (const el of list) el.tabIndex = -1;
  if (!list.length) return;
  const target = byKey(rover.key, list)
    || (fallback && list.find((el) => fallback.contains(el)))
    || list[0];
  target.tabIndex = 0;
  if (restore && kbd.active) focusEl(target);
}

ui.panel.addEventListener('focusin', (e) => {
  if (e.target.matches?.(LANE)) setRover(e.target);
});

function moveFocus(dir) {
  const list = ordered(lane());
  if (!list.length) return;
  const cur = document.activeElement;
  const idx = list.indexOf(cur);
  if (idx === -1) { focusEl(byKey(rover.key, list) || list[0]); return; }
  const inStrip = recent.list.contains(cur);
  if (dir === 'left' || dir === 'right') {
    const step = dir === 'right' ? 1 : -1;
    const next = inStrip ? claimChip(stripStep(cur, step)) : null;
    if (next) { focusEl(next); return; }
    const after = ordered(lane());
    const at = after.indexOf(cur);
    const strip = after.filter((el) => recent.list.contains(el));
    // Leaving the strip sideways goes to the section before / after it, not to another strip chip.
    const out = inStrip
      ? after[step > 0 ? after.indexOf(strip[strip.length - 1]) + 1 : after.indexOf(strip[0]) - 1]
      : after[at + step];
    focusEl(out);
    return;
  }
  const down = dir === 'down';
  if (inStrip) {
    const row = stripRow(cur) + (down ? 1 : -1);
    const cx = stripX(cur) + cur.offsetWidth / 2;
    const peers = stripChips().filter((el) => stripRow(el) === row);
    if (peers.length) {
      focusEl(claimChip(peers.reduce((a, b) => (Math.abs(stripX(a) + a.offsetWidth / 2 - cx) <= Math.abs(stripX(b) + b.offsetWidth / 2 - cx) ? a : b))));
      return;
    }
  }
  // Otherwise by rows: the nearest visual row above/below wins, then the chip closest in x within it,
  // and rows inside the current section come before any other section (so a short wrapped second row
  // of open tabs is never skipped). Strip chips scrolled out of view are skipped when entering the
  // strip from above or below.
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const sr = recent.list.getBoundingClientRect();
  const inView = (b) => b.right > sr.left && b.left < sr.right;
  const sec = sectionOf(cur);
  const candidates = [...list, ...stripChips().filter((el) => el.classList.contains('is-clone'))];
  const pick = (onlyVisible, scope) => {
    const found = [];
    for (const el of candidates) {
      if (el === cur || el.dataset.key === cur.dataset.key) continue;
      if (!onlyVisible && el.classList.contains('is-clone')) continue;
      if (scope && !scope.contains(el)) continue;
      const b = el.getBoundingClientRect();
      if (onlyVisible && recent.list.contains(el) && !inView(b)) continue;
      const dy = down ? b.top - r.bottom : r.top - b.bottom;
      if (dy >= -2) found.push({ el, b, dy });
    }
    if (!found.length) return null;
    const near = found.reduce((a, c) => (c.dy < a.dy ? c : a));
    const band = near.dy + Math.max(4, near.b.height / 2);
    return found.filter((c) => c.dy <= band)
      .reduce((a, c) => (Math.abs(c.b.left + c.b.width / 2 - cx) < Math.abs(a.b.left + a.b.width / 2 - cx) ? c : a)).el;
  };
  focusEl(claimChip(pick(true, sec) || pick(false, sec) || pick(true) || pick(false)));
}

function focusEdge(end, wholePanel) {
  const list = ordered(lane());
  const cur = document.activeElement;
  const sec = wholePanel || !list.includes(cur) ? null : sectionOf(cur);
  if (sec === recent.el && !end) {
    const first = stripChips().reduce((a, b) => (stripX(b) < stripX(a) - 1 ? b : a));
    focusEl(claimChip(first));
    return;
  }
  const scoped = sec ? list.filter((el) => sec.contains(el)) : list;
  focusEl(end ? scoped[scoped.length - 1] : scoped[0]);
}

function jumpSection(step) {
  const list = lane();
  const live = sections().filter((s) => list.some((el) => s.contains(el)));
  if (!live.length) return;
  const cur = list.includes(document.activeElement) ? live.indexOf(sectionOf(document.activeElement)) : -1;
  const next = live[cur === -1 ? (step > 0 ? 0 : live.length - 1) : (cur + step + live.length) % live.length];
  focusEl(byKey(rover.bySection.get(next), list) || list.find((el) => next.contains(el)));
}

function closeFocusedTab(main) {
  const list = ordered(lane());
  const idx = list.indexOf(main);
  const sec = sectionOf(main);
  const neighbor = [list[idx + 1], list[idx - 1]].find((el) => el && sectionOf(el) === sec) || list[idx + 1] || list[idx - 1];
  const chip = main.closest('.chip-open');
  if (neighbor) focusEl(neighbor);
  chip?.remove();
  if (!openTabs.list.childElementCount) openTabs.el.hidden = true;
  chrome.tabs.remove(Number(main.dataset.tabId)).catch(() => {});
}

addEventListener('pointerdown', () => { kbd.active = false; }, true);

document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const mod = e.metaKey || e.ctrlKey || e.altKey;
  const inPanel = e.target === document.body || ui.panel.contains(e.target);
  if (!inPanel) return;
  kbd.active = true;
  const onLane = e.target.matches?.(LANE);

  if ((e.key === '/' || e.key === '?') && !mod) {
    e.preventDefault();
    jumpSection(e.key === '?' ? -1 : 1);
    return;
  }

  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (arrows[e.key] && !mod) {
    e.preventDefault();
    moveFocus(arrows[e.key]);
    return;
  }
  if ((e.key === 'Home' || e.key === 'End') && !e.altKey) {
    e.preventDefault();
    focusEdge(e.key === 'End', e.metaKey || e.ctrlKey);
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && onLane) {
    if (e.target.classList.contains('chip-main')) {
      e.preventDefault();
      closeFocusedTab(e.target);
      return;
    }
    if (e.target.closest('.recent-list')) {
      e.preventDefault();
      return;
    }
  }

  if ((e.key === 'Backspace' && !mod) || (e.key === 'ArrowLeft' && e.altKey) || (e.key === '[' && (e.metaKey || e.ctrlKey))) {
    if (goUp()) e.preventDefault();
  }
});

/* ───────────────────────── Scroll edge fades ───────────────────────── */

function updateScrollShadows() {
  const b = ui.scroll || ui.body;
  ui.panel.classList.toggle('fade-top', b.scrollTop > 4);
  ui.panel.classList.toggle('fade-bottom', b.scrollTop + b.clientHeight < b.scrollHeight - 4);
}
ui.scroll?.addEventListener('scroll', updateScrollShadows, { passive: true });
ui.body.addEventListener('scroll', updateScrollShadows, { passive: true });
addEventListener('resize', debounce(updateScrollShadows, 100));

/* ───────────────────────── Chip strips (open tabs + recently closed) ───────────────────────── */

const recent = { el: $('#recent'), list: $('#recentList') };
const openTabs = { el: $('#openTabs'), list: $('#openTabsList') };
const OWN_NTP = chrome.runtime.getURL(''); // newtab.html
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
  if (isTab && current?.id != null) chrome.tabs.remove(current.id).catch(() => {});
}

async function goToTab(tabId) {
  const current = await chrome.tabs.getCurrent().catch(() => null);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true });
  if (current?.id != null && current.id !== tabId) chrome.tabs.remove(current.id).catch(() => {});
}

function makeOpenTabChip(t) {
  if (t.id == null) return null;
  const url = t.url || t.pendingUrl || '';
  const isNtp = !url || SKIP_URL(url);
  const title = t.title || (isNtp ? 'New Tab' : hostOf(url)) || 'Tab';
  const tip = isNtp
    ? `${title}\nClick to switch · × or Delete to close`
    : `${title}\n${url}\nClick to switch · × or Delete to close`;
  return h('div', {
    class: 'chip chip-open',
    role: 'listitem',
    title: tip,
  },
  h('button', {
    class: 'chip-main',
    type: 'button',
    dataset: { key: `tab:${t.id}`, tabId: t.id },
    'aria-keyshortcuts': 'Delete',
    onclick: () => goToTab(t.id),
  }, favicon(url || 'chrome://newtab/', 'chip-fav'), h('span', { class: 'chip-text' }, title)),
  h('button', {
    class: 'chip-close',
    type: 'button',
    tabindex: '-1',
    title: 'Close tab',
    onmousedown: (e) => e.preventDefault(),
    'aria-label': `Close ${title}`,
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.remove(t.id).catch(() => {});
    },
  }, '×'));
}

function makeRecentChip(s) {
  if (s.tab) {
    const t = s.tab;
    if (SKIP_URL(t.url) || !t.sessionId) return null;
    const title = t.title || hostOf(t.url);
    return h('button', {
      class: 'chip',
      type: 'button',
      role: 'listitem',
      dataset: { key: `recent:${t.sessionId}` },
      title: `${title}\n${t.url}\nClosed ${timeAgo(s.lastModified)} — click to restore`,
      onclick: () => restore(t.sessionId, true),
    }, favicon(t.url, 'chip-fav'), h('span', { class: 'chip-text' }, title));
  }
  if (s.window) {
    const tabs = (s.window.tabs || []).filter((t) => !SKIP_URL(t.url));
    if (!tabs.length || !s.window.sessionId) return null;
    return h('button', {
      class: 'chip chip-window',
      type: 'button',
      role: 'listitem',
      dataset: { key: `recent:${s.window.sessionId}` },
      title: `Window with ${tabs.length} tabs\n${tabs.slice(0, 6).map((t) => '• ' + (t.title || hostOf(t.url))).join('\n')}\nClosed ${timeAgo(s.lastModified)} — click to restore`,
      onclick: () => restore(s.window.sessionId, false),
    },
    h('span', { class: 'chip-stack' }, tabs.slice(0, 3).map((t) => favicon(t.url, 'chip-fav'))),
    h('span', { class: 'chip-text' }, `Window · ${tabs.length} tabs`));
  }
  return null;
}

function cloneChip(orig) {
  const clone = orig.cloneNode(true);
  clone.classList.add('is-clone');
  clone.tabIndex = -1;
  clone.setAttribute('aria-hidden', 'true');
  clone.addEventListener('click', (e) => {
    e.preventDefault();
    orig.click();
  });
  return clone;
}

function appendChipSet(list) {
  const seeds = list._seedRows;
  if (!seeds?.length) return;
  const rows = [...list.querySelectorAll(':scope > .recent-row')];
  seeds.forEach((seedChips, i) => {
    const row = rows[i];
    if (!row) return;
    seedChips.forEach((orig) => row.appendChild(cloneChip(orig)));
  });
}

function wireChipStripScroll(list) {
  if (list._scrollWired) return;
  list._scrollWired = true;
  list.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (list.scrollWidth <= list.clientWidth + 1) return;
    e.preventDefault();
    list.scrollLeft += e.deltaY;
  }, { passive: false });
  list.addEventListener('scroll', () => {
    const room = list.scrollWidth - list.clientWidth - list.scrollLeft;
    if (room < 240) appendChipSet(list);
  }, { passive: true });
}

/** Pack chips into two rows by shortest width (horizontal masonry). */
function layoutChipMasonry(list, chips) {
  const row0 = h('div', { class: 'recent-row' });
  const row1 = h('div', { class: 'recent-row' });
  list.replaceChildren(row0, row1);
  list.scrollLeft = 0;

  const probe = h('div', { class: 'recent-row chip-measure-probe' });
  document.body.appendChild(probe);
  const widths = chips.map((chip) => {
    probe.replaceChildren(chip.cloneNode(true));
    return probe.getBoundingClientRect().width;
  });
  probe.remove();

  let w0 = 0, w1 = 0;
  const gap = 6;
  chips.forEach((chip, i) => {
    const w = widths[i];
    if (w0 <= w1) {
      row0.appendChild(chip);
      w0 += w + (row0.childElementCount > 1 ? gap : 0);
    } else {
      row1.appendChild(chip);
      w1 += w + (row1.childElementCount > 1 ? gap : 0);
    }
  });
  if (!row1.childElementCount) row1.remove();

  list._seedRows = [...list.querySelectorAll(':scope > .recent-row')].map(
    (row) => [...row.children],
  );

  requestAnimationFrame(() => {
    if (list.scrollWidth <= list.clientWidth + 8) return;
    appendChipSet(list);
  });

  wireChipStripScroll(list);
}


async function loadOpenTabs() {
  const current = await chrome.tabs.getCurrent().catch(() => null);
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
  } catch { /* tabs unavailable */ }
  const chips = [];
  for (const t of tabs) {
    if (current?.id != null && t.id === current.id) continue;
    const chip = makeOpenTabChip(t);
    if (chip) chips.push(chip);
  }
  const hadFocus = openTabs.list.contains(document.activeElement);
  openTabs.el.hidden = chips.length === 0;
  openTabs.list.replaceChildren(...chips);
  refreshLane({ restore: hadFocus, fallback: openTabs.el });
}

async function loadRecent() {
  let sessions = [];
  try {
    sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  } catch { /* sessions unavailable */ }
  const chips = [];
  for (const s of sessions) {
    const chip = makeRecentChip(s);
    if (chip) chips.push(chip);
  }
  const hadFocus = recent.list.contains(document.activeElement);
  recent.el.hidden = chips.length === 0;
  if (!chips.length) {
    recent.list.replaceChildren();
    refreshLane({ restore: hadFocus });
    return;
  }
  layoutChipMasonry(recent.list, chips);
  refreshLane({ restore: hadFocus, fallback: recent.el });
}

const reloadOpenTabs = debounce(loadOpenTabs, 120);
chrome.sessions?.onChanged?.addListener(debounce(loadRecent, 120));
chrome.tabs?.onCreated?.addListener(reloadOpenTabs);
chrome.tabs?.onRemoved?.addListener(reloadOpenTabs);
chrome.tabs?.onUpdated?.addListener(reloadOpenTabs);
chrome.tabs?.onMoved?.addListener(reloadOpenTabs);
chrome.tabs?.onAttached?.addListener(reloadOpenTabs);
chrome.tabs?.onDetached?.addListener(reloadOpenTabs);

/* ───────────────────────── Boot ───────────────────────── */

const boot = { pending: true };

document.documentElement.classList.toggle('is-mac', IS_MAC);

async function start() {
  // Hold aria-busy until bookmarks + open tabs + recently closed are all in the DOM,
  // so the panel doesn't pop in and then jump as sections appear.
  const bookmarks = loadBookmarks().catch((err) => {
    ui.body.replaceChildren(h('div', { class: 'folder-empty' },
      h('p', { class: 'folder-empty-title' }, 'Bookmarks are unavailable'),
      h('p', { class: 'folder-empty-sub' }, String(err?.message || err))));
  });
  await Promise.all([bookmarks, loadOpenTabs(), loadRecent()]);
  boot.pending = false;
  ui.panel.removeAttribute('aria-busy');
  ui.panel.classList.remove('is-booting');
  // Force a reflow, then play rise once content is stable.
  void ui.panel.offsetWidth;
  ui.panel.classList.add('is-ready');
  updateScrollShadows();
}

start();
