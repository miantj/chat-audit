import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupExportArtifacts,
  cleanupTargetListByDayArtifacts,
  exportArtifactPaths
} from './cleanup-export-artifacts.mjs';

test('exportArtifactPaths lists json sidecar files', () => {
  const paths = exportArtifactPaths('/tmp/out/chat-audit-target-list-2026-05-31.json');
  assert.ok(paths.includes('/tmp/out/chat-audit-target-list-2026-05-31.jsonl'));
  assert.ok(paths.includes('/tmp/out/chat-audit-target-list-2026-05-31.checkpoint.json'));
  assert.ok(paths.includes('/tmp/out/chat-audit-target-list-2026-05-31.business.csv') === false);
});

test('cleanupExportArtifacts removes json artifacts but keeps business csv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-audit-cleanup-'));
  const base = path.join(dir, 'sample.json');
  const csv = path.join(dir, 'sample.business.csv');
  fs.writeFileSync(base, '{}');
  fs.writeFileSync(`${base.replace(/\.json$/, '')}.jsonl`, '{}');
  fs.writeFileSync(`${base.replace(/\.json$/, '')}.checkpoint.json`, '{}');
  fs.writeFileSync(csv, 'conversation_id\n');

  const prev = process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
  delete process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
  try {
    const { removed } = cleanupExportArtifacts(base);
    assert.equal(removed.length, 3);
    assert.equal(fs.existsSync(base), false);
    assert.equal(fs.existsSync(csv), true);
  } finally {
    if (prev === undefined) delete process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
    else process.env.CHAT_AUDIT_KEEP_EXPORT_JSON = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupExportArtifacts removes export-done marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-audit-cleanup-done-'));
  const base = path.join(dir, 'sample.json');
  const done = path.join(dir, 'sample.export-done');
  const csv = path.join(dir, 'sample.business.csv');
  fs.writeFileSync(base, '{}');
  fs.writeFileSync(done, '{}');
  fs.writeFileSync(csv, 'conversation_id\n');

  const prev = process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
  delete process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
  try {
    cleanupExportArtifacts(base);
    assert.equal(fs.existsSync(base), false);
    assert.equal(fs.existsSync(done), false);
    assert.equal(fs.existsSync(csv), true);
  } finally {
    if (prev === undefined) delete process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
    else process.env.CHAT_AUDIT_KEEP_EXPORT_JSON = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupTargetListByDayArtifacts cleans daily and merged json only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-audit-cleanup-day-'));
  const basename = 'chat-audit-target-list';
  const days = ['2026-05-31', '2026-06-01'];
  for (const day of days) {
    const json = path.join(dir, `${basename}-${day}.json`);
    fs.writeFileSync(json, '{}');
    fs.writeFileSync(json.replace(/\.json$/, '.jsonl'), '{}');
    fs.writeFileSync(json.replace(/\.json$/, '.export-done'), '{}');
    fs.writeFileSync(json.replace(/\.json$/, '.business.csv'), 'h\n');
  }
  const merged = path.join(dir, `${basename}-merged.json`);
  fs.writeFileSync(merged, '{}');
  fs.writeFileSync(merged.replace(/\.json$/, '.business.csv'), 'h\n');

  const prev = process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
  delete process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
  try {
    cleanupTargetListByDayArtifacts({ outDir: dir, basename, dates: days });
    assert.equal(fs.existsSync(merged), false);
    for (const day of days) {
      assert.equal(fs.existsSync(path.join(dir, `${basename}-${day}.json`)), false);
      assert.equal(
        fs.existsSync(path.join(dir, `${basename}-${day}.export-done`)),
        false
      );
      assert.equal(
        fs.existsSync(path.join(dir, `${basename}-${day}.business.csv`)),
        true
      );
    }
    assert.equal(fs.existsSync(path.join(dir, `${basename}-merged.business.csv`)), true);
  } finally {
    if (prev === undefined) delete process.env.CHAT_AUDIT_KEEP_EXPORT_JSON;
    else process.env.CHAT_AUDIT_KEEP_EXPORT_JSON = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
