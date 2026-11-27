import { useAtomValue } from "@effect/atom-react";
import {
  FEATURE_DELIVERY_WORKFLOW_ID,
  type EnvironmentId,
  type LibraryPushTarget,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import { m } from "../../i18n/messages";
import { cn, randomUUID } from "../../lib/utils";
import { formatEnvironmentQueryError } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { InstructionsEditor } from "../InstructionsEditor";
import { EditorField } from "../settings/EditorField";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { AlsoUpdateOnDialog, LibraryImportBanner, LibraryImportedOn } from "./LibraryImport";

/** A readable id that stays unique when two workflows share a name. */
function newWorkflowId(name: string) {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workflow";
  return `workflow:${slug}-${randomUUID().slice(0, 8)}`;
}

/** A role the workflow can pick: an enabled one, or one it already has. */
const pickable = (role: RoleConfig, picked: boolean) => role.enabled || picked;

/** A workflow's name, crew and instructions; `workflow` null adds one. */
export function WorkflowEditorForm({
  environmentId,
  workflow,
  roles,
  onSaved,
  onCancel,
  onDeleted,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowConfig | null;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly onSaved: (workflowId: string) => void;
  readonly onCancel: () => void;
  readonly onDeleted?: () => void;
}) {
  const gt = useGT();
  const create = useAtomCommand(rolesEnvironment.createWorkflow);
  const update = useAtomCommand(rolesEnvironment.updateWorkflow);
  const remove = useAtomCommand(rolesEnvironment.deleteWorkflow);
  const canEdit = useAtomValue(
    (workflow ? rolesEnvironment.updateWorkflow : rolesEnvironment.createWorkflow).permissionAtom(
      environmentId,
    ),
  );
  // Saving one that linked machines imported asks which of them take the change.
  const [asking, setAsking] = useState(false);
  const canDelete = useAtomValue(rolesEnvironment.deleteWorkflow.permissionAtom(environmentId));
  const [name, setName] = useState(workflow?.name ?? "");
  const [instructions, setInstructions] = useState(workflow?.instructions ?? "");
  const [crewRoleIds, setCrewRoleIds] = useState<ReadonlyArray<string>>(
    workflow?.crewRoleIds ?? [],
  );
  const [busy, setBusy] = useState(false);
  const fields = {
    name: name.trim(),
    instructions: instructions.trim(),
    crewRoleIds,
  };
  const edited = workflow
    ? fields.name !== workflow.name ||
      fields.instructions !== workflow.instructions ||
      fields.crewRoleIds.join("\n") !== workflow.crewRoleIds.join("\n")
    : fields.name.length > 0 || fields.instructions.length > 0 || fields.crewRoleIds.length > 0;
  const canSave =
    edited && canEdit && fields.name.length > 0 && fields.instructions.length > 0 && !busy;
  const crewOptions = roles.filter((role) => pickable(role, crewRoleIds.includes(role.id)));

  useUnsavedChangesGuard({
    unsaved: edited,
    saving: busy,
    message: gt("Leave without saving this workflow?"),
  });

  const submit = async (alsoUpdateOn?: ReadonlyArray<LibraryPushTarget>) => {
    if (!canSave) return;
    if (workflow && workflow.importers.length > 0 && alsoUpdateOn === undefined) {
      setAsking(true);
      return;
    }
    setAsking(false);
    setBusy(true);
    const input = { ...fields, crewRoleIds: [...fields.crewRoleIds] };
    const savedId = await (async () => {
      if (workflow) {
        const result = await update({
          environmentId,
          input: {
            id: workflow.id,
            ...input,
            expectedRevision: workflow.revision,
            ...(alsoUpdateOn && alsoUpdateOn.length > 0 ? { alsoUpdateOn: [...alsoUpdateOn] } : {}),
          },
        });
        if (result._tag === "Success") return workflow.id;
        toastManager.add({
          type: "error",
          title: m(msg("Could not save {name}", { name: workflow.name })),
          description: formatEnvironmentQueryError(result.cause),
        });
        return null;
      }
      const id = newWorkflowId(fields.name);
      const result = await create({ environmentId, input: { id, ...input } });
      if (result._tag === "Success") return id;
      toastManager.add({
        type: "error",
        title: m(msg("Could not add the workflow")),
        description: formatEnvironmentQueryError(result.cause),
      });
      return null;
    })();
    // Still busy, so the leave guard lets a new workflow's navigation through.
    if (savedId !== null) onSaved(savedId);
    setBusy(false);
  };

  const deleteWorkflow = async () => {
    if (!workflow) return;
    const confirmed = await requestConfirmDialog(
      gt("Delete {name}?\nFeatures already running on it keep going.", { name: workflow.name }),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { id: workflow.id } });
    if (result._tag === "Success") {
      onDeleted?.();
    } else {
      toastManager.add({
        type: "error",
        title: m(msg("Could not delete {name}", { name: workflow.name })),
        description: formatEnvironmentQueryError(result.cause),
      });
    }
    setBusy(false);
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {workflow === null ? null : (
        <LibraryImportBanner
          environmentId={environmentId}
          kind="workflow"
          item={workflow}
          unsaved={edited}
        />
      )}
      <fieldset disabled={busy || !canEdit} className="min-w-0 space-y-6">
        <SettingsSection
          title={gt("Workflow", {
            $context: "section heading for a workflow's name and instructions",
          })}
          hideTitle
        >
          <div className="space-y-5 px-3 py-4 sm:px-4">
            <EditorField label={gt("Name")} htmlFor="crew-workflow-name">
              <Input
                id="crew-workflow-name"
                value={name}
                maxLength={200}
                placeholder={gt("Bug fix", { $context: "example name for a workflow" })}
                onChange={(event) => setName(event.target.value)}
              />
            </EditorField>
            <EditorField label={gt("Instructions")} htmlFor="crew-workflow-instructions">
              <InstructionsEditor
                id="crew-workflow-instructions"
                label={gt("Instructions")}
                value={instructions}
                maxLength={16_000}
                size="lg"
                disabled={busy || !canEdit}
                placeholder={gt(
                  "How the feature's lead runs the work and when to hand it to the crew",
                )}
                onChange={setInstructions}
              />
            </EditorField>
          </div>
        </SettingsSection>
        <SettingsSection title={gt("Crew · {count}", { count: fields.crewRoleIds.length })}>
          <div className="px-3 py-4 sm:px-4">
            {crewOptions.length === 0 ? (
              <p className="px-2.5 text-sm text-muted-foreground">{gt("No roles yet.")}</p>
            ) : (
              <div className="grid gap-0.5 sm:grid-cols-2">
                {crewOptions.map((role) => {
                  const checked = crewRoleIds.includes(role.id);
                  return (
                    <label
                      key={role.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent",
                        checked && "bg-accent/60",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          setCrewRoleIds((current) =>
                            next === true
                              ? [...current, role.id]
                              : current.filter((id) => id !== role.id),
                          )
                        }
                      />
                      <span className="min-w-0 truncate text-sm">
                        {role.name}
                        {role.enabled ? null : (
                          <span className="text-muted-foreground">
                            {" · "}
                            {gt("Off", { $context: "a role that is switched off" })}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </SettingsSection>
        {workflow === null ? null : <LibraryImportedOn item={workflow} />}
      </fieldset>
      {workflow === null ? null : (
        <AlsoUpdateOnDialog
          name={workflow.name}
          importers={workflow.importers}
          open={asking}
          onCancel={() => setAsking(false)}
          onSave={(alsoUpdateOn) => void submit(alsoUpdateOn)}
        />
      )}
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-2 bg-background/95 px-1 py-3 backdrop-blur-sm">
        <div>
          {workflow && workflow.id !== FEATURE_DELIVERY_WORKFLOW_ID && canDelete ? (
            <Button
              type="button"
              variant="ghost-destructive"
              size="sm"
              disabled={busy}
              onClick={() => void deleteWorkflow()}
            >
              {gt("Delete workflow")}
            </Button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost-muted"
            size="sm"
            disabled={busy || (workflow !== null && !edited)}
            onClick={onCancel}
          >
            {workflow ? gt("Discard", { $context: "verb, discards unsaved edits" }) : gt("Cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            {workflow ? gt("Save workflow") : gt("Add workflow")}
          </Button>
        </div>
      </div>
    </form>
  );
}
