const SOURCE_SERVICES = [
  { key: 'spotify',      name: 'Spotify',       icon: '🎧', bg: '#1db954', placeholder: 'https://open.spotify.com/track/...' },
  { key: 'appleMusic',   name: 'Apple Music',   icon: '🍎', bg: '#fc3c44', placeholder: 'https://music.apple.com/us/album/...' },
  { key: 'youtubeMusic', name: 'YouTube Music', icon: '🎵', bg: '#ff0000', placeholder: 'https://music.youtube.com/watch?v=...' },
  { key: 'youtube',      name: 'YouTube',       icon: '▶️',  bg: '#cc0000', placeholder: 'https://www.youtube.com/watch?v=...' },
  { key: 'tidal',        name: 'Tidal',         icon: '🌊', bg: '#008fe8', placeholder: 'https://listen.tidal.com/track/...' },
  { key: 'amazonMusic',  name: 'Amazon Music',  icon: '📦', bg: '#00a8e0', placeholder: 'https://music.amazon.com/albums/...' },
  { key: 'deezer',       name: 'Deezer',        icon: '🎶', bg: '#a238ff', placeholder: 'https://www.deezer.com/track/...' },
  { key: 'soundcloud',   name: 'SoundCloud',    icon: '☁️',  bg: '#ff5500', placeholder: 'https://soundcloud.com/...' },
];

const ALL_PLATFORMS = [
  { key: 'spotify',      name: 'Spotify',       icon: '🎧', bg: '#1db954' },
  { key: 'youtubeMusic', name: 'YouTube Music', icon: '🎵', bg: '#ff0000' },
  { key: 'youtube',      name: 'YouTube',       icon: '▶️',  bg: '#cc0000' },
  { key: 'appleMusic',   name: 'Apple Music',   icon: '🍎', bg: '#fc3c44' },
  { key: 'amazonMusic',  name: 'Amazon Music',  icon: '📦', bg: '#00a8e0' },
  { key: 'tidal',        name: 'Tidal',         icon: '🌊', bg: '#008fe8' },
  { key: 'deezer',       name: 'Deezer',        icon: '🎶', bg: '#a238ff' },
  { key: 'soundcloud',   name: 'SoundCloud',    icon: '☁️',  bg: '#ff5500' },
  { key: 'pandora',      name: 'Pandora',       icon: '📻', bg: '#3668ff' },
  { key: 'napster',      name: 'Napster',       icon: '😼', bg: '#1da0c3' },
];

// Settings persistence
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('sb_settings') || '{}'); }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem('sb_settings', JSON.stringify(s));
}

let settings = loadSettings();
if (!settings.shortlist)               settings.shortlist     = ['youtubeMusic', 'appleMusic', 'amazonMusic'];
if (settings.quickShare === undefined) settings.quickShare    = false;
if (!settings.copyFmt)                 settings.copyFmt       = 'rich';
if (!settings.sourceService)           settings.sourceService = 'spotify';

let currentData = null;
let showingAll  = false;

// DOM refs
const urlInput      = document.getElementById('url-input');
const goBtn         = document.getElementById('go-btn');
const loading       = document.getElementById('loading');
const errorMsg      = document.getElementById('error-msg');
const songCard      = document.getElementById('song-card');
const platformsList = document.getElementById('platforms-list');
const qsBadge       = document.getElementById('qs-badge');
const showAllBtn    = document.getElementById('show-all-btn');
const copyAllWrap   = document.getElementById('copy-all-wrap');
const copyAllBtn    = document.getElementById('copy-all-btn');

function currentSource() {
  return SOURCE_SERVICES.find(s => s.key === settings.sourceService) || SOURCE_SERVICES[0];
}

function updateInputUI() {
  const src = currentSource();
  document.getElementById('source-label').textContent = src.name + ' URL';
  urlInput.placeholder = src.placeholder;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = 'block';
  songCard.style.display = 'none';
  loading.style.display = 'none';
}
function hideAll() {
  errorMsg.style.display = 'none';
  songCard.style.display = 'none';
  loading.style.display = 'none';
}

