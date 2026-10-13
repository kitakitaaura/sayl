import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { desiredConfig, hashPassword, setIniValues, verifyPassword } from '../../deploy/qbit-init/init.mjs';

describe('qbit-init', () => {
  it("hashes passwords in qBittorrent's PBKDF2 format", () => {
    const stored = hashPassword('correct horse battery', Buffer.alloc(16, 7));
    expect(stored).toMatch(/^@ByteArray\([A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]{88}\)$/);
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('updates existing keys and keeps everything else', () => {
    const before = ['[BitTorrent]', 'Session\\Port=6881', 'Session\\QueueingSystemEnabled=true', '', '[Preferences]', 'WebUI\\Address=*', 'Other=1', ''].join('\n');
    const after = setIniValues(before, { BitTorrent: { 'Session\\Port': '51413' }, Preferences: { 'WebUI\\Address': '*', 'WebUI\\Username': 'sayl' } });
    expect(after).toBe(
      ['[BitTorrent]', 'Session\\Port=51413', 'Session\\QueueingSystemEnabled=true', '', '[Preferences]', 'WebUI\\Address=*', 'Other=1', 'WebUI\\Username=sayl', ''].join('\n'),
    );
  });

  it('creates missing sections in an empty file', () => {
    expect(setIniValues('', { LegalNotice: { Accepted: 'true' } })).toBe('[LegalNotice]\nAccepted=true\n');
  });

  it('only matches whole keys', () => {
    const after = setIniValues('[P]\nWebUI\\Port=1\nWebUI\\PortX=2\n', { P: { 'WebUI\\Port': '8080' } });
    expect(after).toBe('[P]\nWebUI\\Port=8080\nWebUI\\PortX=2\n');
  });

  it('writes the login, port and legal notice', () => {
    const c = desiredConfig({ username: 'sayl', password: 'correct horse battery', torrentPort: 51413, salt: Buffer.alloc(16, 1) });
    expect(c.LegalNotice.Accepted).toBe('true');
    expect(c.BitTorrent['Session\\Port']).toBe('51413');
    expect(c.Preferences['WebUI\\Username']).toBe('sayl');
    expect(c.Preferences['WebUI\\Password_PBKDF2']).toMatch(/^"@ByteArray\(.+\)"$/);
  });
});
