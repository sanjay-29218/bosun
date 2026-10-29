import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveShortcutCommand } from "../../keybindings";
import { resolveFeaturesShortcut } from "./featuresShortcuts";

class TestElement extends EventTarget {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
  ) {
    super();
  }

  closest() {
    return null;
  }
}

const key = (value: string, target: EventTarget | null, modifiers = false) => ({
  key: value,
  metaKey: false,
  ctrlKey: modifiers,
  shiftKey: modifiers,
  altKey: false,
  target,
});

afterEach(() => vi.unstubAllGlobals());

describe("Board shortcuts", () => {
  it("toggles board filters with letters, but not while typing", () => {
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("navigator", { platform: "Linux" });
    const body = new TestElement("BODY");
    expect(resolveFeaturesShortcut(key("w", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.workflow",
    );
    expect(resolveFeaturesShortcut(key("n", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.needsYou",
    );
    expect(resolveFeaturesShortcut(key("c", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.newTodo",
    );
    expect(
      resolveFeaturesShortcut(key("w", new TestElement("INPUT")), DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBeNull();
    // `/` opens the board's search, but types a slash into a field.
    expect(resolveFeaturesShortcut(key("/", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.search",
    );
    expect(
      resolveFeaturesShortcut(key("/", new TestElement("INPUT")), DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBeNull();
    // The sidebar toggle owns List / Board, so the board no longer takes `l` and `b`.
    expect(resolveFeaturesShortcut(key("b", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
    // Off the board, a bare letter is not a shortcut.
    expect(
      resolveShortcutCommand(key("w", body), DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
    ).toBeNull();
  });

  it("flips List / Board and opens the next item that needs you from anywhere", () => {
    vi.stubGlobal("navigator", { platform: "Linux" });
    expect(
      resolveShortcutCommand(
        { ...key("B", null, true), altKey: true },
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "Linux",
        },
      ),
    ).toBe("board.toggle");
    expect(
      resolveShortcutCommand(key("Y", null, true), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    ).toBe("needsYou.next");
  });
});
