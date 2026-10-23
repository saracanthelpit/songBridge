// Resolves a song link from one service into links for every other service.
//
// Odesli (song.link) retired its keyless public API in 2026, so this no longer
// depends on a single aggregator. Instead it:
//   1. reads title / artist / artwork from the source service's own public
//      endpoints (oEmbed, iTunes lookup, Deezer API, or the page's meta tags)
//   2. finds direct links on Apple Music and Deezer via their free search APIs
//   3. falls back to a search link for every other platform

const TIMEOUT_MS = 4000;
const UA = 'Mozilla/5.0 (compatible; SongBridge/1.0; +https://songbridge.netlify.app)';

const SEARCH_URLS = {
  spotify:      q => `https://open.spotify.com/search/${q}`,
  youtubeMusic: q => `https://music.youtube.com/search?q=${q}`,
  youtube:      q => `https://www.youtube.com/results?search_query=${q}`,
  appleMusic:   q => `https://music.apple.com/us/search?term=${q}`,
  amazonMusic:  q => `https://music.amazon.com/search/${q}`,
  tidal:        q => `https://listen.tidal.com/search?q=${q}`,
  deezer:       q => `https://www.deezer.com/search/${q}`,
  soundcloud:   q => `https://soundcloud.com/search/sounds?q=${q}`,
  pandora:      q => `https://www.pandora.com/search/${q}/all`,
};

class LookupError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── HTTP helpers ──

async function get(url, accept) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LookupError(502, 'upstream_unreachable', `Could not reach ${new URL(url).host}`);
  }
  if (res.status === 404 || res.status === 400) {
    throw new LookupError(404, 'not_found', 'Song not found');
  }
  if (!res.ok) {
    throw new LookupError(502, 'upstream_error', `${new URL(url).host} returned ${res.status}`);
  }
  return res;
}

const getJson = async url => (await get(url, 'application/json')).json();
const getHtml = async url => (await get(url, 'text/html')).text();

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function metaTag(html, name) {
  // Matches <meta property="x" content="y"> and <meta content="y" name="x"> in either order
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]*>|<meta[^>]+content=["'][^"']*["'][^>]+(?:property|name)=["']${name}["'][^>]*>`,
    'i'
  );
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() : null;
}

function titleTag(html) {
  const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  return t ? decodeEntities(t).trim() : null;
}

// ── Text cleanup ──

const NOISE = /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|4k|remaster(ed)?|mv|clip)\b[^)\]]*[)\]]/gi;

function cleanChannel(name = '') {
  return name.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*Official$/i, '').trim();
}

function normalize(s = '') {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Splits "Song by Artist" when the artist is known or the pattern is unambiguous
function splitBy(title, artist) {
  if (artist) {
    const suffix = ` by ${artist}`;
    if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
      return { title: title.slice(0, -suffix.length).trim(), artist };
    }
    return { title, artist };
  }
  const m = title.match(/^(.*) by ([^]+)$/);
  return m ? { title: m[1].trim(), artist: m[2].trim() } : { title, artist: null };
}

// ── Source detection ──

function detectSource(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');

  if (host === 'open.spotify.com' || host === 'spotify.link') return { key: 'spotify', u };
  if (host === 'music.youtube.com') return { key: 'youtubeMusic', u };
  if (host === 'youtube.com' || host === 'youtu.be') return { key: 'youtube', u };
  if (host === 'music.apple.com' || host === 'itunes.apple.com') return { key: 'appleMusic', u };
  if (host === 'tidal.com' || host === 'listen.tidal.com') return { key: 'tidal', u };
  if (host.startsWith('music.amazon.') || host === 'amazon.com') return { key: 'amazonMusic', u };
  if (host === 'deezer.com' || host === 'deezer.page.link' || host === 'link.deezer.com') return { key: 'deezer', u };
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return { key: 'soundcloud', u };
  return null;
}

// ── Per-service metadata resolvers ──
// Each returns { title, artist, thumbnailUrl, directUrl? }

async function fromSpotify(u) {
  // The track page carries the artist in its meta tags; oEmbed only has the title
  const html = await getHtml(u.href);
  const title = metaTag(html, 'og:title');
  if (!title) throw new LookupError(404, 'not_found', 'No song info on Spotify page');

  let artist = metaTag(html, 'music:musician_description');
  if (!artist) {
    // og:description looks like "Rick Astley · Whenever You Need Somebody · Song · 1987"
    artist = metaTag(html, 'og:description')?.split(' · ')[0] || null;
  }
  if (!artist) {
    // <title> looks like "Never Gonna Give You Up - song and lyrics by Rick Astley | Spotify"
    artist = titleTag(html)?.match(/\bby (.+?) \| Spotify/i)?.[1] || null;
  }
  return { title, artist, thumbnailUrl: metaTag(html, 'og:image') };
}

function youtubeId(u) {
  if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1).split('/')[0];
  if (u.searchParams.get('v')) return u.searchParams.get('v');
  return u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/)?.[1] || null;
}

