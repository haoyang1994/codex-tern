import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { node, type ActionEvent } from '@stencil-hq/tern';
import { transcriptCopyMenus } from '../src/clipboard/copy';
import { markdownText } from '../src/clipboard/markdown-text';

const source = '# Title\n\nAlpha **bold** [Link](https://example.com) and `a*b`.\n' +
  'Next line.\n\n7. First\n   - [x] Nested\n8. Second\n\n```sh\n  # **literal** \\path  \n```';
const expected = 'Title\n\nAlpha bold Link and a*b.\nNext line.\n\n' +
  '7. First\n   • ☑ Nested\n8. Second\n\n  # **literal** \\path  \n';
const event = {} as ActionEvent;

test('whole Markdown copy preserves prose, link labels, lists, line breaks and code literals', () => {
  assert.equal(markdownText(source), expected);
  assert.equal(markdownText('| A | B |\n| - | - |\n| x | y |'), 'A\tB\nx\ty');
  assert.equal(markdownText('Read [the docs][ref] and ![image label](example.png).\n\n[ref]: https://example.com'),
    'Read the docs and image label.');
  assert.equal(markdownText('C++ #include <T> a_b 2 * 3 \\*literal\\*'), 'C++ #include <T> a_b 2 * 3 *literal*');
  assert.equal(markdownText('Running **unfinished\n\n```sh\n  echo "**literal**"  \n'),
    'Running **unfinished\n\n  echo "**literal**"  \n');
  assert.equal(markdownText('1. Example\n\n   ```sh\n     echo "a"  \n     echo "b"\n   ```'),
    '1. Example\n\n  echo "a"  \n  echo "b"\n');
});

test('streaming and completed transcript use the same pure text action and preserve native copy routes', () => {
  for (const stream of [true, false]) {
    let selections = 0, toggles = 0;
    const copied: string[] = [];
    const output = '# **literal**\n[raw](value)  ';
    const before = node('col', {}, [
      node('md', { key: 'answer', text: source, stream, actions: { menu: ['copy', 'other'] }, onAction: {
        other: () => { toggles++; },
      } }),
      node('code', { key: 'command', text: output }),
      node('ansi', { key: 'terminal', text: output }),
      node('button', { key: 'toggle', onClick: () => { toggles++; } }),
    ]);
    const result = transcriptCopyMenus(before, { selection: () => { selections++; }, text: text => { copied.push(text); } }, 'zh-CN');
    const [md, code, ansi, button] = result.children;
    assert.deepEqual(md!.props.actions, { menu: [
      { id: 'copy-text', label: '复制', icon: 'copy' },
      { id: 'copy-selection', label: '复制选区', icon: 'copy' },
      'other',
      { id: 'copy', label: '复制整段 Markdown', icon: 'doc' },
    ] });
    md!.handlers?.onAction?.['copy-text']?.(event);
    md!.handlers?.onAction?.['copy-selection']?.(event);
    md!.handlers?.onAction?.other?.(event);
    button!.handlers?.onClick?.(event);
    assert.deepEqual(copied, [expected]);
    assert.equal(selections, 1);
    assert.equal(toggles, 2);
    assert.equal(md!.handlers?.onAction?.copy, undefined);
    assert.equal(md!.props.key, 'answer');
    assert.equal(md!.props.text, source);
    assert.equal(md!.props.stream, stream);
    for (const literal of [code!, ansi!]) {
      assert.deepEqual(literal.props.actions, { menu: [
        { id: 'copy', label: '复制', icon: 'copy' },
        { id: 'copy-selection', label: '复制选区', icon: 'copy' },
      ] });
      assert.equal(literal.handlers?.onAction?.copy, undefined);
      assert.equal(literal.props.text, output);
    }
  }
});

test('offscreen whole-block copy captures exact text without opening the system clipboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-tern-copy-'));
  const clipboardFile = join(directory, 'clipboard.txt');
  const module = fileURLToPath(new URL('../src/clipboard/copy.ts', import.meta.url));
  try {
    execFileSync(process.execPath, ['--eval',
      `import { copyPlainText } from ${JSON.stringify(module)}; await copyPlainText(${JSON.stringify(expected)});`],
    { env: { ...process.env, CODEX_TERN_CONTROL: join(directory, 'control.sock'), CODEX_TERN_QA_CLIPBOARD_FILE: clipboardFile } });
    assert.equal(await readFile(clipboardFile, 'utf8'), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
