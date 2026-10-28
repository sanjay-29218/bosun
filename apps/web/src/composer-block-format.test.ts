import { describe, expect, it } from "vite-plus/test";

import { toggleMarkdownBlockFormat } from "./composer-block-format";
import { buildTiptapContent } from "./composer-rich-text-doc";

const caret = (position: number) => ({ start: position, end: position });

describe("toggleMarkdownBlockFormat", () => {
  it("turns the caret's line into a list item and keeps the caret on its text", () => {
    expect(toggleMarkdownBlockFormat("intro\nreview code\nend", caret(9), "bulletList")).toEqual({
      value: "intro\n- review code\nend",
      selection: caret(11),
    });
  });

  it("numbers each non-empty selected line", () => {
    const value = "first\n\nsecond\nthird";
    expect(
      toggleMarkdownBlockFormat(value, { start: 0, end: value.length }, "orderedList").value,
    ).toBe("1. first\n\n2. second\n3. third");
  });

  it("removes the format when every selected line already has it", () => {
    const value = "- [ ] one\n- [x] two";
    expect(toggleMarkdownBlockFormat(value, { start: 2, end: value.length }, "taskList")).toEqual({
      value: "one\ntwo",
      selection: { start: 0, end: 7 },
    });
  });

  it("replaces another block prefix instead of stacking it", () => {
    expect(toggleMarkdownBlockFormat("  - nested", caret(6), "taskList").value).toBe(
      "  - [ ] nested",
    );
    expect(toggleMarkdownBlockFormat("1. step", caret(5), "heading").value).toBe("## step");
    expect(toggleMarkdownBlockFormat("### title", caret(6), "heading").value).toBe("title");
  });

  it("gives an empty line the prefix so typing continues in the new block", () => {
    expect(toggleMarkdownBlockFormat("", caret(0), "bulletList")).toEqual({
      value: "- ",
      selection: caret(2),
    });
  });

  it("does not exclude a line the selection only touches at its start", () => {
    expect(toggleMarkdownBlockFormat("a\nb", { start: 0, end: 2 }, "bulletList").value).toBe(
      "- a\nb",
    );
  });

  it("leaves code untouched by line formats", () => {
    const value = "```\nconst a = 1;\n```";
    expect(toggleMarkdownBlockFormat(value, caret(6), "bulletList").value).toBe(value);
  });

  it("wraps selected lines in a fence and unwraps them again", () => {
    const wrapped = toggleMarkdownBlockFormat("run\nnpm test\nthen", caret(6), "codeBlock");
    expect(wrapped).toEqual({ value: "run\n```\nnpm test\n```\nthen", selection: caret(10) });
    expect(toggleMarkdownBlockFormat(wrapped.value, wrapped.selection, "codeBlock")).toEqual({
      value: "run\nnpm test\nthen",
      selection: caret(6),
    });
  });

  it("does not nest a fence inside a partly selected code block", () => {
    const value = "intro\n```\ncode\n```";
    expect(toggleMarkdownBlockFormat(value, { start: 0, end: 12 }, "codeBlock").value).toBe(value);
  });
});

describe("buildTiptapContent without chips", () => {
  it("keeps mentions, links, and skills as text while styling Markdown", () => {
    const content = buildTiptapContent(
      "Ask @reviewer and $deploy, see [doc](a.md) **now**",
      () => ({
        label: "deploy",
        description: null,
      }),
      { chips: false },
    );
    expect(JSON.stringify(content)).not.toContain("composer-");
    expect(content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Ask @reviewer and $deploy, see [doc](a.md) " },
          { type: "text", text: "now", marks: [{ type: "bold" }] },
        ],
      },
    ]);
  });
});
