import { SlidersHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import type { IssueDisplayPreferences } from "./featuresPagePreferences";

const DisplayTrigger = (
  <Button size="sm" variant="ghost" aria-label="Display options">
    <SlidersHorizontalIcon aria-hidden />
    <span className="hidden md:inline">Display</span>
  </Button>
);

/**
 * How the Features view draws: columns by phase (as a board or as rows), or one workflow's
 * stages as columns.
 */
export function FeatureDisplayMenu(props: {
  readonly layout: "board" | "list";
  readonly onLayout: (layout: "board" | "list") => void;
  readonly stages: boolean;
  /** Labelled with the stages shortcut, when it has one. */
  readonly stagesLabel: string;
  readonly onStages: (stages: boolean) => void;
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly workflowId: string | null;
  readonly onWorkflow: (workflowId: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={DisplayTrigger} />
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Columns</MenuGroupLabel>
          <MenuRadioGroup
            value={props.stages ? "stages" : "phase"}
            onValueChange={(value) => props.onStages(value === "stages")}
          >
            <MenuRadioItem value="phase">Phase</MenuRadioItem>
            <MenuRadioItem value="stages">{props.stagesLabel}</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        {props.stages ? (
          props.workflows.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>Workflow</MenuGroupLabel>
              <MenuRadioGroup
                value={props.workflowId ?? ""}
                onValueChange={(value) => {
                  if (typeof value === "string" && value) props.onWorkflow(value);
                }}
              >
                {props.workflows.map((workflow) => (
                  <MenuRadioItem key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          ) : null
        ) : (
          <MenuGroup>
            <MenuGroupLabel>Layout</MenuGroupLabel>
            <MenuRadioGroup
              value={props.layout}
              onValueChange={(value) => props.onLayout(value === "list" ? "list" : "board")}
            >
              <MenuRadioItem value="board">Board</MenuRadioItem>
              <MenuRadioItem value="list">List</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** Layout, grouping and which properties the Issues view shows. Remembered across visits. */
export function IssueDisplayMenu(props: {
  readonly display: IssueDisplayPreferences;
  readonly onChange: (patch: Partial<IssueDisplayPreferences>) => void;
}) {
  const { display } = props;
  const list = display.layout === "list";
  return (
    <Menu>
      <MenuTrigger render={DisplayTrigger} />
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Layout</MenuGroupLabel>
          <MenuRadioGroup
            value={display.layout}
            onValueChange={(value) =>
              props.onChange({ layout: value === "board" ? "board" : "list" })
            }
          >
            <MenuRadioItem value="list">List</MenuRadioItem>
            <MenuRadioItem value="board">Board by status</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {list ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Group by</MenuGroupLabel>
              <MenuRadioGroup
                value={display.groupBy}
                onValueChange={(value) =>
                  props.onChange({
                    groupBy: value === "status" || value === "none" ? value : "milestone",
                  })
                }
              >
                <MenuRadioItem value="milestone">Milestone</MenuRadioItem>
                <MenuRadioItem value="status">Status</MenuRadioItem>
                <MenuRadioItem value="none">No grouping</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Show</MenuGroupLabel>
          {list ? (
            <>
              <MenuCheckboxItem
                checked={display.nested}
                onCheckedChange={(checked) => props.onChange({ nested: checked })}
              >
                Sub-issues under their parent
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={display.showClosed}
                onCheckedChange={(checked) => props.onChange({ showClosed: checked })}
              >
                Recently closed issues
              </MenuCheckboxItem>
            </>
          ) : null}
          <MenuCheckboxItem
            checked={display.labels}
            onCheckedChange={(checked) => props.onChange({ labels: checked })}
          >
            Labels
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={display.assignees}
            onCheckedChange={(checked) => props.onChange({ assignees: checked })}
          >
            Assignees
          </MenuCheckboxItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
