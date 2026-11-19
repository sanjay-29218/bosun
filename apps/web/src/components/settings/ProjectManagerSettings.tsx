import { useAtomValue } from "@effect/atom-react";
import { managerAutomationsWarning } from "@t3tools/client-runtime/state/automations";
import {
  type ManagerCopy,
  managerHomeAmong,
  onSeveralMachines,
  type PlacedProject,
  planManagerPlacement,
} from "@t3tools/client-runtime/project-manager-home";
import { projectManagerLook } from "@t3tools/client-runtime/project-manager-look";
import type { ProjectManagerIcon, ProjectManagerSettings } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentScheduledTasks } from "../../state/automations";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useApplyManagerPlacement, useManagerCopies } from "../../state/projectManagerHome";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { InstructionsEditor } from "../InstructionsEditor";
import { BotAvatarPicker, BotColorPicker } from "../bots/BotLook";
import { ProjectManagerAvatar } from "../bots/ProjectManagerIcon";
import { useOpenProjectManager } from "../sidebar/openProjectManager";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { EditorField } from "./EditorField";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface ProjectMember extends PlacedProject {
  readonly title: string;
  readonly environmentLabel: string | null;
}

/**
 * The project's manager: the standing thread that runs its requests. A project on several
 * machines has one, on the copy it lives on, and works on the copies it may; older servers keep
 * one per copy.
 */
export function ProjectManagerSection({
  members,
}: {
  readonly members: ReadonlyArray<ProjectMember>;
}) {
  const copiesOf = useManagerCopies();
  if (members.length === 0) return null;
  const copies = copiesOf(members);
  const placed = copies.length === members.length && onSeveralMachines(copies);
  const home = placed ? managerHomeAmong(copies) : null;
  const shown = placed
    ? members.filter(
        (member) =>
          home !== null &&
          member.environmentId === home.environmentId &&
          member.id === home.projectId,
      )
    : members.filter((member) => member.remoteManager == null);
  // A copy whose manager lives on a machine this client doesn't see.
  const elsewhere =
    home !== null ? null : (members.find((member) => member.remoteManager != null) ?? null);
  return (
    <SettingsSection title="Project manager" id={searchableSetting("project-manager").id}>
      {placed && home !== null ? <ProjectManagerLivesOn copies={copies} home={home} /> : null}
      {elsewhere?.remoteManager != null && shown.length === 0 ? (
        <SettingsRow
          title="Lives on"
          description={`${elsewhere.remoteManager.homeLabel}. Connect to it to change this project's manager.`}
        />
      ) : null}
      {shown.map((member) => (
        <ProjectManagerMember
          key={`${member.environmentId}:${member.id}`}
          member={member}
          showEnvironment={shown.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

/** Where the manager lives, a choice among the project's copies. It saves at once. */
function ProjectManagerLivesOn({
  copies,
  home,
}: {
  readonly copies: ReadonlyArray<ManagerCopy>;
  readonly home: ManagerCopy;
}) {
  const apply = useApplyManagerPlacement();
  const canEdit = useAtomValue(
    rolesEnvironment.setProjectManagerPlacement.permissionAtom(home.environmentId),
  );
  const [saving, setSaving] = useState(false);

  const run = async (plan: ReturnType<typeof planManagerPlacement>, failureTitle: string) => {
    setSaving(true);
    const failure = await apply(plan, copies);
    setSaving(false);
    if (failure !== null) {
      toastManager.add({ type: "error", title: failureTitle, description: failure });
    }
  };

  const move = async (environmentId: string) => {
    const next = copies.find((copy) => copy.environmentId === environmentId);
    if (next === undefined || next === home) return;
    const confirmed = await requestConfirmDialog(
      `Move this project's manager to ${next.label}? Its thread on ${home.label} is archived, not deleted, and its open requests go back to their senders. The manager on ${next.label} keeps its own settings and automations.`,
    );
    if (confirmed !== true) return;
    await run(planManagerPlacement(copies, next), `Could not move the manager to ${next.label}`);
  };

  return (
    <SettingsRow
      title="Lives on"
      description="Its chat, settings and automations live on this machine. Moving it archives the manager's thread on the machine it leaves."
      control={
        <Select value={home.environmentId} onValueChange={(next) => void move(String(next))}>
          <SelectTrigger aria-label="Lives on" disabled={saving || !canEdit}>
            <SelectValue>
              {(value: string) =>
                copies.find((copy) => copy.environmentId === value)?.label ?? value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {copies.map((copy) => (
              <SelectItem key={copy.environmentId} value={copy.environmentId}>
                {copy.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
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
  const formKey = JSON.stringify([formGeneration, settings.instructions, settings.customized]);
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
  const scheduledTasks = useEnvironmentScheduledTasks(member.environmentId);
  const canEdit = useAtomValue(
    rolesEnvironment.updateProjectManager.permissionAtom(member.environmentId),
  );
  const [instructions, setInstructions] = useState(settings.instructions);
  const [saving, setSaving] = useState(false);
  const edited = instructions.trim() !== settings.instructions;

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
            expectedRevision: settings.revision,
          },
        }),
      "Could not save the project manager",
      onSaved,
    );

  const toggle = async (enabled: boolean) => {
    const warning = enabled
      ? null
      : managerAutomationsWarning(scheduledTasks ?? [], member.id, "off");
    if (
      warning !== null &&
      (await requestConfirmDialog(
        `${warning} Turning the manager back on won't resume them; you resume them in Automations.`,
      )) !== true
    )
      return;
    await run(
      () =>
        setEnabled({
          environmentId: member.environmentId,
          input: { projectId: member.id, enabled },
        }),
      enabled ? "Could not turn the project manager on" : "Could not turn the project manager off",
    );
  };

  const resetToDefaults = async () => {
    const confirmed = await requestConfirmDialog(
      "Reset this project's manager to its defaults? Its instructions go back to the built-in ones.",
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
                ? "Takes this project's requests. Customized for this project."
                : "Takes this project's requests. Built-in instructions until you save changes here. Pick its model in its thread."}
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
