/**
 * Public HTTP(S) trackers asked for every torrent, on top of the torrent's
 * own. Workers have no UDP, so only trackers that answer over HTTP count.
 *
 * The list comes from github.com/ngosang/trackerslist, which checks trackers
 * daily. loadPublicTrackers() fetches the current one; this bundled copy
 * (2026-10-16) is the fallback. Trackers named after piracy sites are left out.
 */

export const BUNDLED_TRACKERS = [
  'http://tracker.opentrackr.org:1337/announce',
  'http://tracker.qu.ax:6969/announce',
  'http://tracker2.dler.org:80/announce',
  'http://tracker.dler.org:6969/announce',
  'http://tracker.dler.com:6969/announce',
  'http://tracker.renfei.net:8080/announce',
  'http://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce',
  'http://t.overflow.biz:6969/announce',
  'http://004430.xyz:80/announce',
  'http://ipv4announce.sktorrent.eu:6969/announce',
  'http://tracker.mywaifu.best:6969/announce',
  'http://tr.nyacat.pw:80/announce',
  'http://tracker.waaa.moe:6969/announce',
  'http://tracker.dhitechnical.com:6969/announce',
  'http://open.tracker.cl:1337/announce',
  'http://tracker.zhuqiy.dgj055.icu:80/announce',
  'http://1337.abcvg.info:80/announce',
  'https://tracker.pmman.tech:443/announce',
  'https://tracker.nekomi.cn:443/announce',
  'https://004430.xyz:443/announce',
  'https://tr.nyacat.pw:443/announce',
  'https://tracker.7471.top:443/announce',
  'https://tracker.zhuqiy.com:443/announce',
  'https://open.ftorrent.com:443/announce',
  'https://t.213891.xyz:443/announce',
];

const LISTS = [
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_http.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_https.txt',
];
const LEFT_OUT = /pirat|rarbg/i;
let cached = null;

/** The current list (fetched once per page load), or the bundled one if that fails. */
export function loadPublicTrackers({ timeoutMs = 5000 } = {}) {
  cached ??= (async () => {
    try {
      const texts = await Promise.all(
        LISTS.map(async (url) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) throw new Error(`${res.status}`);
          return res.text();
        }),
      );
      const urls = texts
        .flatMap((t) => t.split(/\s+/))
        .filter((u) => /^https?:\/\/[^\s/]+\/\S*announce/.test(u) && !LEFT_OUT.test(u));
      return urls.length >= 5 ? [...new Set(urls)] : BUNDLED_TRACKERS;
    } catch {
      return BUNDLED_TRACKERS;
    }
  })();
  return cached;
}
