import { describe, expect, it } from "vite-plus/test";

import { parentNow } from "./featureNow.logic";

describe("parentNow", () => {
  it("leads with the parent's own lead asking, even when every child is done", () => {
    expect(parentNow({ status: "needs-input", asks: true }, ["done", "done"])).toEqual({
      headline: "own-asks",
      needYou: 0,
      working: 0,
      review: 0,
      done: 2,
      total: 2,
    });
  });

  it("shows the parent's own work, such as its integration check, once children are done", () => {
    expect(parentNow({ status: "working", asks: false }, ["done", "done"]).headline).toBe(
      "own-working",
    );
  });

  it("counts a child asking the person ahead of work still running", () => {
    expect(
      parentNow({ status: "waiting", asks: false }, ["needs-input", "working", "done"]),
    ).toEqual({
      headline: "children-need-you",
      needYou: 1,
      working: 1,
      review: 0,
      done: 1,
      total: 3,
    });
  });

  it("reads as working while a child runs and the parent's lead waits for it", () => {
    expect(parentNow({ status: "waiting", asks: false }, ["working", "not-started"]).headline).toBe(
      "children-working",
    );
  });

  it("counts a finished child without a merged PR as ready for review, not done", () => {
    expect(parentNow({ status: "waiting", asks: false }, ["review", "done"])).toEqual({
      headline: "own-turn",
      needYou: 0,
      working: 0,
      review: 1,
      done: 1,
      total: 2,
    });
  });

  it("hands the turn back once the children are done and the parent's lead stopped", () => {
    expect(parentNow({ status: "waiting", asks: false }, ["done"]).headline).toBe("own-turn");
    expect(parentNow({ status: "review", asks: false }, ["done"]).headline).toBe("own-turn");
    expect(parentNow({ status: "done", asks: false }, ["done"]).headline).toBe("settled");
  });
});
