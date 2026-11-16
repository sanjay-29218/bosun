import type { ReactNode } from "react";

import { Label } from "../ui/label";

/** A labeled block of a bot or role editor. */
export function EditorField({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    // A grid, so an inline control (the model picker) still sits under its label.
    <div className="grid gap-2">
      <Label {...(htmlFor ? { htmlFor } : {})}>{label}</Label>
      {children}
    </div>
  );
}
