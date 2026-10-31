import { SlidersHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

/** The board as columns, or as stacked sections for scanning many features at once. */
export function BoardDisplayMenu(props: {
  readonly layout: "board" | "list";
  readonly onLayout: (layout: "board" | "list") => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="ghost" aria-label="Display options">
            <SlidersHorizontalIcon aria-hidden />
            <span className="hidden md:inline">Display</span>
          </Button>
        }
      />
      <MenuPopup align="end">
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
      </MenuPopup>
    </Menu>
  );
}
