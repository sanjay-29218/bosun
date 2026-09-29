import {
  ProviderInstanceId,
  type BotTemplateConfig,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useMemo, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly defaultModelSelection: ModelSelection | null;
  readonly bots: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly projectId: ProjectId | null;
  }>;
}

function TemplateEditor(props: {
  readonly template: BotTemplateConfig | null;
  readonly defaultModelSelection: ModelSelection | null;
  readonly busy: boolean;
  readonly onSave: (input: {
    id: string;
    name: string;
    instructions: string;
    allowedTools: ReadonlyArray<string>;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    autoCreateForFeature: boolean;
    expectedRevision?: number;
    enabled?: boolean;
  }) => Promise<void>;
}) {
  const initialModel = props.template?.modelSelection ?? props.defaultModelSelection;
  const [name, setName] = useState(props.template?.name ?? "");
  const [instructions, setInstructions] = useState(props.template?.instructions ?? "");
  const [allowedTools, setAllowedTools] = useState(props.template?.allowedTools.join(", ") ?? "");
  const [instanceId, setInstanceId] = useState(initialModel?.instanceId ?? "");
  const [model, setModel] = useState(initialModel?.model ?? "");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    props.template?.runtimeMode ?? "approval-required",
  );
  const [autoCreateForFeature, setAutoCreateForFeature] = useState(
    props.template?.autoCreateForFeature ?? false,
  );
  const [enabled, setEnabled] = useState(props.template?.enabled ?? true);
  const readOnly = props.template?.projectId === null;
  const canSave = name.trim() && instructions.trim() && instanceId.trim() && model.trim();

  return (
    <form
      className="space-y-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave || readOnly) return;
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make(instanceId.trim()),
          model: model.trim(),
          ...(props.template?.modelSelection.instanceId === instanceId.trim() &&
          props.template.modelSelection.model === model.trim() &&
          props.template.modelSelection.options
            ? { options: props.template.modelSelection.options }
            : {}),
        };
        void props.onSave({
          id: props.template?.id ?? `bot-template:${randomUUID()}`,
          name: name.trim(),
          instructions: instructions.trim(),
          allowedTools: [
            ...new Set(
              allowedTools
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ],
          modelSelection,
          runtimeMode,
          autoCreateForFeature,
          ...(props.template ? { expectedRevision: props.template.revision, enabled } : {}),
        });
      }}
    >
      <div className="text-sm font-medium">{props.template?.name ?? "New template"}</div>
      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          Environment template. Its settings apply to this environment.
        </p>
      ) : null}
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Name</span>
        <Input
          aria-label="Bot template name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          disabled={readOnly}
        />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Instructions</span>
        <Textarea
          aria-label="Bot template instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={16000}
          rows={5}
          disabled={readOnly}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>Provider instance</span>
          <Input
            aria-label="Bot provider instance"
            value={instanceId}
            onChange={(event) => setInstanceId(event.target.value)}
            disabled={readOnly}
          />
        </label>
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>Model</span>
          <Input
            aria-label="Bot model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={readOnly}
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Allowed bot tools, separated by commas</span>
        <Input
          aria-label="Allowed bot tools"
          value={allowedTools}
          onChange={(event) => setAllowedTools(event.target.value)}
          disabled={readOnly}
        />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>T3 runtime permissions</span>
        <select
          aria-label="Bot runtime mode"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={runtimeMode}
          onChange={(event) => setRuntimeMode(event.target.value as RuntimeMode)}
          disabled={readOnly}
        >
          <option value="approval-required">Ask before changes</option>
          <option value="auto-accept-edits">Auto accept edits</option>
          <option value="auto">Auto</option>
          <option value="full-access">Full access</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoCreateForFeature}
          onChange={(event) => setAutoCreateForFeature(event.target.checked)}
          disabled={readOnly}
        />
        Default for future feature crews
      </label>
      {props.template ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={readOnly}
          />
          Enabled
        </label>
      ) : null}
      {!readOnly ? (
        <Button size="sm" type="submit" disabled={!canSave || props.busy}>
          Save template
        </Button>
      ) : null}
    </form>
  );
}