async function fromYouTube(u) {
  const id = youtubeId(u);
  if (!id) throw new LookupError(400, 'unsupported_url', 'No video id in YouTube link');

  const data = await getJson(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`
  );
  const channel = cleanChannel(data.author_name);
  let title = (data.title || '').replace(NOISE, '').trim();
  let artist = channel || null;

  // Music videos are usually titled "Artist - Song"
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    artist = dash[1].trim();
    title = dash[2].trim();
  }
  return { title, artist, thumbnailUrl: data.thumbnail_url };
}

async function fromAppleMusic(u) {
  const country = u.pathname.match(/^\/([a-z]{2})\//)?.[1] || 'us';
  const id = u.searchParams.get('i')
    || u.pathname.match(/\/song\/(?:[^/]+\/)?(\d+)/)?.[1]
    || u.pathname.match(/\/album\/(?:[^/]+\/)?(\d+)/)?.[1];
  if (!id) throw new LookupError(400, 'unsupported_url', 'No id in Apple Music link');

  const data = await getJson(`https://itunes.apple.com/lookup?id=${id}&country=${country}`);
  const item = data.results?.[0];
  if (!item) throw new LookupError(404, 'not_found', 'Apple Music id not found');
  return {
    title: item.trackName || item.collectionName,
    artist: item.artistName,
    thumbnailUrl: item.artworkUrl100?.replace('100x100', '600x600'),
  };
}

async function fromDeezer(u) {
  let id = u.pathname.match(/\/track\/(\d+)/)?.[1];
  if (!id) {
    // Short share links redirect to the full track URL
    const res = await get(u.href, 'text/html');
    id = new URL(res.url).pathname.match(/\/track\/(\d+)/)?.[1];
  }
  if (!id) throw new LookupError(400, 'unsupported_url', 'No track id in Deezer link');

  const data = await getJson(`https://api.deezer.com/track/${id}`);
  if (data.error || !data.title) throw new LookupError(404, 'not_found', 'Deezer track not found');
  return { title: data.title, artist: data.artist?.name, thumbnailUrl: data.album?.cover_xl };
}

async function fromSoundCloud(u) {
  const data = await getJson(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u.href)}`);
  // oEmbed titles look like "Never Gonna Give You Up by Rick Astley"
  const { title, artist } = splitBy(data.title || '', data.author_name);
  return { title, artist, thumbnailUrl: data.thumbnail_url };
}

// Tidal, Amazon Music and anything else: best effort from the page's meta tags
async function fromPageMeta(u) {
  const html = await getHtml(u.href);
  const raw = metaTag(html, 'og:title') || titleTag(html);
  if (!raw) throw new LookupError(404, 'not_found', 'No song info on page');

  const cleaned = raw.replace(/\s+(on|\|)\s+(TIDAL|Amazon Music).*$/i, '').trim();
  let { title, artist } = splitBy(cleaned, null);
  if (!artist) {
    const dash = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dash) {
      title = dash[2].trim();
      artist = dash[1].trim();
    }
  }
  return { title, artist, thumbnailUrl: metaTag(html, 'og:image') };
}

const RESOLVERS = {
  spotify: fromSpotify,
  youtubeMusic: fromYouTube,
  youtube: fromYouTube,
  appleMusic: fromAppleMusic,
  deezer: fromDeezer,
  soundcloud: fromSoundCloud,
  tidal: fromPageMeta,
  amazonMusic: fromPageMeta,
};

// ── Direct-link finders (free, keyless search APIs) ──

function artistMatches(found, wanted) {
  if (!wanted) return true;
  const a = normalize(found), b = normalize(wanted);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function findAppleMusic(title, artist) {
  const term = encodeURIComponent(`${title} ${artist || ''}`.trim());
  const data = await getJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=5&country=US`);
  const hit = (data.results || []).find(r => artistMatches(r.artistName, artist));
  return hit?.trackViewUrl?.replace(/[?&]uo=\d+/, '') || null;
}

async function findDeezer(title, artist) {
  const q = artist ? `artist:"${artist}" track:"${title}"` : title;
  const data = await getJson(`https://api.deezer.com/search?limit=5&q=${encodeURIComponent(q)}`);
  const hit = (data.data || []).find(r => artistMatches(r.artist?.name, artist));
  return hit?.link || null;
}

const DIRECT_FINDERS = { appleMusic: findAppleMusic, deezer: findDeezer };

// ── Handler ──

async function resolve(rawUrl) {
  const source = detectSource(rawUrl);
  if (!source) throw new LookupError(400, 'unsupported_url', 'Not a link from a supported music service');

  const meta = await RESOLVERS[source.key](source.u);
  if (!meta.title) throw new LookupError(404, 'not_found', 'Could not read song title');

  const q = encodeURIComponent([meta.title, meta.artist].filter(Boolean).join(' '));
  const linksByPlatform = {};
  for (const [key, build] of Object.entries(SEARCH_URLS)) {
    linksByPlatform[key] = { url: build(q), search: true };
  }
  linksByPlatform[source.key] = { url: source.u.href, search: false };

  // Direct links are a bonus — a failed search just leaves the search link in place
  await Promise.all(
    Object.entries(DIRECT_FINDERS)
      .filter(([key]) => key !== source.key)
      .map(async ([key, find]) => {
        try {
          const url = await find(meta.title, meta.artist);
          if (url) linksByPlatform[key] = { url, search: false };
        } catch {}
      })
  );

  return {
    source: source.key,
    song: {
      title: meta.title,
      artistName: meta.artist || null,
      thumbnailUrl: meta.thumbnailUrl || null,
    },
    linksByPlatform,
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const url = event.queryStringParameters?.url;
  if (!url) return respond(400, { error: 'missing_url', message: 'Missing url parameter' });

  try {
    return respond(200, await resolve(url.trim()));
  } catch (err) {
    if (err instanceof LookupError) {
      return respond(err.status, { error: err.code, message: err.message });
    }
    console.error(err);
    return respond(500, { error: 'internal', message: 'Lookup failed' });
  }
};

// Exposed for tests
exports._internal = { detectSource, resolve, metaTag, splitBy };
