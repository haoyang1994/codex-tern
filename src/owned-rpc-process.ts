import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Only an object returned by this spawn may authorize signalling its own group.
const owned = new WeakMap<ChildProcessWithoutNullStreams, { group?: number; closing?: Promise<void> }>();
export function spawnOwnedRpcChild(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(binary, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  owned.set(child, { group: child.pid });
  return child;
}
export function closeOwnedRpcChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const owner = owned.get(child);
  if (!owner) return Promise.reject(new Error('Refusing to stop an unowned app-server process group'));
  if (owner.closing) return owner.closing;
  owner.closing = (async () => {
    if (!owner.group) return;
    const signal = (value: NodeJS.Signals | 0) => {
      try { process.kill(-owner.group!, value); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if(value===0 && (error as NodeJS.ErrnoException).code==='EPERM') return null; throw error; }
    };
    const gone = async (milliseconds: number) => {
      const deadline = Date.now() + milliseconds;
      while (signal(0)!==false) { if (Date.now() >= deadline) return false; await delay(25); }
      return true;
    };
    const initial = signal(0);
    if (initial === false) return;
    if (initial === null) {
      if (await gone(2000)) return;
      throw new Error('App-server group visibility is unconfirmed; no extra signal was sent');
    }
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    // Allow native EOF shutdown before escalating, including after a wrapper exits.
    if (await gone(1500)) return;
    signal('SIGTERM'); if (await gone(1500)) return;
    if (signal(0) === true) signal('SIGKILL');
    if (await gone(2000)) return;
    throw new Error('App-server process group exit is unconfirmed; its session writer may still be held');
  })();
  owner.closing.catch(() => {});
  return owner.closing;
}
