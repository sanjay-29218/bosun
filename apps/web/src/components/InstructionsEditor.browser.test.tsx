import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { InstructionsEditor } from "./InstructionsEditor";

let stored = "";

function Harness({ initial, maxLength }: { initial: string; maxLength?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <InstructionsEditor
      label="Instructions"
      value={value}
      onChange={(next) => {
        stored = next;
        setValue(next);
      }}
      {...(maxLength === undefined ? {} : { maxLength })}
    />
  );
}

it("keeps mentions and skills as literal text", async () => {
  await using screen = await render(
    <Harness initial="Ask @reviewer to run $deploy and read [notes](docs/notes.md)" />,
  );
  await expect
    .element(page.getByRole("textbox", { name: "Instructions" }))
    .toHaveTextContent("Ask @reviewer to run $deploy and read [notes](docs/notes.md)");
  expect(screen.container.querySelector("[data-composer-mention],[data-composer-skill]")).toBe(
    null,
  );
});

it("formats the caret's line from the toolbar and stores Markdown", async () => {
  await using _screen = await render(<Harness initial="" />);
  const editor = page.getByRole("textbox", { name: "Instructions" });
  await userEvent.click(editor);
  await userEvent.keyboard("Check tests");
  await userEvent.click(page.getByRole("button", { name: "Bulleted list" }));
  await expect.poll(() => stored).toBe("- Check tests");
  await userEvent.keyboard(" @now");
  await expect.poll(() => stored).toBe("- Check tests @now");
  await userEvent.click(page.getByRole("button", { name: "Bulleted list" }));
  await expect.poll(() => stored).toBe("Check tests @now");
});

it("stops growing the Markdown at maxLength", async () => {
  await using _screen = await render(<Harness initial="abc" maxLength={4} />);
  await userEvent.click(page.getByRole("textbox", { name: "Instructions" }));
  await userEvent.keyboard("{End}def");
  await expect.poll(() => stored).toBe("abcd");
  await userEvent.keyboard("{Backspace}");
  await expect.poll(() => stored).toBe("abc");
});
