import { Download } from './client/download.js';
import { parseMagnet, parseTorrentFile } from './client/torrent.js';
import { fetchTurnServers } from './client/turn.js';

const $ = (id) => document.getElementById(id);
const log = (line) => {
  $('log').textContent += `${line}\n`;
  $('log').scrollTop = $('log').scrollHeight;
};
const MEMORY_LIMIT = 1024 * 1024 * 1024;

try {
  $('token').value = new URLSearchParams(location.search).get('token') ?? localStorage.getItem('relay-token') ?? '';
} catch {}

let current = null;

$('start').addEventListener('click', async () => {
  if (current) {
    current.stop('stopped by you');
    return;
  }
  try {
    let source;
    const file = $('file').files[0];
    if (file) source = await parseTorrentFile(new Uint8Array(await file.arrayBuffer()));
    else source = parseMagnet($('source').value.trim());

    const token = $('token').value.trim();
    try {
      localStorage.setItem('relay-token', token);
    } catch {}
    const testOnly = $('mode').value === 'test';
    const sink = testOnly ? {} : await makeSink(source.info?.name ?? source.name ?? 'download');

    $('log').textContent = '';
    const relay = { url: location.origin, via: $('via').value, session: randomId(), token };
    const d = new Download({
      relay,
      source,
      sink,
      maxPeers: Number($('peers').value) || 40,
      limitBytes: testOnly ? Number($('limit').value) * 1e6 : Infinity,
      dht: { getTurn: () => fetchTurnServers(relay) },
      log,
    });
    current = d;
    $('start').textContent = 'Stop';
    log(`info hash ${source.infoHash} · relay via ${relay.via}`);
    d.onprogress = (p) => {
      $('fill').style.width = `${(p.fraction * 100).toFixed(1)}%`;
      $('status').textContent = p.hasMetadata
        ? `${(p.fraction * 100).toFixed(1)}% · ${(p.bytesPerSecond / 1e6).toFixed(2)} MB/s · ${p.peersConnected} connected, ${p.peersUnchoked} sending, ${p.peersKnown} known`
        : `getting metadata · ${p.peersConnected} connected, ${p.peersKnown} known`;
    };
    const summary = await d.start();
    $('status').textContent = summary.complete ? 'done' : summary.stopReason;
    log('\nsummary (paste this back):');
    log(JSON.stringify({ ...summary, browser: navigator.userAgent }, null, 2));
  } catch (err) {
    $('status').innerHTML = '';
    const span = document.createElement('span');
    span.className = 'bad';
    span.textContent = err.message;
    $('status').append(span);
  } finally {
    current = null;
    $('start').textContent = 'Start';
  }
});

/** Writes straight to a file on disk where the browser allows it (Chrome, Edge), otherwise to memory. */
async function makeSink(name) {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    let writable;
    return {
      async open(info) {
        writable = await handle.createWritable();
        await writable.truncate(info.length);
      },
      write: (offset, bytes) => writable.write({ type: 'write', position: offset, data: bytes }),
      close: () => writable?.close(),
    };
  }
  let buf;
  let info;
  let written = 0;
  return {
    open(i) {
      if (i.length > MEMORY_LIMIT) throw new Error('this browser can only save files up to 1 GB here; use Chrome or Edge for bigger ones');
      info = i;
      buf = new Uint8Array(i.length);
    },
    write(offset, bytes) {
      buf.set(bytes, offset);
      written += bytes.length; // each piece is written once, after its hash checks out
    },
    close() {
      if (!buf || written !== info.length) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf]));
      a.download = info.files.length === 1 ? info.name : `${info.name}.bin`;
      a.click();
    },
  };
}

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('');
}
