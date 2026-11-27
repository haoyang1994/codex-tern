import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function findExecutable(name: string): string | undefined {
  const paths = isAbsolute(name) || /[/\\]/.test(name) ? [resolve(name)]
    : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, name));
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const path of paths) for (const ext of extensions) {
    try {
      accessSync(path + ext, constants.X_OK);
      if (statSync(path + ext).isFile()) return path + ext;
    } catch { /* Try the next PATH entry. */ }
  }
}

export async function openTern(client: string, args: string[], cwd: string, independent = false) {
  return openTernCommand([process.execPath, client, ...args], cwd, independent);
}

function hasTernWindow(tern: string) {
  const result = spawnSync(tern, ['inspect', '--json'], { encoding: 'utf8', timeout: 3000 });
  if (result.error) throw result.error;
  if (result.status !== 0) return false;
  const { clients } = JSON.parse(result.stdout);
  if (!Array.isArray(clients)) throw new Error('Tern did not report its window list.');
  return clients.some(client => client && client.kind && client.kind !== 'cli' && typeof client.window === 'string');
}

export async function openTernCommand(command: string[], cwd: string, independent = false) {
  const tern = findExecutable('tern');
  if (!tern) throw new Error('Tern was not found on PATH. Install Tern and enable its tern command, then try again. Use --plain for a text client.');
  // A live daemon alone answers `ls`. Only a window can reveal a chat.
  const running = independent ? hasTernWindow(tern)
    : spawnSync(tern, ['ls', '--json'], { stdio: 'ignore', timeout: 3000 }).status === 0;
  const child = spawn(tern, running ? ['new', 'tab', '--cwd', cwd, '--', ...command]
    : ['-e', ...command], { cwd, stdio: independent ? 'ignore' : 'inherit', detached: independent });
  if (independent) child.unref();
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Tern exited with signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

/** Reveal this native client's existing pane, including when invoked elsewhere. */
export async function focusClient() {
  const tern = findExecutable('tern');
  if (!tern) throw new Error('Tern was not found on PATH.');
  // Tern exports the pane ID to its shell. This stays valid even while
  // another process owns the terminal foreground group.
  const ownPane = process.env.TERN_PANE;
  if (ownPane && /^[1-9][0-9]*$/.test(ownPane)) {
    await exec(tern, ['focus', ownPane], { timeout: 3000 });
    return;
  }
  const state = JSON.parse((await exec(tern, ['ls', '--json'], { timeout: 3000 })).stdout);
  const panes: any[] = (state.sessions ?? []).flatMap((s: any) => s.tabs.flatMap((t: any) => t.blocks));
  const matches = await Promise.all(panes.map(async pane => {
    try {
      const result = JSON.parse((await exec(tern, ['process', String(pane.id), '--json'], { timeout: 3000 })).stdout);
      return result.foreground?.pid === process.pid ? pane.id as number : undefined;
    } catch { return undefined; }
  }));
  const pane = matches.find(id => id !== undefined);
  if (pane === undefined) throw new Error('The project is open, but its Tern pane could not be located.');
  await exec(tern, ['focus', String(pane)], { timeout: 3000 });
}
