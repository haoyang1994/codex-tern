import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Node } from '@stencil-hq/tern';
import { copyToClipboard } from '@oh-my-pi/pi-natives/clipboard';
import { findExecutable } from '../launch';
import { ternControlArgs } from '../tern-plugin';
import { markdownText } from './markdown-text';

const exec = promisify(execFile);

/** Host copies its own selection; never reads/writes the OS clipboard here. */
export async function copyNativeSelection() {
  const tern = findExecutable('tern'); if (!tern) throw Error('Tern selection copying is unavailable.');
  const { stdout } = await exec(tern, ternControlArgs('copy'), { timeout: 3000 });
  if (JSON.parse(stdout).ok !== true) throw Error('Tern could not copy the selected text.');
}

export async function copyPlainText(text: string) {
  if (process.env.CODEX_TERN_CONTROL) {
    // Native selection uses Tern's private clipboard. Capture owner-side
    // writes separately so offscreen tests cannot reach the desktop clipboard.
    const target = process.env.CODEX_TERN_QA_CLIPBOARD_FILE;
    if (!target) throw Error('The offscreen clipboard capture file is unavailable.');
    await writeFile(target, text, { mode: 0o600 });
  } else {
    copyToClipboard(text);
  }
}

/** The host handles selections and literal code/output. Only whole Markdown needs conversion. */
export function transcriptCopyMenus(root: Node, copy: { selection: () => void; text: (text: string) => void },
  language: string): Node {
  const children = root.children.map(n => transcriptCopyMenus(n, copy, language));
  if (!['md', 'code', 'ansi'].includes(root.kind)) return new Node(root.kind, root.props, children, root.handlers);
  const zh = language === 'zh-CN';
  const markdown = root.kind === 'md';
  const actions = (root.props.actions ?? {}) as { menu?: any[]; [key: string]: any };
  const original = actions.menu ?? [];
  const menu = original.filter((item: any) => (typeof item === 'string' ? item : item.id) !== 'copy');
  menu.unshift({ id: markdown ? 'copy-text' : 'copy', label: zh ? '复制' : 'Copy', icon: 'copy' },
    { id: 'copy-selection', label: zh ? '复制选区' : 'Copy selection', icon: 'copy' });
  if (markdown) menu.push({ id: 'copy', label: zh ? '复制整段 Markdown' : 'Copy entire Markdown', icon: 'doc' });
  const source = typeof root.props.text === 'string' ? root.props.text : '';
  const onAction = { ...root.handlers?.onAction, 'copy-selection': copy.selection,
    ...(markdown ? { 'copy-text': () => copy.text(markdownText(source)) } : {}) };
  return new Node(root.kind, { ...root.props, actions: { ...actions, menu } }, children, { ...root.handlers, onAction });
}
