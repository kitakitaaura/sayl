// Runs once before qBittorrent starts. Writes the web API login (as a PBKDF2
// hash, the format qBittorrent stores) and the listening port into
// qBittorrent.conf, keeping every other setting qBittorrent saved.
// The backend applies the remaining settings through the API on startup.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** qBittorrent's password format: PBKDF2-HMAC-SHA512, 100000 rounds, 16-byte salt, 64-byte key. */
export function hashPassword(password, salt = randomBytes(16)) {
  const key = pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `@ByteArray(${salt.toString('base64')}:${key.toString('base64')})`;
}

export function verifyPassword(password, stored) {
  const m = /^@ByteArray\(([^:]+):([^)]+)\)$/.exec(stored);
  if (!m) return false;
  const key = pbkdf2Sync(password, Buffer.from(m[1], 'base64'), 100000, 64, 'sha512');
  return key.toString('base64') === m[2];
}

/** Sets keys in an INI file's text, adding sections and keys that are missing. */
export function setIniValues(text, values) {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [section, entries] of Object.entries(values)) {
    let start = lines.findIndex((l) => l.trim() === `[${section}]`);
    if (start === -1) {
      if (lines.length) lines.push('');
      lines.push(`[${section}]`);
      start = lines.length - 1;
    }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l));
    if (end === -1) end = lines.length;
    for (const [key, value] of Object.entries(entries)) {
      const idx = lines.findIndex((l, i) => i > start && i < end && l.includes('=') && l.slice(0, l.indexOf('=')) === key);
      const line = `${key}=${value}`;
      if (idx !== -1) lines[idx] = line;
      else {
        // insert after the last non-blank line of the section
        let at = end;
        while (at > start + 1 && lines[at - 1].trim() === '') at--;
        lines.splice(at, 0, line);
        end++;
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function desiredConfig({ username, password, torrentPort, salt }) {
  return {
    LegalNotice: { Accepted: 'true' },
    BitTorrent: { 'Session\\Port': String(torrentPort) },
    Preferences: {
      'Connection\\PortRangeMin': String(torrentPort),
      'Connection\\UPnP': 'false',
      'WebUI\\Address': '*',
      'WebUI\\Port': '8080',
      'WebUI\\UPnP': 'false',
      'WebUI\\Username': username,
      'WebUI\\Password_PBKDF2': `"${hashPassword(password, salt)}"`,
      'WebUI\\LocalHostAuth': 'true',
      'WebUI\\AuthSubnetWhitelistEnabled': 'false',
      'WebUI\\CSRFProtection': 'true',
      'WebUI\\ClickjackingProtection': 'true',
    },
  };
}

function main() {
  const { QBIT_USERNAME: username, QBIT_PASSWORD: password } = process.env;
  const torrentPort = Number(process.env.TORRENT_PORT || 6881);
  const dir = process.env.QBIT_CONFIG_DIR || '/config/qBittorrent';
  if (!username || !password || password.length < 12) {
    console.error('qbit-init: set QBIT_USERNAME and QBIT_PASSWORD (12+ characters) in .env');
    process.exit(1);
  }
  if (!Number.isInteger(torrentPort) || torrentPort < 1024 || torrentPort > 65535) {
    console.error('qbit-init: TORRENT_PORT must be a number from 1024 to 65535');
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'qBittorrent.conf');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, setIniValues(current, desiredConfig({ username, password, torrentPort })));
  console.log(`qbit-init: wrote ${file} (user ${username}, port ${torrentPort})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
