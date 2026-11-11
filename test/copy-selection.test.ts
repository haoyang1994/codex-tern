import { test } from 'node:test';
import assert from 'node:assert/strict';
import { node } from '@stencil-hq/tern';
import { selectionCopyMenus } from '../src/clipboard/copy';

test('ordinary Copy calls selection route, explicit block copy keeps native source action and existing handlers survive', () => {
  let copies = 0, toggles = 0;
  const before = node('col', {}, [node('md', { key: 'answer', text: 'Alpha selection Omega', actions: { menu: ['copy'] } }),
    node('code', { key: 'command', text: 'echo example' }), node('button', { key: 'toggle', onClick: () => { toggles++; } })]);
  const result = selectionCopyMenus(before, () => { copies++; }, 'zh-CN');
  const md = result.children[0]!;
  assert.deepEqual((md.props.actions as any).menu.map((m: any) => [m.id, m.label]),
    [['copy-selection', '复制'], ['copy', '复制整段 Markdown']]);
  md.handlers?.onAction?.['copy-selection']?.({} as any); assert.equal(copies, 1);
  assert.equal(md.handlers?.onAction?.copy, undefined, 'explicit block copy remains a host action');
  result.children[2]!.handlers?.onClick?.({} as any); assert.equal(toggles, 1);
  assert.equal(result.children[0]!.props.key, 'answer'); assert.equal(result.children[0]!.props.text, 'Alpha selection Omega');
});
