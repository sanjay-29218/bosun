import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { BOT_HOME_MAX_BYTES, readHomeFiles, writeHomeFiles } from "./botHomeFiles.ts";

it.layer(NodeServices.layer)("botHomeFiles", (it) => {
  it.effect("carries regular files, skips symlinks, and refuses an oversized home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "bot-home-files-" });
      const home = path.join(tmp, "home");
      yield* fileSystem.makeDirectory(path.join(home, "memory"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(home, "memory", "notes.md"), "Be brief.");
      yield* fileSystem.writeFileString(path.join(tmp, "secret.txt"), "outside");
      yield* fileSystem.symlink(path.join(tmp, "secret.txt"), path.join(home, "link.txt"));

      const read = yield* readHomeFiles(home);
      assert.equal(read._tag, "files");
      const files = read._tag === "files" ? read.files : [];
      assert.deepEqual(
        files.map((file) => file.path),
        ["memory/notes.md"],
      );
      const copy = path.join(tmp, "copy");
      yield* writeHomeFiles(copy, files);
      assert.equal(
        yield* fileSystem.readFileString(path.join(copy, "memory", "notes.md")),
        "Be brief.",
      );

      const escape = yield* writeHomeFiles(copy, [
        { path: "../escaped.txt", contentBase64: "" },
      ]).pipe(Effect.flip);
      assert.equal(escape.message, "../escaped.txt is outside the bot's home folder.");
      assert.isFalse(yield* fileSystem.exists(path.join(tmp, "escaped.txt")));

      yield* fileSystem.writeFile(path.join(home, "big.bin"), new Uint8Array(BOT_HOME_MAX_BYTES));
      assert.equal((yield* readHomeFiles(home))._tag, "too-large");
      // A bot that never got a home has nothing to carry.
      assert.deepEqual(yield* readHomeFiles(path.join(tmp, "missing")), {
        _tag: "files",
        files: [],
      });
    }),
  );
});
