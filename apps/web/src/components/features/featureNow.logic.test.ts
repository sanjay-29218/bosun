import { describe, expect, it } from "vite-plus/test";

import { parentNow } from "./featureNow.logic";

describe("parentNow", () => {
  it("leads with the parent's own lead asking, even when every child is done", () => {
    expect(parentNow({ column: "needs-you", asks: true }, ["done", "done"])).toEqual({
      headline: "own-asks",
      needYou: 0,
      working: 0,
      done: 2,
      total: 2,
    });
  });

  it("shows the parent's own work, such as its integration check, once children are done", () => {
    expect(parentNow({ column: "working", asks: false }, ["done", "done"]).headline).toBe(
      "own-working",
    );
  });

  it("counts a child whose lead stopped as needing you, ahead of work still running", () => {
    expect(
      parentNow({ column: "needs-you", asks: false }, ["needs-you", "working", "done"]),
    ).toEqual({ headline: "children-need-you", needYou: 1, working: 1, done: 1, total: 3 });
  });

  it("reads as working while a child runs and the parent's lead waits for it", () => {
    expect(parentNow({ column: "needs-you", asks: false }, ["working", "todo"]).headline).toBe(
      "children-working",
    );
  });

  it("hands the turn back once the children are done and the parent's lead stopped", () => {
    expect(parentNow({ column: "needs-you", asks: false }, ["done"]).headline).toBe("own-turn");
    expect(parentNow({ column: "done", asks: false }, ["done"]).headline).toBe("settled");
  });
});
