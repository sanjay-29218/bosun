/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A role's fallback model saves, survives a reload, and clears back to the Settings fallback",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.open("/settings/roles?new=role");
    await screen.getByRole("textbox", "Name", { exact: true }).fill("Fallback reviewer");
    await screen.getByRole("textbox", "Instructions", { exact: true }).fill("Review the change.");

    const fallback = screen.getByRole("button", "Fallback model", { exact: true });
    await expect(fallback).toContainText("Settings fallback");
    await fallback.tap();
    await screen.getByRole("button", "Replay (dev)", { exact: true }).tap();
    await screen.getByRole("option", { name: /Showcase/ }).tap();
    await expect(fallback).toContainText("Showcase");
    await screen.getByRole("button", "Add role", { exact: true }).tap();
    await screen.getByRole("button", "Use the Settings fallback", { exact: true }).waitFor();

    const editor = await browser.evaluate(() => location.pathname + location.search);
    await t3.open(editor);
    await expect(screen.getByRole("button", "Fallback model", { exact: true })).toContainText(
      "Showcase",
    );
    await app.screenshot("fallback-set");

    await screen.getByRole("button", "Use the Settings fallback", { exact: true }).tap();
    const save = screen.getByRole("button", "Save role", { exact: true });
    await save.tap();
    await expect(save).toBeDisabled();
    await t3.open(editor);
    await expect(screen.getByRole("button", "Fallback model", { exact: true })).toContainText(
      "Settings fallback",
    );
    await app.screenshot("fallback-cleared");
  },
);
