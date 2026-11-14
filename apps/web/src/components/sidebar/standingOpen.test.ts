import { describe, expect, it } from "vite-plus/test";

import { latestStandingOpen, supersedeStandingOpen } from "./standingOpen";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("latestStandingOpen", () => {
  it("drops an open that finishes after a later one began", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const projectManager = latestStandingOpen(first.promise);
    const headquarters = latestStandingOpen(second.promise);
    second.resolve("bot B");
    expect(await headquarters).toEqual({ value: "bot B" });
    first.resolve("PM A");
    expect(await projectManager).toBeNull();
  });

  it("drops an open superseded by a pick that opens nothing", async () => {
    const pending = deferred<string>();
    const open = latestStandingOpen(pending.promise);
    supersedeStandingOpen();
    pending.resolve("PM A");
    expect(await open).toBeNull();
  });

  it("keeps the only open", async () => {
    expect(await latestStandingOpen(Promise.resolve("PM A"))).toEqual({ value: "PM A" });
  });
});
