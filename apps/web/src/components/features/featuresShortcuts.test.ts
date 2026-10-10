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

describe("Features page shortcuts", () => {
  it("switches views with page letters, but not while typing", () => {
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("navigator", { platform: "Linux" });
    const body = new TestElement("BODY");
    expect(resolveFeaturesShortcut(key("l", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.list",
    );
    expect(resolveFeaturesShortcut(key("b", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.board",
    );
    expect(resolveFeaturesShortcut(key("w", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.workflow",
    );
    expect(resolveFeaturesShortcut(key("n", body), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "features.needsYou",
    );
    expect(
      resolveFeaturesShortcut(key("b", new TestElement("INPUT")), DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBeNull();
    // Off the page, a bare letter is not a shortcut, and Mod+B still toggles the sidebar.
    expect(
      resolveShortcutCommand(key("b", body), DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
    ).toBeNull();
  });

  it("opens the page and the next item that needs you from anywhere", () => {
    vi.stubGlobal("navigator", { platform: "Linux" });
    expect(
      resolveShortcutCommand(key("B", null, true), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    ).toBe("features.open");
    expect(
      resolveShortcutCommand(key("Y", null, true), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    ).toBe("needsYou.next");
  });
});
