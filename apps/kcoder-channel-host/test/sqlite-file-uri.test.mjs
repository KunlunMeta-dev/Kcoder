import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existingSqliteFileUri } from '../src/sqlite-file-uri.mjs';

for (const namespaced of process.platform === 'win32' ? [false, true] : [false]) {
  test(`existing SQLite opens preserve path bytes and no-create modes (${namespaced ? 'extended' : 'ordinary'})`, t => {
    const root = mkdtempSync(join(tmpdir(), 'kcoder-sqlite-uri-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const parent = join(root, ...(process.platform === 'win32' ? Array(24).fill('中文 空格😀') : []), 'literal # % + & =');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const path = value => namespaced ? toNamespacedPath(value) : value;
    const file = path(join(parent, '数据 # % + & = 😀.sqlite3'));
    if (process.platform === 'win32') assert.ok(file.length > 260);
    writeFileSync(file, '', { mode: 0o600 });
    const writer = new DatabaseSync(existingSqliteFileUri(file, 'rw'));
    try {
      writer.exec('CREATE TABLE owned(value TEXT)');
      writer.prepare('INSERT INTO owned VALUES(?)').run('original-中文-😀-#%+&=');
    } finally { writer.close(); }
    const reader = new DatabaseSync(existingSqliteFileUri(file, 'ro'), { readOnly: true });
    try {
      assert.equal(reader.prepare('SELECT value FROM owned').get().value, 'original-中文-😀-#%+&=');
      assert.throws(() => reader.exec("INSERT INTO owned VALUES('denied')"), error => (error.errcode & 255) === 8);
    } finally { reader.close(); }
    const reopened = new DatabaseSync(existingSqliteFileUri(file, 'rw'));
    try {
      reopened.prepare('INSERT INTO owned VALUES(?)').run('current');
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM owned').get().count, 2);
    } finally { reopened.close(); }
    for (const mode of ['ro', 'rw']) {
      const missing = path(join(parent, `missing ${mode} # % + & =.sqlite3`));
      assert.throws(() => {
        const unexpected = new DatabaseSync(existingSqliteFileUri(missing, mode), { readOnly: mode === 'ro' });
        unexpected.close();
      }, error => (error.errcode & 255) === 14);
      assert.equal(existsSync(missing), false);
    }
  });
}
