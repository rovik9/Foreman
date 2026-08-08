/**
 * One command at a time per workspace directory.
 *
 * Parallel builders share a run's workspace, and the verifier's gates run in
 * that same directory. Two `npm install`s — or an install racing `npx tsc` —
 * corrupt the lockfile and produce failures that look like the model's fault
 * but aren't. Everything that shells out into a workspace goes through here.
 */

const locks = new Map<string, Promise<unknown>>();

export function withWorkspaceLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(workspace) ?? Promise.resolve();
  const next = prior.then(fn, fn);

  // Keep the queue alive past a rejection, and drop the entry once this is the
  // last waiter — otherwise the map grows by one dead promise per run forever.
  const release = (): void => {
    if (locks.get(workspace) === chain) locks.delete(workspace);
  };
  const chain: Promise<void> = next.then(release, release);
  locks.set(workspace, chain);

  return next;
}

/** Test-only visibility into the queue, so the leak fix stays honest. */
export function pendingWorkspaceLocks(): number {
  return locks.size;
}
