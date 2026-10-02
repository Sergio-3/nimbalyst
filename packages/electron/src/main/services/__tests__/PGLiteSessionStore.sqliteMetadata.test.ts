// @vitest-environment node
/**
 * updateMetadata's in-SQL merge against a real better-sqlite3 backend, where
 * `metadata || $n` is translated to json_patch. The fake-db tests cannot show
 * that the translated statement actually runs and merges.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';

let tmpDir: string;
let sqlite: SQLiteDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-meta-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterEach(async () => {
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('merges overlapping metadata updates without losing either key', async () => {
  await sqlite.query(
    `INSERT INTO ai_sessions (id, provider, workspace_id, metadata) VALUES ('s1', 'claude-code', '/p', $1)`,
    [JSON.stringify({ tags: ['ai'] })],
  );
  const store = createPGLiteSessionStore(sqlite);
  await Promise.all([
    store.updateMetadata('s1', { metadata: { hasPendingPrompt: true } }),
    store.updateMetadata('s1', { metadata: { tokenUsage: { totalTokens: 5 } } }),
    store.updateMetadata('s1', { metadata: { phase: 'implementing' } }),
  ]);
  const { rows } = await sqlite.query<{ metadata: string }>(`SELECT metadata FROM ai_sessions WHERE id = 's1'`);
  const metadata = JSON.parse(rows[0].metadata);
  expect(metadata).toMatchObject({ tags: ['ai'], hasPendingPrompt: true, tokenUsage: { totalTokens: 5 }, phase: 'implementing' });
  expect(metadata.activity).toHaveLength(1);
});
