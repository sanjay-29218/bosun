import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Picks one of a workflow's steps, such as the first stage or where a route goes. */
export function WorkflowStageSelect({
  label,
  value,
  options,
  stageName,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly stageName: (stepId: string) => string;
  readonly onChange: (stepId: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(next: string) => stageName(next)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {stageName(option)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
