import { describe, expect, it } from "vite-plus/test";

import { createSerialSaves } from "./descriptionSaves.logic";

/** A host whose writes the test settles in order, recording the texts written. */
function host() {
  const written: string[] = [];
  const pending: Array<(ok: boolean) => void> = [];
  const waiting: Array<() => void> = [];
  const write = (text: string) =>
    new Promise<boolean>((resolve) => {
      written.push(text);
      pending.push(resolve);
      waiting.shift()?.();
    });
  /** Waits until a write is in flight. */
  const started = async () => {
    if (pending.length === 0) await new Promise<void>((resolve) => waiting.push(resolve));
  };
  /** Settles the oldest write once it has started. */
  const settle = async (ok: boolean) => {
    await started();
    pending.shift()!(ok);
  };
  return { written, write, started, settle };
}

describe("createSerialSaves", () => {
  it("writes a newer text only after the one in flight lands", async () => {
    const saves = createSerialSaves("a");
    const { written, write, started, settle } = host();
    const first = saves.save("b", write);
    await started();
    const second = saves.save("c", write);
    expect(written).toEqual(["b"]);
    await settle(true);
    expect(await first).toBe(true);
    await settle(true);
    expect(await second).toBe(true);
    expect(written).toEqual(["b", "c"]);
  });

  it("skips a text a newer one replaced while it waited", async () => {
    const saves = createSerialSaves("a");
    const { written, write, started, settle } = host();
    void saves.save("b", write);
    await started();
    void saves.save("c", write);
    const last = saves.save("d", write);
    await settle(true);
    await settle(true);
    expect(await last).toBe(true);
    expect(written).toEqual(["b", "d"]);
  });

  it("makes a repeat of a failing save wait for it and write again", async () => {
    const saves = createSerialSaves("a");
    const { written, write, settle } = host();
    const first = saves.save("b", write);
    const leaving = saves.save("b", write);
    await settle(false);
    expect(await first).toBe(false);
    await settle(false);
    expect(await leaving).toBe(false);
    expect(written).toEqual(["b", "b"]);
  });

  it("doesn't write a repeat of a save that succeeded", async () => {
    const saves = createSerialSaves("a");
    const { written, write, settle } = host();
    void saves.save("b", write);
    const leaving = saves.save("b", write);
    await settle(true);
    expect(await leaving).toBe(true);
    expect(written).toEqual(["b"]);
  });
});