async function lookup(url) {
  hideAll();
  showingAll = false;
  loading.style.display = 'flex';
  goBtn.disabled = true;
  try {
    const res = await fetch(`/.netlify/functions/lookup?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(res.status);
    currentData = await res.json();
    loading.style.display = 'none';
    renderResult();
  } catch(e) {
    showError(`Couldn't find that song. Make sure it's a valid ${currentSource().name} link.`);
  } finally {
    goBtn.disabled = false;
  }
}

function renderResult() {
  if (!currentData) return;

  const entities = currentData.entitiesByUniqueId || {};
  const firstKey = Object.keys(entities)[0];
  const entity   = firstKey ? entities[firstKey] : null;

  if (entity) {
    document.getElementById('song-title').textContent  = entity.title      || 'Unknown Title';
    document.getElementById('song-artist').textContent = entity.artistName || 'Unknown Artist';
    document.getElementById('album-art').src = entity.thumbnailUrl || '';
  }

  const links = currentData.linksByPlatform || {};

  // Odesli no longer reliably returns YouTube/Apple Music — inject search fallbacks
  if (entity) {
    const q = encodeURIComponent(`${entity.title} ${entity.artistName}`);
    if (!links.youtubeMusic) links.youtubeMusic = { url: `https://music.youtube.com/search?q=${q}` };
    if (!links.youtube)      links.youtube      = { url: `https://www.youtube.com/results?search_query=${q}` };
    if (!links.appleMusic)   links.appleMusic   = { url: `https://music.apple.com/us/search?term=${q}` };
    if (!links.spotify)      links.spotify      = { url: `https://open.spotify.com/search/${q}` };
  }

  // Exclude the source service from results
  const platforms = ALL_PLATFORMS.filter(p => p.key !== settings.sourceService);

  const qs        = settings.quickShare && settings.shortlist.length > 0;
  const available = platforms.filter(p => links[p.key]?.url);
  const toShow    = (qs && !showingAll)
    ? available.filter(p => settings.shortlist.includes(p.key))
    : available;

  qsBadge.classList.toggle('visible', qs);

  const hasHidden = qs && !showingAll && available.length > toShow.length;
  showAllBtn.style.display = (hasHidden || (qs && showingAll)) ? 'block' : 'none';
  showAllBtn.textContent   = showingAll ? 'show shortlist' : `show all (${available.length})`;

  platformsList.innerHTML = '';
  toShow.forEach(({ key, name, icon, bg }, i) => {
    const li = document.createElement('li');
    const a  = document.createElement('a');
    a.href   = links[key].url;
    a.className = 'platform-item';
    a.target = '_blank';
    a.rel    = 'noopener noreferrer';
    a.style.animationDelay = `${i * 35}ms`;

    const iconEl = document.createElement('div');
    iconEl.className = 'platform-icon';
    iconEl.style.background = bg + '22';
    iconEl.textContent = icon;

    const nameEl = document.createElement('span');
    nameEl.className = 'platform-name';
    nameEl.textContent = name;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      try { await navigator.clipboard.writeText(links[key].url); } catch {}
      copyBtn.textContent = 'copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'copy'; copyBtn.classList.remove('copied'); }, 1800);
    });

    const arrow = document.createElement('span');
    arrow.className = 'platform-arrow';
    arrow.textContent = '→';

    a.append(iconEl, nameEl, copyBtn, arrow);
    li.appendChild(a);
    platformsList.appendChild(li);
  });

  if (toShow.length === 0) {
    showError("Found the song but no matching platform links. Try again?");
    return;
  }

  copyAllWrap.style.display = 'block';
  songCard.style.display = 'block';
}

showAllBtn.addEventListener('click', () => {
  showingAll = !showingAll;
  renderResult();
});

