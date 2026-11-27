import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findExecutable } from './launch';

const exec = promisify(execFile);

/** An explicit endpoint lets isolated offscreen clients keep all inspection local. */
export function ternControlArgs(command: string) {
  return ['ctl', ...(process.env.CODEX_TERN_CONTROL ? ['--control', process.env.CODEX_TERN_CONTROL] : []), command];
}

export async function runPluginCommand(command: 'setup' | 'sessions' | 'reload' | 'reading-position' | 'new-session') {
  const tern = findExecutable('tern');
  if (!tern) throw new Error('Tern was not found on PATH.');
  if (command === 'setup') {
    const plugin = fileURLToPath(new URL('../tern-plugin/', import.meta.url));
    const result = await exec(tern, ['plugin', 'link', plugin], { timeout: 15_000 });
    if (result.stdout.trim()) console.log(result.stdout.trim());
    console.log('Installed the Tern commands: Codex: Sessions, Codex: Session TOC and Codex: Reload Window');
  } else {
    try {
      const result = await exec(tern, ternControlArgs(`plugins run plugin.codex-tern.${command}`), { timeout: 15_000 });
      const reply = JSON.parse(result.stdout);
      if (!reply.ok) throw new Error(reply.error ?? 'Tern could not run the Codex window command.');
    } catch (error) {
      if (command === 'new-session') throw new Error('Could not open the session engine picker. Run codex-tern setup to enable it in Tern.');
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nRun codex-tern setup once, then use Codex: ${command === 'reload' ? 'Reload Window' : 'Sessions'} in a Tern window with this client open.`);
    }
  }
}
