import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Preferences } from '../src/preferences';
import { translate } from '../src/i18n';

test('language persists across restart and model writes preserve it across preference instances', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-language-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'preferences.json');
  await writeFile(path, JSON.stringify({ version: 1, defaultModel: 'existing' }));
  const first = new Preferences(path), second = new Preferences(path);
  await first.load(); await second.load();
  assert.equal(first.language, 'en');
  await first.setLanguage('zh-CN');
  await second.setModel('changed');
  const restarted = new Preferences(path); await restarted.load();
  assert.equal(restarted.language, 'zh-CN'); assert.equal(restarted.model, 'changed');
  await restarted.setLanguage('en'); await restarted.setModel();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.language, 'en'); assert.equal(saved.defaultModel, undefined);
});

test('invalid language and failed persistence leave the saved preference intact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-language-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'preferences.json');
  const prefs = new Preferences(path); await prefs.setLanguage('zh-CN');
  const original = await readFile(path, 'utf8');
  await assert.rejects(prefs.setLanguage('invalid' as never));
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(prefs.language, 'zh-CN');
});

test('UI catalog preserves English and unknown text, and interpolates values without rewriting them', () => {
  assert.equal(translate('en', 'New session'), 'New session');
  assert.equal(translate('zh-CN', 'New session'), '新建会话');
  assert.equal(translate('zh-CN', 'Archive session'), '归档会话');
  assert.equal(translate('zh-CN', 'Directory: /tmp/New session'), '目录：/tmp/New session');
  assert.equal(translate('zh-CN', 'Your answer: Working…'), '你的回答：Working…');
  assert.equal(translate('zh-CN', 'custom user text 中文'), 'custom user text 中文');
});
