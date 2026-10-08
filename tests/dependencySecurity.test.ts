import Database from 'better-sqlite3';
import extract from '@electron-internal/extract-zip';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercise the same CommonJS -> ESM boundary used by electron-builder.
const get = createRequire(import.meta.url)('@electron/get') as typeof import('@electron/get');

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Small stored ZIP fixtures let the real native extractor reject unsafe paths.
// No third-party writer sanitizes the adversarial entry before it reaches it.
function zip(entries: Array<{ name: string; content: string; mode?: number }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc32(content), 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, content);
    central.push(record, name);
    offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe('supported desktop dependency security boundaries', () => {
  let root: string;
  let server: http.Server | undefined;
  let database: Database.Database | undefined;
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-dependency-security-')));
  });
  afterEach(async () => {
    database?.close();
    database = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-dependency-security-')) {
      throw new Error('DEPENDENCY_FIXTURE_BOUNDARY_CHANGED');
    }
    const link = path.join(root, 'extracted', 'link');
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function download(body: Buffer, checksum: string) {
    server = http.createServer((_request, response) => { response.end(body); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return get.downloadArtifact({ version: '44.6.0', isGeneric: true, artifactName: 'fixture.zip',
      cacheRoot: path.join(root, 'cache'), tempDirectory: root, cacheMode: get.ElectronDownloadCacheMode.Bypass,
      checksums: { 'fixture.zip': checksum }, downloadOptions: { quiet: true },
      mirrorOptions: { resolveAssetURL: async () => `http://127.0.0.1:${address.port}/fixture.zip` } });
  }

  it('keeps checksum verification through the builder CommonJS download API', async () => {
    const body = zip([{ name: 'electron-fixture.txt', content: 'verified distribution fixture' }]);
    const file = await download(body, createHash('sha256').update(body).digest('hex'));
    expect(fs.readFileSync(file)).toEqual(body);
  });

  it('rejects altered archive bytes before they can be extracted', async () => {
    const expected = zip([{ name: 'file.txt', content: 'expected bytes' }]);
    const altered = zip([{ name: 'file.txt', content: 'altered bytes' }]);
    await expect(download(altered, createHash('sha256').update(expected).digest('hex'))).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'file.txt'))).toBe(false);
  });

  async function unzip(entries: Parameters<typeof zip>[0]) {
    const archive = path.join(root, 'archive.zip');
    fs.writeFileSync(archive, zip(entries));
    return extract(archive, { dir: path.join(root, 'extracted') });
  }

  it('extracts an ordinary verified-distribution ZIP with the real native extractor', async () => {
    await unzip([{ name: 'resources/fixture.txt', content: 'native extraction fixture' }]);
    expect(fs.readFileSync(path.join(root, 'extracted', 'resources', 'fixture.txt'), 'utf8')).toBe('native extraction fixture');
  });

  it('rejects ZIP parent traversal without overwriting the outside sentinel', async () => {
    const sentinel = path.join(root, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep');
    await expect(unzip([{ name: '../sentinel.txt', content: 'unexpected overwrite' }])).rejects.toThrow();
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  it('contains an absolute ZIP entry whether normalized or rejected by the platform extractor', async () => {
    const sentinel = path.join(root, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep');
    await unzip([{ name: sentinel.replace(/\\/g, '/'), content: 'contained fixture' }]).catch(() => {});
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
    const output = path.join(root, 'extracted');
    const verify = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        expect(fs.realpathSync.native(file).startsWith(output + path.sep)).toBe(true);
        if (entry.isDirectory()) verify(file);
      }
    };
    if (fs.existsSync(output)) verify(output);
  });

  it('rejects extraction through a pre-existing directory symlink or Windows junction', async () => {
    const outside = path.join(root, 'outside');
    const output = path.join(root, 'extracted');
    fs.mkdirSync(outside);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
    fs.symlinkSync(outside, path.join(output, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(unzip([{ name: 'link/sentinel.txt', content: 'unexpected overwrite' }])).rejects.toThrow();
    expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('rejects an escaping archive symlink before publishing an outside file', async () => {
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'sentinel.txt'), 'keep');
    await expect(unzip([{ name: 'link', content: '../outside', mode: 0o120777 },
      { name: 'link/sentinel.txt', content: 'unexpected overwrite' }])).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, 'outside', 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('loads the N-API SQLite binary and retains rollback and cross-realm parameter binding after reopen', () => {
    const file = path.join(root, 'state.sqlite');
    database = new Database(file);
    database.pragma('journal_mode=WAL');
    database.exec('CREATE TABLE durable (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = database.prepare('INSERT INTO durable VALUES (@id, @value)');
    expect(() => database!.transaction(() => {
      insert.run(runInNewContext('({id: 1, value: "cross-realm fixture"})'));
      insert.run({ id: 1, value: 'duplicate' });
    })()).toThrow();
    expect(database.prepare('SELECT COUNT(*) AS count FROM durable').get()).toEqual({ count: 0 });
    insert.run(runInNewContext('({id: 2, value: "persisted fixture"})'));
    database.close();
    database = new Database(file);
    expect(database.prepare('SELECT * FROM durable').all()).toEqual([{ id: 2, value: 'persisted fixture' }]);
    expect(database.pragma('quick_check', { simple: true })).toBe('ok');
  });
});
