import { describe, expect, it } from "vite-plus/test";

import { lastMessageLine, truncate } from "./String.ts";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("hello", 50)).toBe("hello");
  });

  it("cuts by Unicode code point so emoji stay whole", () => {
    expect(truncate("👍👍👍", 5)).toBe("👍👍👍");
    expect(truncate("👍👍👍👍", 3)).toBe("👍👍👍...");
  });

  it("trims before measuring", () => {
    expect(truncate("  hello  ", 5)).toBe("hello");
  });
});

describe("lastMessageLine", () => {
  it("takes the last line with words, past fences and rules", () => {
    expect(lastMessageLine("First\n\nSecond line\n```\n\n---\n")).toBe("Second line");
  });

  it("strips leading markdown markers and collapses whitespace", () => {
    expect(lastMessageLine("## Done:   shipped\tit")).toBe("Done: shipped it");
    expect(lastMessageLine("> - [x] merged #12")).toBe("merged #12");
    expect(lastMessageLine("3. Third step")).toBe("Third step");
    expect(lastMessageLine("- **Shipped** `fix`")).toBe("Shipped fix");
  });

  it("caps at 160 characters", () => {
    const line = lastMessageLine("a".repeat(400));
    expect(Array.from(line)).toHaveLength(160);
    expect(line.endsWith("…")).toBe(true);
  });

  it("is empty when nothing has words", () => {
    expect(lastMessageLine("\n```\n  \n")).toBe("");
  });
});
