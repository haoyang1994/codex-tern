// omp creates its session file lazily. Persist the native header even before
// the first message so the host can verify and reopen a blank session.
export default function register(pi: {
  on(event: string, fn: (event: unknown, context: {
    sessionManager: { ensureOnDisk(): Promise<void> };
  }) => Promise<void>): void;
}) {
  pi.on('session_start', async (_event, context) => {
    await context.sessionManager.ensureOnDisk();
  });
}
