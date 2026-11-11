import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Node } from '@stencil-hq/tern';
import { findExecutable } from '../launch';
import { ternControlArgs } from '../tern-plugin';

const exec = promisify(execFile);

/** Host copies its own selection; never reads/writes the OS clipboard here. */
export async function copyNativeSelection() {
  const tern = findExecutable('tern'); if (!tern) throw Error('Tern selection copying is unavailable.');
  const { stdout } = await exec(tern, ternControlArgs('copy'), { timeout: 3000 });
  if (JSON.parse(stdout).ok !== true) throw Error('Tern could not copy the selected text.');
}

/** Built-in node `copy` is whole-source copy. Give it an explicit label while
 * routing ordinary Copy through the native pane-selection action instead. */
export function selectionCopyMenus(root: Node, copy: () => void, language: string): Node {
  const children = root.children.map(n => selectionCopyMenus(n, copy, language));
  if (!['md', 'code', 'ansi'].includes(root.kind)) return new Node(root.kind, root.props, children, root.handlers);
  const zh = language === 'zh-CN';
  const actions = (root.props.actions ?? {}) as { menu?: any[]; [key: string]: any };
  const original = actions.menu ?? [];
  const menu = original.filter((item: any) => (typeof item === 'string' ? item : item.id) !== 'copy');
  menu.unshift({ id: 'copy-selection', label: zh ? '复制' : 'Copy', icon: 'copy' });
  menu.push({ id: 'copy', label: root.kind === 'md' ? (zh ? '复制整段 Markdown' : 'Copy entire Markdown')
    : (zh ? '复制全部代码/输出' : 'Copy all code/output'), icon: 'doc' });
  return new Node(root.kind, { ...root.props, actions: { ...actions, menu } }, children,
    { ...root.handlers, onAction: { ...root.handlers?.onAction, 'copy-selection': copy } });
}
