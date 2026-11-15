import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Bot } from "./bots.ts";
import { ProjectManagerSettings, RoleConfig } from "./crew.ts";

const decodeBot = Schema.decodeUnknownSync(Bot);
const decodeRole = Schema.decodeUnknownSync(RoleConfig);
const decodeManager = Schema.decodeUnknownSync(ProjectManagerSettings);
const modelSelection = { instanceId: "codex", model: "gpt-5-codex" };

// Linked machines update at different times, so a newer client reads what older servers send.
describe("agents from servers before #108 and #112", () => {
  it("decodes a bot without withheldTools or permittedEnvironmentIds", () => {
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
      runtimeMode: "full-access",
      modelSelection: null,
      longConversation: "compact",
      position: 0,
      revision: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(bot.withheldTools).toEqual([]);
    expect(bot.permittedEnvironmentIds).toEqual([]);
  });

  it("decodes a role and project manager settings without withheldTools", () => {
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
      allowedTools: [],
      modelSelection,
      runtimeMode: "full-access",
      longConversation: "compact",
      customized: false,
      revision: 0,
      threadId: null,
      icon: null,
    });
    expect(role.withheldTools).toEqual([]);
    expect(manager.withheldTools).toEqual([]);
  });
});
