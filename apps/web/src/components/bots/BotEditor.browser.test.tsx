import { type Bot, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { BotEditor } from "./BotEditor";

const confirm = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock(import("../../confirmDialog"), async (original) => ({
  ...(await original()),
  // The person cancels: they want to keep editing.
  requestConfirmDialog: (async (message: string) => {
    confirm.asked.push(message);
    return false;
  }) as never,
}));
vi.mock(import("../../state/bots"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    botsEnvironment: {
      ...actual.botsEnvironment,
      update: { ...actual.botsEnvironment.update, permissionAtom: () => allowed },
    },
  };
});

const environmentId = EnvironmentId.make("laptop");
const captain: Bot = {
  id: "bot-ops",
  name: "Captain",
  avatar: { head: "round", face: "flat", eyes: "dash", top: "none", cheeks: false, smile: false },
  color: "blue",
  instructions: "Run the projects.",
  allowedTools: [],
  runtimeMode: "full-access",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  longConversation: "compact",
  position: 0,
  revision: 1,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
};

it("keeps Settings open with the edit when Esc's leave prompt is cancelled", async () => {
  confirm.asked = [];
  await using screen = await render(
    <AppRouteModal label="Settings">
      <BotEditor
        environmentId={environmentId}
        bot={captain}
        defaultModel={captain.modelSelection}
        usedAvatars={[]}
        projects={null}
        projectCount={0}
        onConflict={() => {}}
        onSaved={() => {}}
        onCancel={() => {}}
      />
    </AppRouteModal>,
    { router: "/settings/bots" },
  );
  const instructions = page.getByRole("textbox", { name: "Instructions" });
  await userEvent.fill(instructions, "Run the projects carefully.");

  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(confirm.asked).toEqual(["Leave without saving Captain?"]));
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect.element(instructions).toHaveTextContent("Run the projects carefully.");
  expect(screen.router?.state.location.pathname).toBe("/settings/bots");
});
