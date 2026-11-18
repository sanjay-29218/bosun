import { useAtomValue } from "@effect/atom-react";
import { BOT_AVATAR_PRESETS, randomBotAvatar } from "@t3tools/client-runtime/bot-avatar";
import {
  type Bot,
  type BotAvatar as BotAvatarParts,
  type EnvironmentId,
  type ModelSelection,
  type ProjectIconColor,
} from "@t3tools/contracts";
import { FolderIcon, MonitorIcon, PaletteIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import { randomUUID } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { useEnvironmentIdentities } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { RoleModelPicker } from "../library/RoleEditor";
import { EditorField } from "../settings/EditorField";
import { InstructionsEditor } from "../InstructionsEditor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { WizardTabs } from "../ui/wizard";
import { BotHomeField } from "./BotHomeField";
import { BotAvatarPicker, BotColorPicker } from "./BotLook";

type BotChange = Partial<
  Pick<Bot, "name" | "avatar" | "color" | "instructions" | "modelSelection">
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

type Tab = "behavior" | "projects" | "look";

/**
 * A bot's name, behavior and look; `bot` null adds one. Every bot gets every tool. `projects` is the Projects tab,
 * which moves projects right away rather than on Save.
 */
export function BotEditor({
  environmentId,
  bot,
  defaultModel,
  usedAvatars,
  projects,
  projectCount,
  onMove = null,
  onConflict,
  onSaved,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly defaultModel: ModelSelection | null;
  /** Avatars other bots wear; a new bot starts with a starter one nobody has. */
  readonly usedAvatars: ReadonlyArray<BotAvatarParts>;
  readonly projects: ReactNode;
  readonly projectCount: number;
  /** Opens Move to another machine; null when it isn't offered. */
  readonly onMove?: (() => void) | null;
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
  // Null until someone picks one: the bot then follows this environment's default model.
  const [pickedModel, setModelSelection] = useState(bot?.modelSelection ?? null);
  const modelSelection = pickedModel ?? defaultModel;
  const homeLabel =
    useEnvironmentIdentities().find((identity) => identity.environmentId === environmentId)
      ?.label ?? "this machine";
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("behavior");
  const fields = {
    name: name.trim(),
    avatar,
    color,
    modelSelection: pickedModel,
  };
  const edited = bot
    ? fields.name !== bot.name ||
      JSON.stringify(avatar) !== JSON.stringify(bot.avatar) ||
      color !== bot.color ||
      instructions.trim() !== bot.instructions ||
      JSON.stringify(pickedModel) !== JSON.stringify(bot.modelSelection)
    : fields.name.length > 0 || instructions.trim().length > 0;
  // A new bot may leave instructions empty to start from the server's defaults.
  const canSave =
    edited &&
    canEdit &&
    fields.name.length > 0 &&
    modelSelection !== null &&
    (bot === null || instructions.trim().length > 0) &&
    !saving;

  useUnsavedChangesGuard({
    unsaved: edited,
    saving,
    message: bot ? `Leave without saving ${bot.name}?` : "Leave without adding this bot?",
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
            {bot ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MonitorIcon aria-hidden className="size-3.5" />
                Lives on {homeLabel}
                {onMove === null ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <Button type="button" variant="link" size="xs" onClick={onMove}>
                      Move…
                    </Button>
                  </>
                )}
              </p>
            ) : null}
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
                    <>
                      <RoleModelPicker
                        environmentId={environmentId}
                        selection={modelSelection}
                        disabled={saving || !canEdit}
                        onChange={setModelSelection}
                      />
                      {pickedModel === null ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          Follows the default model until you pick one.
                        </p>
                      ) : (
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          className="mt-1"
                          disabled={saving || !canEdit}
                          onClick={() => setModelSelection(null)}
                        >
                          Follow the default model
                        </Button>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No model available. Set up a provider first.
                    </p>
                  )}
                </div>
              </EditorField>
            </div>
          </>
        ) : tab === "projects" && bot ? (
          <>
            <BotHomeField environmentId={environmentId} homePath={bot.homePath ?? null} />
            {projects}
          </>
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
      {/* Pinned to the pane's bottom, so Save stays in reach below a long project list. */}
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
