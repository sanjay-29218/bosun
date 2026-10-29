import { useAtomValue } from "@effect/atom-react";
import { BOT_AVATAR_PRESETS, randomBotAvatar } from "@t3tools/client-runtime/bot-avatar";
import {
  DEFAULT_BOT_TOOLS,
  type Bot,
  type BotAvatar as BotAvatarParts,
  type EnvironmentId,
  type ModelSelection,
  type ProjectIconColor,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useBlocker } from "@tanstack/react-router";
import { FolderIcon, PaletteIcon, SlidersHorizontalIcon, WrenchIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { RoleModelPicker, RuntimeModeSelect } from "../library/RoleEditor";
import { CrewToolPicker, EditorField } from "../settings/CrewAgentFields";
import { InstructionsEditor } from "../InstructionsEditor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { WizardTabs } from "../ui/wizard";
import { BotAvatarPicker, BotColorPicker } from "./BotLook";

type BotChange = Partial<
  Pick<
    Bot,
    | "name"
    | "avatar"
    | "color"
    | "instructions"
    | "allowedTools"
    | "modelSelection"
    | "runtimeMode"
    | "defaultWorkflowId"
  >
>;

/** Saves a bot. A failed save reloads the list, so another try uses the latest revision. */
function useSaveBot(environmentId: EnvironmentId, onFailure: () => void) {
  const update = useAtomCommand(botsEnvironment.update);
  return async (bot: Bot, change: BotChange) => {
    const result = await update({
      environmentId,
      input: { id: bot.id, expectedRevision: bot.revision, ...change },
    });
    if (result._tag === "Success") return true;
    onFailure();
    toastManager.add({
      type: "error",
      title: `Could not save ${bot.name}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return false;
  };
}

const NO_WORKFLOW = "none";

type Tab = "behavior" | "projects" | "tools" | "look";

/**
 * A bot's name, behavior, tools and look; `bot` null adds one. `projects` is the Projects tab,
 * which moves projects right away rather than on Save.
 */
export function BotEditor({
  environmentId,
  bot,
  defaultModel,
  workflows,
  usedAvatars,
  projects,
  projectCount,
  onConflict,
  onSaved,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly defaultModel: ModelSelection | null;
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Avatars other bots wear; a new bot starts with a starter one nobody has. */
  readonly usedAvatars: ReadonlyArray<BotAvatarParts>;
  readonly projects: ReactNode;
  readonly projectCount: number;
  readonly onConflict: () => void;
  readonly onSaved: (botId: string) => void;
  readonly onCancel: () => void;
}) {
  const create = useAtomCommand(botsEnvironment.create);
  const save = useSaveBot(environmentId, onConflict);
  const canEdit = useAtomValue(
    (bot ? botsEnvironment.update : botsEnvironment.create).permissionAtom(environmentId),
  );
  // One id per form: retrying after a lost response returns the bot already made.
  const [newBotId] = useState(() => `bot-${randomUUID()}`);
  const [name, setName] = useState(bot?.name ?? "");
  const [avatar, setAvatar] = useState<BotAvatarParts>(
    () =>
      bot?.avatar ??
      BOT_AVATAR_PRESETS.find(
        (preset) => !usedAvatars.some((used) => JSON.stringify(used) === JSON.stringify(preset)),
      ) ??
      randomBotAvatar(),
  );
  const [color, setColor] = useState<ProjectIconColor>(bot?.color ?? "blue");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [tools, setTools] = useState<ReadonlyArray<string>>(bot?.allowedTools ?? DEFAULT_BOT_TOOLS);
  const [modelSelection, setModelSelection] = useState(bot?.modelSelection ?? defaultModel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    bot?.runtimeMode ?? "approval-required",
  );
  const [defaultWorkflowId, setDefaultWorkflowId] = useState(bot?.defaultWorkflowId ?? null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("behavior");
  const fields = {
    name: name.trim(),
    avatar,
    color,
    allowedTools: tools,
    runtimeMode,
    modelSelection,
    defaultWorkflowId,
  };
  const edited = bot
    ? fields.name !== bot.name ||
      JSON.stringify(avatar) !== JSON.stringify(bot.avatar) ||
      color !== bot.color ||
      instructions.trim() !== bot.instructions ||
      tools.join("\n") !== bot.allowedTools.join("\n") ||
      JSON.stringify(modelSelection) !== JSON.stringify(bot.modelSelection) ||
      runtimeMode !== bot.runtimeMode ||
      defaultWorkflowId !== bot.defaultWorkflowId
    : fields.name.length > 0 || instructions.trim().length > 0;
  // A new bot may leave instructions empty to start from the server's defaults.
  const canSave =
    edited &&
    canEdit &&
    fields.name.length > 0 &&
    modelSelection !== null &&
    (bot === null || instructions.trim().length > 0) &&
    !saving;
  // A default workflow that was deleted still shows, so saving doesn't drop it silently.
  const workflowOptions =
    defaultWorkflowId && !workflows.some((workflow) => workflow.id === defaultWorkflowId)
      ? [...workflows, { id: defaultWorkflowId, name: defaultWorkflowId }]
      : workflows;

  useBlocker({
    shouldBlockFn: async () =>
      edited &&
      !saving &&
      (await requestConfirmDialog(
        bot ? `Leave without saving ${bot.name}?` : "Leave without adding this bot?",
      )) !== true,
    enableBeforeUnload: () => edited,
  });

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    const savedId = await (async () => {
      if (bot) {
        return (await save(bot, { ...fields, instructions: instructions.trim() })) ? bot.id : null;
      }
      const result = await create({
        environmentId,
        input: {
          id: newBotId,
          ...fields,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        },
      });
      if (result._tag === "Success") return result.value.id;
      toastManager.add({
        type: "error",
        title: "Could not add the bot",
        description: formatEnvironmentQueryError(result.cause),
      });
      return null;
    })();
    // Still saving, so the leave guard lets a new bot's navigation through.
    if (savedId !== null) onSaved(savedId);
    setSaving(false);
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={saving || !canEdit} className="min-w-0 space-y-5">
        <div className="flex items-center gap-4">
          <BotAvatar avatar={avatar} color={color} size="lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="bot-name">Name</Label>
            <Input
              id="bot-name"
              value={name}
              maxLength={80}
              placeholder="Social"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>
        <WizardTabs
          label="Bot settings"
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "behavior", label: "Behavior", icon: <SlidersHorizontalIcon /> },
            ...(bot
              ? [
                  {
                    value: "projects" as const,
                    label: `Projects · ${projectCount}`,
                    icon: <FolderIcon />,
                  },
                ]
              : []),
            { value: "tools", label: `Tools · ${tools.length}`, icon: <WrenchIcon /> },
            { value: "look", label: "Look", icon: <PaletteIcon /> },
          ]}
        />
        {tab === "behavior" ? (
          <>
            <EditorField label="Instructions" htmlFor="bot-instructions">
              <InstructionsEditor
                id="bot-instructions"
                label="Instructions"
                value={instructions}
                maxLength={16_000}
                disabled={saving}
                placeholder={
                  bot
                    ? "What this bot does for its projects"
                    : "Leave empty to coordinate its projects' managers"
                }
                onChange={setInstructions}
              />
            </EditorField>
            <div className="grid gap-5 sm:grid-cols-2">
              <EditorField label="Model">
                <div>
                  {modelSelection ? (
                    <RoleModelPicker
                      environmentId={environmentId}
                      selection={modelSelection}
                      disabled={saving || !canEdit}
                      onChange={setModelSelection}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No model available. Set up a provider first.
                    </p>
                  )}
                </div>
              </EditorField>
              <EditorField label="Access">
                <RuntimeModeSelect
                  label="Access"
                  value={runtimeMode}
                  disabled={saving || !canEdit}
                  onChange={setRuntimeMode}
                />
              </EditorField>
            </div>
            <EditorField label="Default workflow">
              <Select
                value={defaultWorkflowId ?? NO_WORKFLOW}
                onValueChange={(next) =>
                  setDefaultWorkflowId(
                    typeof next === "string" && next !== NO_WORKFLOW ? next : null,
                  )
                }
              >
                <SelectTrigger aria-label="Default workflow">
                  <SelectValue>
                    {(value: string) =>
                      value === NO_WORKFLOW
                        ? "None"
                        : (workflowOptions.find((workflow) => workflow.id === value)?.name ?? value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NO_WORKFLOW}>None</SelectItem>
                  {workflowOptions.map((workflow) => (
                    <SelectItem key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </EditorField>
          </>
        ) : tab === "projects" ? (
          projects
        ) : tab === "tools" ? (
          <CrewToolPicker value={tools} onChange={setTools} forBot />
        ) : (
          <>
            <EditorField label="Look">
              <BotAvatarPicker value={avatar} color={color} onChange={setAvatar} />
            </EditorField>
            <EditorField label="Color">
              <BotColorPicker value={color} onChange={setColor} />
            </EditorField>
          </>
        )}
      </fieldset>
      {/* Pinned to the pane's bottom, so Save stays in reach below a long tool list. */}
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 bg-background/95 px-1 py-3 backdrop-blur-sm">
        {bot && edited ? (
          <span className="me-auto text-xs text-muted-foreground">Unsaved changes</span>
        ) : null}
        <Button
          type="button"
          variant="ghost-muted"
          size="sm"
          disabled={saving || (bot !== null && !edited)}
          onClick={onCancel}
        >
          {bot ? "Discard" : "Cancel"}
        </Button>
        <Button type="submit" size="sm" disabled={!canSave}>
          {bot ? "Save" : "Add bot"}
        </Button>
      </div>
    </form>
  );
}
