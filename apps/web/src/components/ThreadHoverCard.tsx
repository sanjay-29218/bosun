import type { ComponentProps, ReactNode } from "react";
import { TooltipPopup } from "./ui/tooltip";
import { cn } from "~/lib/utils";

export function ThreadHoverCardPopup({ className, ...props }: ComponentProps<typeof TooltipPopup>) {
  return (
    <TooltipPopup
      {...props}
      variant="glass"
      className={cn("max-w-80 text-left whitespace-normal", className)}
    />
  );
}

export function ThreadHoverCard({
  title,
  status,
  children,
  footer,
}: {
  title: string;
  /** What the thread's work is doing now, under the title. */
  status?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {title}
      </div>
      {status ? <div className="text-xs">{status}</div> : null}
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}
