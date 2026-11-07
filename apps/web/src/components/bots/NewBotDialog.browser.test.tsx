import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NewBotDialog } from "./NewBotDialog";

vi.mock(import("../../state/bots"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    botsEnvironment: {
      ...actual.botsEnvironment,
      create: { ...actual.botsEnvironment.create, permissionAtom: () => allowed },
    },
  };
});

it("keeps Create on screen at a laptop's height, scrolling the picker instead", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using _screen = await render(
    <NewBotDialog
      environmentId={EnvironmentId.make("laptop")}
      usedAvatars={[]}
      open
      onOpenChange={() => {}}
      onCreated={() => {}}
    />,
  );

  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Pilot");

  await expect.element(page.getByRole("button", { name: "Create" })).toBeInViewport();
  await expect.element(page.getByRole("button", { name: "Cancel" })).toBeInViewport();
});
