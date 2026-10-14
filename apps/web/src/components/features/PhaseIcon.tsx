import { cn } from "../../lib/utils";

/**
 * How far along a board column sits, drawn as a filling circle like Linear's status icons:
 * dashed before any work, a growing slice while it moves, and a check once done.
 */
export function PhaseIcon(props: {
  readonly progress: number | "done";
  readonly className?: string;
}) {
  const { progress } = props;
  const tone =
    progress === "done"
      ? "text-primary"
      : progress === 0
        ? "text-muted-foreground"
        : progress < 0.6
          ? "text-warning"
          : progress < 0.9
            ? "text-success"
            : "text-info";
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      className={cn("size-3.5 shrink-0", tone, props.className)}
      fill="none"
    >
      {progress === "done" ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.5 7.2 6.2 8.8 9.5 5.4"
            stroke="var(--background)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={progress === 0 ? "2 1.7" : undefined}
          />
          {progress > 0 ? <path d={slice(progress)} fill="currentColor" /> : null}
        </>
      )}
    </svg>
  );
}

/** A pie slice of the inner circle, clockwise from twelve o'clock. */
function slice(progress: number): string {
  const radius = 3.5;
  if (progress >= 1) return `M7 3.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7Z`;
  const angle = progress * 2 * Math.PI;
  const x = 7 + radius * Math.sin(angle);
  const y = 7 - radius * Math.cos(angle);
  return `M7 7V${7 - radius}A${radius} ${radius} 0 ${progress > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`;
}
