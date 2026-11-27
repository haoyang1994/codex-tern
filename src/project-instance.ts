import { NATIVE_ABI_VERSION } from './native-abi';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IpcConnection, IpcServer, ipcEndpoint } from '@oh-my-pi/pi-natives';
import { validPromptAnchor } from './prompt-anchor';
import type { PromptAnchor } from './prompt-anchor';

export interface ProjectCommand { version: 1; signature: string; agent?: 'omp'; cwd?: string; resume?: string; prompt?: string; promptAnchor?: PromptAnchor }
export type ProjectReply = { ompId?: string };
export interface ProjectInstance { close(): Promise<void> }

/** Keep compatible rebuilds reusable, but never attach a new CLI to an older ABI. */
export function projectSignature(codex: string, config: readonly string[]) {
  return JSON.stringify([codex, config, { nativeAbi: NATIVE_ABI_VERSION }]);
}

const legacySettingsError = 'This project is already open with different settings. Exit its client before changing the backend settings.';
const incompatibleProjectError = 'This project is already open with different settings or an incompatible host/UI ABI. '
  + 'Finish its tasks, then exit that codex-tern client normally with Ctrl+Q. '
  + 'From the original workspace, use codex-tern resume THREAD_ID to reopen the same saved session without a prompt. '
  + 'This request was rejected before processing; no prompt was sent to Codex.';


export async function projectRoot(cwd: string) {
  const original = await realpath(cwd);
  let directory = original;
  while (true) {
    try { await stat(join(directory, '.git')); return directory; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) return original;
    directory = parent;
  }
}

export async function projectAddress(cwd: string, namespace?: string) {
  const config = process.env.TERN_CONFIG_DIR ?? (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Tern')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tern'));
  const profile = namespace ?? process.env.TERN_DAEMON_SOCKET ?? join(config, 'daemon.sock');
  const key = createHash('sha256').update(JSON.stringify([await projectRoot(cwd), resolve(profile),
    resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))])).digest('hex').slice(0, 28);
  return ipcEndpoint(`/tmp/codex-tern-${process.getuid?.() ?? 'user'}`, key);
}

function code(error: unknown) { return (error as NodeJS.ErrnoException).code ?? String(error).match(/\b(E[A-Z]+):/)?.[1]; }

/** A lost reply must never cause a second submission of the same task. */
export async function contactProject(address: string, command: ProjectCommand, receive?: (reply: ProjectReply) => void): Promise<boolean> {
  let connection: IpcConnection;
  try { connection = await IpcConnection.connect(address, { framing: 'lines', timeoutMs: 1000, maxFrameBytes: 1024 * 1024 }); }
  catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(code(error) ?? '')) return false; throw error; }
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); connection.destroy();
      if (error) reject(error); else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error('The project did not reply. The request may have been accepted; nothing was resent.')), 45000);
    connection.start(line => {
      try {
        const reply = JSON.parse(line);
        if (reply.ok) receive?.(reply);
        finish(reply.ok ? undefined : new Error(reply.error === legacySettingsError
          ? incompatibleProjectError : reply.error ?? 'Could not open the project'));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }, () => { if (!finished) finish(new Error('The project closed before replying. Check it before submitting again.')); });
    connection.send(JSON.stringify(command));
  });
}

/** Native binding atomically replaces stale sockets and checks peer ownership. */
export async function serveProject(address: string, command: ProjectCommand,
  handle: (command: ProjectCommand) => Promise<ProjectReply | void>, receive?: (reply: ProjectReply) => void): Promise<ProjectInstance | null> {
  const connections = new Set<IpcConnection>();
  let queue = Promise.resolve();
  let server: IpcServer;
  try {
    server = await IpcServer.listen(address, { framing: 'lines', maxFrameBytes: 1024 * 1024 }, connection => {
      connections.add(connection);
      let accepted = false;
      const timer = setTimeout(() => connection.destroy(), 60000);
      const reply = (error?: unknown, result?: ProjectReply | void) => {
        connection.send(JSON.stringify(error ? { ok: false, error: error instanceof Error ? error.message : String(error) } : { ok: true, ...result }));
        connection.end();
      };
      connection.start(line => {
        if (accepted) return;
        accepted = true;
        let request: ProjectCommand;
        try {
          request = JSON.parse(line);
          const omp = request.agent === 'omp' && typeof request.cwd === 'string'
            && !request.promptAnchor && request.prompt === undefined;
          if (request.version !== 1 || (!omp && (request.agent !== undefined || request.signature !== command.signature))
            || (request.resume !== undefined && typeof request.resume !== 'string')
            || (request.promptAnchor !== undefined && (!validPromptAnchor(request.promptAnchor) || request.promptAnchor.threadId!==request.resume))
            || (request.prompt !== undefined && typeof request.prompt !== 'string'))
            throw new Error(incompatibleProjectError);
        } catch (error) { reply(error); return; }
        const work = queue.then(() => handle(request));
        queue = work.then(() => {}, () => {});
        void work.then(result => reply(undefined, result), reply);
      }, () => { clearTimeout(timer); connections.delete(connection); });
    });
  } catch (error) {
    if (code(error) === 'EADDRINUSE' && await contactProject(address, command, receive)) return null;
    throw error;
  }
  return { close: async () => {
    await server.close();
    for (const connection of connections) connection.destroy();
  } };
}
