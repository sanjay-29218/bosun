/**
 * Changes to one issue's milestone and parent, one write at a time. A change asked while a write
 * runs merges into the next write, each field's newest value winning, so an older pick can never
 * land after a newer one. Callers merged into one write share its result.
 */
export function createStructureWrites<Change extends object>(
  write: (change: Change) => Promise<boolean>,
) {
  let queued: { change: Change; result: Promise<boolean> } | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return (change: Change): Promise<boolean> => {
    if (queued) {
      queued.change = { ...queued.change, ...change };
      return queued.result;
    }
    const entry: { change: Change; result: Promise<boolean> } = {
      change,
      result: Promise.resolve(false),
    };
    entry.result = tail.then(() => {
      if (queued === entry) queued = null;
      return write(entry.change).catch(() => false);
    });
    queued = entry;
    tail = entry.result;
    return entry.result;
  };
}
