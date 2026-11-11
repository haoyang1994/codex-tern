import { existsSync } from 'node:fs';
import type { SlashCommand } from '@oh-my-pi/pi-tui/autocomplete';
import { translate, type Language } from './i18n';

export const commands = [
  { name: 'exit', aliases: ['quit'], description: 'Exit client' },
  { name: 'help', description: 'Show help' },
  { name: 'new', description: 'New session' },
  { name: 'resume', description: 'Resume session', argumentHint: '[ID]', allowArgs: true },
  { name: 'model', description: 'Select model', argumentHint: '[ID]', allowArgs: true },
  { name: 'status', description: 'Session details' },
  { name: 'stop', description: 'Stop current turn' },
  { name: 'language', description: 'Interface language', argumentHint: '[en|zh-CN]', allowArgs: true },
  { name: 'skills', description: 'Skills', argumentHint: '[search]', allowArgs: true },
  ...['reconnect', 'threads', 'next', 'unconfirmed'].map(name => ({ name, description: name, plainOnly: true })),
  ...['queue', 'reply', 'sent', 'retry'].map(name => ({ name, description: name, allowArgs: true, plainOnly: true })),
];
export function commandCompletions(language: Language = 'en'): SlashCommand[] {
  return commands.filter(c => !('plainOnly' in c)).map(c => ({ ...c, description: translate(language, c.description) }));
}
export function commandHelp(plain = false, language: Language = 'en') {
  return commands.filter(c => plain || !('plainOnly' in c)).map(c =>
    `/${c.name}${'aliases' in c ? ' · /quit' : ''}${'argumentHint' in c ? ' ' + c.argumentHint : ''} — ${translate(language, c.description)}`).join('\n');
}
export type ParsedCommand = { kind: 'text' } | { kind: 'error'; message: string }
  | { kind: 'command'; name: string; args: string };
/** Only a complete single-line command in the message composer is executable. */
export function parseCommand(text: string, images: readonly string[] = [], plain = false): ParsedCommand {
  if (images.length || /[\r\n]/.test(text)) return { kind: 'text' };
  const match = /^\/([a-z][a-z0-9-]*)(?:[ \t](.*))?$/i.exec(text.trimStart());
  if (!match) return { kind: 'text' };
  const token = match[1]!, args = token === 'queue' ? match[2] ?? '' : match[2]?.trim() ?? '';
  const command = commands.find(c => c.name === token || ('aliases' in c && c.aliases?.includes(token)));
  if (!command) return existsSync('/' + token) ? { kind: 'text' }
    : { kind: 'error', message: `Unknown command: /${token}` };
  if ('plainOnly' in command && !plain) return { kind: 'error', message: `Command available in --plain: /${token}` };
  if (args && !('allowArgs' in command && command.allowArgs))
    return { kind: 'error', message: `Usage: /${command.name}` };
  return { kind: 'command', name: command.name, args };
}
