import { useAtomValue } from "@effect/atom-react";
import { projectManagerLook } from "@t3tools/client-runtime/project-manager-look";
import type {
  BotLongConversation,
  EnvironmentId,
  ProjectId,
  ProjectManagerIcon,
  ProjectManagerSettings,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { InstructionsEditor } from "../InstructionsEditor";
import { BotAvatarPicker, BotColorPicker } from "../bots/BotLook";
import { ProjectManagerAvatar } from "../bots/ProjectManagerIcon";
import { RoleModelPicker } from "../library/RoleEditor";
import { useOpenProjectManager } from "../sidebar/openProjectManager";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { CrewToolPicker, EditorField } from "./CrewAgentFields";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LONG_CONVERSATION_LABELS: Record<BotLongConversation, string> = {
  compact: "Compact",
  "new-session": "Start a new session",
};

interface ProjectMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly environmentLabel: string | null;
}

/** Each checkout's Project manager: the standing thread that runs the project's requests. */
export function ProjectManagerSection({
  members,
}: {
  readonly members: ReadonlyArray<ProjectMember>;
}) {
  if (members.length === 0) return null;
  return (
    <SettingsSection title="Project manager" id={searchableSetting("project-manager").id}>
      {members.map((member) => (
        <ProjectManagerMember
          key={`${member.environmentId}:${member.id}`}
          member={member}
          showEnvironment={members.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectManagerMember({
  member,
  showEnvironment,
}: {
  readonly member: ProjectMember;
  readonly showEnvironment: boolean;
}) {
  const [formGeneration, setFormGeneration] = useState(0);
  const query = useEnvironmentQuery(
    rolesEnvironment.projectManager({
      environmentId: member.environmentId,
      input: { projectId: member.id },
    }),
  );
  if (query.data === null) {
    return (
      <SettingsRow
        title={showEnvironment ? (member.environmentLabel ?? "Environment") : "Settings"}
        description={query.error ?? "Loading…"}
      />
    );
  }
  const settings = query.data;
  // A save or a reset here, or new settings from elsewhere, start the form over; a new look or
  // on/off keeps what's being typed.
  const formKey = JSON.stringify([
    formGeneration,
    settings.instructions,
    settings.allowedTools,
    settings.modelSelection,
    settings.runtimeMode,
    settings.longConversation,
    settings.customized,
  ]);
  return (
    <>
      <ProjectManagerIconRow member={member} settings={settings} />
      <ProjectManagerForm
        key={formKey}
        member={member}
        settings={settings}
        heading={showEnvironment ? member.environmentLabel : null}
        onStale={query.refresh}
        onSaved={() => setFormGeneration((generation) => generation + 1)}
      />
    </>
  );
}

/** The manager's bot look, saved as soon as it's picked; it never marks the manager customized. */
function ProjectManagerIconRow({
  member,
  settings,
}: {
  readonly member: ProjectMember;
  readonly settings: ProjectManagerSettings;
}) {
  const setIcon = useAtomCommand(rolesEnvironment.setProjectManagerIcon, { reportFailure: false });
  const canEdit = useAtomValue(
    rolesEnvironment.setProjectManagerIcon.permissionAtom(member.environmentId),
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectManagerIcon>(() =>
    projectManagerLook(member.id, settings.icon),
  );
  const [saving, setSaving] = useState(false);

  const save = async (icon: ProjectManagerIcon | null) => {
    setSaving(true);
    const result = await setIcon({
      environmentId: member.environmentId,
      input: { projectId: member.id, icon },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setOpen(false);
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not save the icon",
      description: formatEnvironmentQueryError(result.cause),
    });
  };

  return (
    <SettingsRow
      title="Icon"
      description={
        settings.icon === null
          ? "Picked for this project automatically. Shows in the bot list, the thread list and this manager's chat."
          : "Shows in the bot list, the thread list and this manager's chat."
      }
      control={
        <div className="flex items-center gap-2">
          <ProjectManagerAvatar projectId={member.id} icon={settings.icon} size={32} />
          {settings.icon === null ? null : (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={saving || !canEdit}
              onClick={() => void save(null)}
            >
              Use automatic
            </Button>
          )}
          <Popover
            open={open}
            onOpenChange={(next) => {
              if (next) setDraft(projectManagerLook(member.id, settings.icon));
              setOpen(next);
            }}
          >
            <PopoverTrigger
              render={<Button size="xs" variant="outline" disabled={saving || !canEdit} />}
            >
              Change
            </PopoverTrigger>
            <PopoverPopup
              align="end"
              width="lg"
              // The shape grid needs the room the default padding takes.
              padding="compact"
              aria-label={`${member.title}'s project manager icon`}
            >
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <BotAvatar avatar={draft.avatar} color={draft.color} size={48} />
                  <p className="text-sm font-medium">{member.title}'s project manager</p>
                </div>
                <BotAvatarPicker
                  value={draft.avatar}
                  color={draft.color}
                  onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))}
                />
                <BotColorPicker
                  value={draft.color}
                  onChange={(color) => setDraft((current) => ({ ...current, color }))}
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={saving} onClick={() => void save(draft)}>
                    Save icon
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      }
    />
  );
}

function ProjectManagerForm({
  member,
  settings,
  heading,
  onStale,
  onSaved,
}: {
  readonly member: ProjectMember;
  readonly settings: ProjectManagerSettings;
  readonly heading: string | null;
  readonly onStale: () => void;
  /** After a save or reset, which starts the form over from the server's settings. */
  readonly onSaved: () => void;
}) {
  const update = useAtomCommand(rolesEnvironment.updateProjectManager, { reportFailure: false });
  const reset = useAtomCommand(rolesEnvironment.resetProjectManager, { reportFailure: false });
  const setEnabled = useAtomCommand(rolesEnvironment.setProjectManagerEnabled, {
    reportFailure: false,
  });
  const openProjectManager = useOpenProjectManager();
  const canEdit = useAtomValue(
    rolesEnvironment.updateProjectManager.permissionAtom(member.environmentId),
  );
  const [instructions, setInstructions] = useState(settings.instructions);
  const [tools, setTools] = useState(settings.allowedTools);
  const [modelSelection, setModelSelection] = useState(settings.modelSelection);
  const [runtimeMode, setRuntimeMode] = useState(settings.runtimeMode);
  const [longConversation, setLongConversation] = useState(settings.longConversation);
  const [saving, setSaving] = useState(false);
  const edited =
    instructions.trim() !== settings.instructions ||
    tools.join("\n") !== settings.allowedTools.join("\n") ||
    JSON.stringify(modelSelection) !== JSON.stringify(settings.modelSelection) ||
    runtimeMode !== settings.runtimeMode ||
    longConversation !== settings.longConversation;

  const run = async <A, E>(
    action: () => Promise<AtomCommandResult<A, E>>,
    failureTitle: string,
    onSuccess?: () => void,
  ): Promise<void> => {
    setSaving(true);
    const result = await action();
    setSaving(false);
    if (result._tag === "Success") {
      onSuccess?.();
      return;
    }
    // When someone else saved first, the newer revision replaces this form; otherwise it stays.
    onStale();
    toastManager.add({
      type: "error",
      title: failureTitle,
      description: formatEnvironmentQueryError(result.cause),
    });
  };

  const save = () =>
    run(
      () =>
        update({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            instructions: instructions.trim(),
            allowedTools: tools,
            modelSelection,
            runtimeMode,
            longConversation,
            expectedRevision: settings.revision,
          },
        }),
      "Could not save the project manager",
      onSaved,
    );

  const toggle = (enabled: boolean) =>
    run(
      () =>
        setEnabled({
          environmentId: member.environmentId,
          input: { projectId: member.id, enabled },
        }),
      enabled ? "Could not turn the project manager on" : "Could not turn the project manager off",
    );

  const resetToDefaults = async () => {
    const confirmed = await requestConfirmDialog(
      "Reset this project's manager to its defaults? Its instructions go back to the built-in ones, on the model of the bot that owns the project.",
    );
    if (confirmed !== true) return;
    await run(
      () =>
        reset({
          environmentId: member.environmentId,
          input: { projectId: member.id, expectedRevision: settings.revision },
        }),
      "Could not reset the project manager",
      onSaved,
    );
  };

  return (
    <form
      className="space-y-4 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (edited && canEdit && !saving && settings.enabled) void save();
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          {heading ? <p className="text-sm font-medium">{heading}</p> : null}
          <p className="text-sm text-muted-foreground">
            {!settings.enabled
              ? "Off. The project's bot does its work itself, and the manager's thread is archived."
              : settings.customized
                ? "Takes this project's requests from its bot. Customized for this project."
                : "Takes this project's requests from its bot. Built-in instructions, on the model of the bot that owns this project, until you save changes here."}
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          disabled={saving || !canEdit}
          onCheckedChange={(checked) => void toggle(Boolean(checked))}
          aria-label="Project manager on"
        />
      </div>
      <fieldset
        disabled={saving || !canEdit || !settings.enabled}
        className="min-w-0 space-y-4 disabled:opacity-50"
      >
        <EditorField label="Instructions" htmlFor={`project-manager-${member.id}`}>
          <InstructionsEditor
            id={`project-manager-${member.id}`}
            label="Instructions"
            value={instructions}
            maxLength={16_000}
            disabled={saving || !canEdit}
            placeholder="How this project's manager runs its requests"
            onChange={setInstructions}
          />
        </EditorField>
        <div className="grid gap-4 sm:grid-cols-2">
          <EditorField label="Model">
            <div>
              <RoleModelPicker
                environmentId={member.environmentId}
                selection={modelSelection}
                runtimeMode={runtimeMode}
                disabled={saving || !canEdit}
                onChange={setModelSelection}
                onRuntimeModeChange={setRuntimeMode}
              />
            </div>
          </EditorField>
          <EditorField label="Long conversations">
            <Select
              value={longConversation}
              onValueChange={(next) => {
                if (next === "compact" || next === "new-session") setLongConversation(next);
              }}
            >
              <SelectTrigger aria-label="Long conversations">
                <SelectValue>
                  {(value: string) =>
                    LONG_CONVERSATION_LABELS[value === "new-session" ? value : "compact"]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="compact">{LONG_CONVERSATION_LABELS.compact}</SelectItem>
                <SelectItem value="new-session">
                  {LONG_CONVERSATION_LABELS["new-session"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          </EditorField>
        </div>
        <EditorField label="Tools">
          <CrewToolPicker value={tools} onChange={setTools} />
        </EditorField>
      </fieldset>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {edited ? (
          <span className="me-auto text-xs text-muted-foreground">Unsaved changes</span>
        ) : null}
        <Button
          type="button"
          variant="ghost-muted"
          size="sm"
          disabled={!settings.enabled}
          onClick={() =>
            void openProjectManager({
              environmentId: member.environmentId,
              projectId: member.id,
              title: member.title,
            })
          }
        >
          Open project manager
        </Button>
        {settings.customized ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || !canEdit || !settings.enabled}
            onClick={() => void resetToDefaults()}
          >
            Reset to defaults
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          disabled={!edited || saving || !canEdit || !settings.enabled}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