copyAllBtn.addEventListener('click', async () => {
  if (!currentData) return;
  const links    = currentData.linksByPlatform || {};
  const entities = currentData.entitiesByUniqueId || {};
  const firstKey = Object.keys(entities)[0];
  const entity   = firstKey ? entities[firstKey] : null;
  const platforms = ALL_PLATFORMS.filter(p => p.key !== settings.sourceService);
  const qs       = settings.quickShare && settings.shortlist.length > 0;
  const available = platforms.filter(p => links[p.key]?.url);
  const toShare  = (qs && !showingAll)
    ? available.filter(p => settings.shortlist.includes(p.key))
    : available;

  let text = '';
  if (settings.copyFmt === 'rich' && entity) {
    text += `\uD83C\uDFB5 ${entity.title} \u2014 ${entity.artistName}\n\n`;
  }
  text += toShare.map(p => `${p.name}: ${links[p.key].url}`).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    copyAllBtn.textContent = '\u2713 Copied!';
    copyAllBtn.classList.add('copied');
    setTimeout(() => { copyAllBtn.textContent = '\u2398 Copy all links'; copyAllBtn.classList.remove('copied'); }, 2000);
  } catch {
    copyAllBtn.textContent = 'Copy failed';
    setTimeout(() => { copyAllBtn.textContent = '\u2398 Copy all links'; }, 2000);
  }
});

goBtn.addEventListener('click', () => {
  const val = urlInput.value.trim();
  if (val) lookup(val);
});
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click(); });

// Android Share Target
const params = new URLSearchParams(window.location.search);
const shared = params.get('url') || params.get('text');
if (shared) {
  const sharedUrl = shared.match(/https?:\/\/[^\s]+/)?.[0] || shared;
  urlInput.value = sharedUrl;
  lookup(sharedUrl);
}

// ── Settings Drawer ──
const overlay  = document.getElementById('settings-overlay');
const drawer   = document.getElementById('settings-drawer');
const qsToggle = document.getElementById('qs-toggle');

function openSettings() {
  syncSettingsUI();
  overlay.classList.add('open');
  drawer.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSettings() {
  overlay.classList.remove('open');
  drawer.classList.remove('open');
  document.body.style.overflow = '';
  saveSettings(settings);
  updateInputUI();
  if (currentData) renderResult();
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('close-settings').addEventListener('click', closeSettings);
overlay.addEventListener('click', closeSettings);

qsToggle.addEventListener('change', () => {
  settings.quickShare = qsToggle.checked;
});

const fmtToggle = document.getElementById('fmt-toggle');
fmtToggle.addEventListener('change', () => {
  settings.copyFmt = fmtToggle.checked ? 'rich' : 'links';
});

function buildSourcePicker() {
  const picker = document.getElementById('source-picker');
  picker.innerHTML = '';
  SOURCE_SERVICES.forEach(({ key, name, icon, bg }) => {
    const item = document.createElement('div');
    item.className = 'source-item' + (settings.sourceService === key ? ' selected' : '');
    item.innerHTML = `
      <div class="check-icon" style="background:${bg}22">${icon}</div>
      <span class="check-name">${name}</span>
      <div class="source-radio"></div>
    `;
    item.addEventListener('click', () => {
      settings.sourceService = key;
      picker.querySelectorAll('.source-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
    });
    picker.appendChild(item);
  });
}

function buildChecklist() {
  const list = document.getElementById('platform-checklist');
  list.innerHTML = '';
  // Show all platforms except the current source in the shortlist
  ALL_PLATFORMS.filter(p => p.key !== settings.sourceService).forEach(({ key, name, icon, bg }) => {
    const item = document.createElement('div');
    item.className = 'platform-check-item' + (settings.shortlist.includes(key) ? ' checked' : '');
    item.innerHTML = `
      <div class="check-icon" style="background:${bg}22">${icon}</div>
      <span class="check-name">${name}</span>
      <div class="checkmark">
        <svg viewBox="0 0 11 11" fill="none" stroke="#0a0a0a" stroke-width="2">
          <polyline points="1.5,5.5 4.5,8.5 9.5,2.5"/>
        </svg>
      </div>
    `;
    item.addEventListener('click', () => {
      const idx = settings.shortlist.indexOf(key);
      if (idx >= 0) { settings.shortlist.splice(idx, 1); item.classList.remove('checked'); }
      else          { settings.shortlist.push(key);      item.classList.add('checked');    }
    });
    list.appendChild(item);
  });
}

function syncSettingsUI() {
  qsToggle.checked = settings.quickShare;
  fmtToggle.checked = settings.copyFmt === 'rich';
  buildSourcePicker();
  buildChecklist();
}

// PWA install
let deferredPrompt;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('install-prompt').style.display = 'block';
});
document.getElementById('install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (outcome === 'accepted') document.getElementById('install-prompt').style.display = 'none';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Init
updateInputUI();
