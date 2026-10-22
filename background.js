// Bookmark hotkeys: slot N = the Nth link (folders skipped) on the Bookmarks bar.
async function slot(n) {
  const [root] = await chrome.bookmarks.getTree();
  const bar = root.children.find(c => c.id === '1') || root.children[0];
  const links = (bar?.children || []).filter(b => b.url && !/^javascript:/i.test(b.url));
  return links[n - 1];
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'blank') {
    const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (t) await chrome.tabs.update(t.id, { url: 'chrome://newtab/' });
    return;
  }
  const m = /^(open|new)-(\d)$/.exec(command);
  if (!m) return;
  const bm = await slot(Number(m[2]));
  if (!bm) return;
  if (m[1] === 'new') {
    await chrome.tabs.create({ url: bm.url, index: tab ? tab.index + 1 : undefined });
  } else {
    const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (target) await chrome.tabs.update(target.id, { url: bm.url });
    else await chrome.tabs.create({ url: bm.url });
  }
});

// ONE-TIME: reorder start of Bookmarks bar (remove after it has run)
chrome.runtime.onInstalled.addListener(async () => {
  const order = [
    u => /^javascript:/i.test(u),
    u => u === 'https://mail.google.com/mail/u/0/',
    u => u.startsWith('https://mail.google.com/mail/u/1/'),
    u => u.startsWith('https://mail.google.com/mail/u/2/'),
    u => u === 'https://www.youtube.com/',
    u => u === 'https://www.messenger.com/',
    u => u === 'https://maps.google.com/',
  ];
  const [bar] = await chrome.bookmarks.getChildren('0').then(r => r.filter(n => n.id === '1'));
  if (!bar) return;
  const kids = await chrome.bookmarks.getChildren('1');
  for (let i = 0; i < order.length; i++) {
    const bm = kids.find(k => k.url && order[i](k.url));
    if (bm) await chrome.bookmarks.move(bm.id, { parentId: '1', index: i });
  }
});
