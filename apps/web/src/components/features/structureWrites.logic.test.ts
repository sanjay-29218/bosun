import { describe, expect, it } from "vite-plus/test";

import { createStructureWrites } from "./structureWrites.logic";

type Change = { readonly milestone?: number | null; readonly parent?: number | null };

/** A host whose writes the test settles in order, recording each change written. */
function host() {
  const written: Change[] = [];
  const pending: Array<(ok: boolean) => void> = [];
  const waiting: Array<() => void> = [];
  const write = (change: Change) =>
    new Promise<boolean>((resolve) => {
      written.push(change);
      pending.push(resolve);
      waiting.shift()?.();
    });
  const started = async () => {
    if (pending.length === 0) await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const settle = async (ok: boolean) => {
    await started();
    pending.shift()!(ok);
  };
  return { written, write, started, settle };
}

describe("createStructureWrites", () => {
  it("writes a newer parent only after the one in flight, so the newest pick lands last", async () => {
    const { written, write, started, settle } = host();
    const edit = createStructureWrites(write);
    const first = edit({ parent: 48 });
    await started();
    const second = edit({ parent: 50 });
    expect(written).toEqual([{ parent: 48 }]);
    await settle(true);
    await settle(true);
    expect([await first, await second]).toEqual([true, true]);
    expect(written).toEqual([{ parent: 48 }, { parent: 50 }]);
  });

  it("merges changes asked while a write runs, newest value of each field winning", async () => {
    const { written, write, started, settle } = host();
    const edit = createStructureWrites(write);
    void edit({ parent: 48 });
    await started();
    const second = edit({ parent: 50, milestone: 8 });
    const third = edit({ parent: null });
    expect(third).toBe(second);
    await settle(false);
    await settle(true);
    expect(await third).toBe(true);
    expect(written).toEqual([{ parent: 48 }, { parent: null, milestone: 8 }]);
  });
});
