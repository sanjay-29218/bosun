import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Bot } from "./bots.ts";
import { ProjectManagerSettings, RoleConfig } from "./crew.ts";

const decodeBot = Schema.decodeUnknownSync(Bot);
const decodeRole = Schema.decodeUnknownSync(RoleConfig);
const decodeManager = Schema.decodeUnknownSync(ProjectManagerSettings);
const modelSelection = { instanceId: "codex", model: "gpt-5-codex" };

// Linked machines update at different times, so a newer client reads what older servers send.
describe("agents from servers before #108, #112 and #157", () => {
  it("decodes a bot with old tool, access and Can work on fields", () => {
    const bot = decodeBot({
      id: "bot-1",
      name: "Captain",
      avatar: {
        head: "round",
        face: "visor",
        eyes: "round",
        top: "ball",
        cheeks: false,
        smile: true,
      },
      color: "blue",
      instructions: "",
      allowedTools: ["crew.delegate"],
      permittedEnvironmentIds: ["vps"],
      runtimeMode: "full-access",
      modelSelection: null,
      longConversation: "compact",
      position: 0,
      revision: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(bot).not.toHaveProperty("runtimeMode");
    expect(bot).not.toHaveProperty("permittedEnvironmentIds");
    expect(bot.linkedEnvironmentIds).toEqual([]);
  });

  it("decodes a role and project manager settings with old tool, access and model fields", () => {
    const role = decodeRole({
      id: "builder",
      name: "Builder",
      instructions: "",
      allowedTools: [],
      modelSelection,
      runtimeMode: "full-access",
      enabled: true,
      revision: 1,
    });
    const manager = decodeManager({
      projectId: "project-1",
      enabled: true,
      instructions: "",
      withheldTools: ["preview"],
      modelSelection,
      runtimeMode: "approval-required",
      longConversation: "compact",
      customized: false,
      revision: 0,
      threadId: null,
      icon: null,
    });
    expect(role).not.toHaveProperty("runtimeMode");
    expect(manager).not.toHaveProperty("withheldTools");
    expect(manager).not.toHaveProperty("modelSelection");
  });
});
