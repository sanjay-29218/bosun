import * as Cause from "effect/Cause";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** A pill button, as the crew and library settings panels use. */
export function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled, selected: props.selected }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`rounded-full px-3 py-2 active:opacity-70 disabled:opacity-40 ${props.selected ? "bg-subtle-strong" : "bg-card"}`}
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/** Runs a command for a panel, with whether it's busy and what went wrong. */
export function useRun(onSuccess: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result._tag !== "Success") setError(Cause.pretty(result.cause as Cause.Cause<unknown>));
    else onSuccess();
    return result._tag === "Success";
  };
  return { busy, error, run };
}