export function BotConfigurationPanel(props: Props) {
  const { environmentId, projectId } = props;
  const configuration = useEnvironmentQuery(
    botsEnvironment.configuration({ environmentId, input: { projectId } }),
  );
  const initialize = useAtomCommand(botsEnvironment.initialize);
  const createTemplate = useAtomCommand(botsEnvironment.createTemplate);
  const updateTemplate = useAtomCommand(botsEnvironment.updateTemplate);
  const instantiate = useAtomCommand(botsEnvironment.instantiate);
  const setHierarchy = useAtomCommand(botsEnvironment.setHierarchy);
  const setDelegation = useAtomCommand(botsEnvironment.setDelegation);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [sourceBotId, setSourceBotId] = useState("");
  const [targetBotId, setTargetBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = configuration.data?.templates ?? [];
  const needsStarter = !templates.some(
    (template) => template.id === `template:manager:${projectId}`,
  );
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;
  const hierarchy = configuration.data?.hierarchy ?? [];
  const parents = useMemo(
    () => new Map(hierarchy.map((node) => [node.botId, node.parentBotId])),
    [hierarchy],
  );
  const grants = configuration.data?.delegationGrants ?? [];
  const selectedGrant = grants.some(
    (grant) => grant.sourceBotId === sourceBotId && grant.targetBotId === targetBotId,
  );
  const run = async (
    action: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag !== "Success") setError(Cause.pretty(result.cause as Cause.Cause<unknown>));
      else configuration.refresh();
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 border-t border-border px-3 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Templates and permissions</h3>
          <p className="text-xs text-muted-foreground">
            Templates configure future bots. Existing bots and runs keep their own snapshot.
          </p>
        </div>
        {needsStarter ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !props.defaultModelSelection}
            onClick={() => {
              if (!props.defaultModelSelection) return;
              void run(() =>
                initialize({
                  environmentId,
                  input: { projectId, modelSelection: props.defaultModelSelection! },
                }),
              );
            }}
          >
            Add starter bots
          </Button>
        ) : null}
      </div>
      {configuration.error ? (
        <p className="text-sm text-destructive">{configuration.error}</p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <div className="space-y-1">
          <Button
            size="sm"
            variant={selectedTemplateId === null ? "secondary" : "ghost"}
            onClick={() => setSelectedTemplateId(null)}
          >
            New template
          </Button>
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              aria-pressed={selectedTemplateId === template.id}
              onClick={() => setSelectedTemplateId(template.id)}
            >
              <span className="block truncate">{template.name}</span>
              <span className="text-xs text-muted-foreground">
                {template.autoCreateForFeature ? "Feature default" : "Manual"}
              </span>
            </button>
          ))}
        </div>
        <div className="space-y-2">
          <TemplateEditor
            key={selectedTemplate?.id ?? "new"}
            template={selectedTemplate}
            defaultModelSelection={props.defaultModelSelection}
            busy={busy}
            onSave={async (value) => {
              const input = { ...value, projectId };
              if (value.expectedRevision !== undefined && value.enabled !== undefined) {
                await run(() =>
                  updateTemplate({
                    environmentId,
                    input: {
                      ...input,
                      expectedRevision: value.expectedRevision!,
                      enabled: value.enabled!,
                    },
                  }),
                );
              } else if (
                await run(() =>
                  createTemplate({
                    environmentId,
                    input: { ...input, allowedTools: [...value.allowedTools] },
                  }),
                )
              ) {
                setSelectedTemplateId(value.id);
              }
            }}
          />
          {selectedTemplate?.enabled ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  instantiate({
                    environmentId,
                    input: {
                      id: `bot:${randomUUID()}`,
                      projectId,
                      templateId: selectedTemplate.id,
                    },
                  }),
                )
              }
            >
              Add bot from template
            </Button>
          ) : null}
        </div>
      </div>
      {props.bots.length > 0 ? (
        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <h3 className="text-sm font-medium">Hierarchy</h3>
            <p className="text-xs text-muted-foreground">
              Bots with the same parent are peers. Placement does not grant delegation.
            </p>
          </div>
          {props.bots.map((bot) => {
            let depth = 0;
            let parent = parents.get(bot.id);
            while (parent && depth < 8) {
              depth++;
              parent = parents.get(parent);
            }
            return (
              <div
                key={bot.id}
                className="flex flex-wrap items-center gap-2 text-sm"
                style={{ paddingLeft: depth * 16 }}
              >
                <span className="min-w-28 font-medium">{bot.name}</span>
                {bot.projectId === projectId ? (
                  <select
                    aria-label={`Parent for ${bot.name}`}
                    className="h-8 min-w-40 rounded-md border border-input bg-background px-2 text-sm"
                    value={parents.get(bot.id) ?? ""}
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        setHierarchy({
                          environmentId,
                          input: {
                            projectId,
                            botId: bot.id,
                            parentBotId: event.target.value || null,
                            position: 0,
                          },
                        }),
                      )
                    }
                  >
                    <option value="">Root</option>
                    {props.bots
                      .filter((candidate) => candidate.id !== bot.id)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          Under {candidate.name}
                        </option>
                      ))}
                  </select>
                ) : (
                  <span className="text-xs text-muted-foreground">Environment bot</span>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Source bot</span>
              <select
                aria-label="Delegation source"
                className="block h-8 min-w-40 rounded-md border border-input bg-background px-2 text-sm"
                value={sourceBotId}
                onChange={(event) => setSourceBotId(event.target.value)}
              >
                <option value="">Select bot</option>
                {props.bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Target bot</span>
              <select
                aria-label="Delegation target"
                className="block h-8 min-w-40 rounded-md border border-input bg-background px-2 text-sm"
                value={targetBotId}
                onChange={(event) => setTargetBotId(event.target.value)}
              >
                <option value="">Select bot</option>
                {props.bots
                  .filter((bot) => bot.projectId === projectId && bot.id !== sourceBotId)
                  .map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !sourceBotId || !targetBotId || sourceBotId === targetBotId}
              onClick={() =>
                void run(() =>
                  setDelegation({
                    environmentId,
                    input: { projectId, sourceBotId, targetBotId, allowed: !selectedGrant },
                  }),
                )
              }
            >
              {selectedGrant ? "Remove delegation" : "Allow delegation"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
