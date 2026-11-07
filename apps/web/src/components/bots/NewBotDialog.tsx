import { useAtomValue } from "@effect/atom-react";
import { BOT_AVATAR_PRESETS, randomBotAvatar } from "@t3tools/client-runtime/bot-avatar";
import type {
  Bot,
  BotAvatar as BotAvatarParts,
  EnvironmentId,
  ProjectIconColor,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { useEnvironmentDefaultModel } from "../library/RoleEditor";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { BotAvatarPicker, BotColorPicker } from "./BotLook";

/**
 * Adds a bot from a name and a look, on the environment's default model with no projects. The
 * rest (instructions, projects, tools) waits in its editor.
 */
export function NewBotDialog({
  environmentId,
  usedAvatars,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  /** Avatars other bots wear; a new bot starts with a starter one nobody has. */
  readonly usedAvatars: ReadonlyArray<BotAvatarParts>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (bot: Bot) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        {/* Remounted per opening, so each new bot starts from a fresh form. */}
        {open ? (
          <NewBotForm
            environmentId={environmentId}
            usedAvatars={usedAvatars}
            onCancel={() => onOpenChange(false)}
            onCreated={onCreated}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function NewBotForm({
  environmentId,
  usedAvatars,
  onCancel,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly usedAvatars: ReadonlyArray<BotAvatarParts>;
  readonly onCancel: () => void;
  readonly onCreated: (bot: Bot) => void;
}) {
  const create = useAtomCommand(botsEnvironment.create, { reportFailure: false });
  const canCreate = useAtomValue(botsEnvironment.create.permissionAtom(environmentId));
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  // One id per form: retrying after a lost response returns the bot already made.
  const [id] = useState(() => `bot-${randomUUID()}`);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<BotAvatarParts>(
    () =>
      BOT_AVATAR_PRESETS.find(
        (preset) => !usedAvatars.some((used) => JSON.stringify(used) === JSON.stringify(preset)),
      ) ?? randomBotAvatar(),
  );
  const [color, setColor] = useState<ProjectIconColor>("blue");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = async () => {
    if (trimmed.length === 0 || saving || !canCreate) return;
    setSaving(true);
    setError(null);
    const result = await create({
      environmentId,
      input: {
        id,
        name: trimmed,
        avatar,
        color,
        ...(defaultModel === null ? {} : { modelSelection: defaultModel }),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      onCreated(result.value);
      return;
    }
    setError(formatEnvironmentQueryError(result.cause));
  };

  return (
    <form
      // The popup's header, scrolling panel and footer stay in its flex column.
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New bot</DialogTitle>
        <DialogDescription>
          A bot runs your projects and talks to you in its own thread.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex justify-center">
          <BotAvatar avatar={avatar} color={color} size="lg" shaded={false} />
        </div>
        <div className="space-y-1.5">
          <Input
            autoFocus
            aria-label="Name"
            value={name}
            maxLength={80}
            placeholder="Name your bot"
            onChange={(event) => setName(event.target.value)}
          />
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              Could not create the bot: {error}
            </p>
          ) : null}
        </div>
        <BotAvatarPicker value={avatar} color={color} onChange={setAvatar} />
        <BotColorPicker value={color} onChange={setColor} />
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={trimmed.length === 0 || saving || !canCreate}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
