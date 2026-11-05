import { useAtomValue } from "@effect/atom-react";
import type {
  BotLongConversation,
  EnvironmentId,
  ProjectId,
  ProjectManagerSettings,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { InstructionsEditor } from "../InstructionsEditor";
import { RoleModelPicker } from "../library/RoleEditor";
import { useOpenProjectManager } from "../sidebar/openProjectManager";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
  // A new revision, from a save, a reset or a role edit, starts the form over from it.
  return (
    <ProjectManagerForm
      key={query.data.revision}
      member={member}
      settings={query.data}
      heading={showEnvironment ? member.environmentLabel : null}
      onStale={query.refresh}
    />
  );
}

function ProjectManagerForm({
  member,
  settings,
  heading,
  onStale,
}: {
  readonly member: ProjectMember;
  readonly settings: ProjectManagerSettings;
  readonly heading: string | null;
  readonly onStale: () => void;
}) {
  const update = useAtomCommand(rolesEnvironment.updateProjectManager, { reportFailure: false });
  const reset = useAtomCommand(rolesEnvironment.resetProjectManager, { reportFailure: false });
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
  ): Promise<void> => {
    setSaving(true);
    const result = await action();
    setSaving(false);
    if (result._tag === "Success") return;
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
    );

  const resetToRole = async () => {
    const confirmed = await requestConfirmDialog(
      "Reset this project's manager to the Project manager role? Its instructions, model, access and tools here are replaced.",
    );
    if (confirmed !== true) return;
    await run(
      () =>
        reset({
          environmentId: member.environmentId,
          input: { projectId: member.id, expectedRevision: settings.revision },
        }),
      "Could not reset the project manager",
    );
  };

  return (
    <form
      className="space-y-4 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (edited && canEdit && !saving) void save();
      }}
    >
      {heading ? <p className="text-sm font-medium">{heading}</p> : null}
      <p className="text-sm text-muted-foreground">
        {settings.customized
          ? "Customized for this project. Edits to the Project manager role in the Library don't reach it until you reset it."
          : "Follows the Project manager role in the Library until you save changes here."}
      </p>
      <fieldset disabled={saving || !canEdit} className="min-w-0 space-y-4">
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
            disabled={saving || !canEdit}
            onClick={() => void resetToRole()}
          >
            Reset to role defaults
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={!edited || saving || !canEdit}>
          Save
        </Button>
      </div>
    </form>
  );
}
