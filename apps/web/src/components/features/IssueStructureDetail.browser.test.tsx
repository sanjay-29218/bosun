import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { MilestoneChip } from "./IssueStructureDetail";

const milestones = [
  {
    number: 8,
    title: "Bots across environments",
    url: "",
    dueOn: null,
    openIssues: 3,
    closedIssues: 1,
  },
  { number: 9, title: "Later", url: "", dueOn: null, openIssues: 0, closedIssues: 0 },
];

it("the milestone menu opens and a pick changes the milestone", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <MilestoneChip
      milestone={{ number: 8, title: "Bots across environments" }}
      milestones={milestones}
      editable
      busy={false}
      onChange={onChange}
      onShowOnBoard={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Milestone" }));
  await expect.element(page.getByRole("menuitemradio", { name: "No milestone" })).toBeVisible();

  await userEvent.click(page.getByRole("menuitemradio", { name: /Later/ }));
  expect(onChange).toHaveBeenCalledWith({ milestone: { number: 9, title: "Later" } });
  await expect
    .element(page.getByRole("menuitemradio", { name: "No milestone" }))
    .not.toBeInTheDocument();
});
