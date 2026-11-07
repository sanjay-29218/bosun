/**
 * Saves a description one write at a time, in the order asked. The host's copy only counts once a
 * write succeeds, so a save asked while another is in flight waits for it and then writes again
 * if that one failed. A text replaced by a newer one while it waited is skipped.
 */
export function createSerialSaves(initial: string) {
  let acknowledged = initial;
  let latest = initial;
  let tail: Promise<boolean> = Promise.resolve(true);
  return {
    /** Starts editing from `text`, which the host already has. */
    reset(text: string) {
      acknowledged = text;
      latest = text;
    },
    save(text: string, write: (text: string) => Promise<boolean>): Promise<boolean> {
      latest = text;
      const run = tail.then(async () => {
        if (text === acknowledged || text !== latest) return true;
        const ok = await write(text).catch(() => false);
        if (ok) acknowledged = text;
        return ok;
      });
      tail = run;
      return run;
    },
  };
}
