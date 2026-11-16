import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

/** A bot's home folder travels whole over the link, so it stays well under any request limit. */
export const BOT_HOME_MAX_BYTES = 8 * 1024 * 1024;
const BOT_HOME_MAX_FILES = 1_000;

/** One regular file in a bot's home, by its path inside the home. */
export interface BotHomeFile {
  readonly path: string;
  readonly contentBase64: string;
}

export type ReadHomeFilesResult =
  | { readonly _tag: "files"; readonly files: ReadonlyArray<BotHomeFile> }
  | { readonly _tag: "too-large"; readonly bytes: number; readonly count: number };

const megabytes = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;

export const tooLargeMessage = (
  name: string,
  result: { readonly bytes: number; readonly count: number },
) =>
  result.count > BOT_HOME_MAX_FILES
    ? `${name}'s home folder has ${result.count} files. Bots can take up to ${BOT_HOME_MAX_FILES} to another machine.`
    : `${name}'s home folder is ${megabytes(result.bytes)}. Bots can take up to ${megabytes(BOT_HOME_MAX_BYTES)} to another machine.`;

/** The regular files under `root`, symlinks skipped; nothing when it doesn't exist. */
export const readHomeFiles = Effect.fn("botHomeFiles.read")(function* (
  root: string,
): Effect.fn.Return<
  ReadHomeFilesResult,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fileSystem.exists(root))) {
    return { _tag: "files", files: [] };
  }
  const entries = (yield* fileSystem.readDirectory(root, { recursive: true })).toSorted();
  const regular: Array<{ readonly path: string; readonly size: number }> = [];
  let bytes = 0;
  for (const entry of entries) {
    const info = yield* fileSystem.lstat(path.join(root, entry));
    if (info.type !== "File") continue;
    regular.push({ path: entry.split(path.sep).join("/"), size: Number(info.size) });
    bytes += Number(info.size);
  }
  if (regular.length > BOT_HOME_MAX_FILES || bytes > BOT_HOME_MAX_BYTES) {
    return { _tag: "too-large", bytes, count: regular.length };
  }
  const files = yield* Effect.forEach(regular, (file) =>
    fileSystem
      .readFile(path.join(root, file.path))
      .pipe(
        Effect.map((content) => ({ path: file.path, contentBase64: Encoding.encode(content) })),
      ),
  );
  return { _tag: "files", files };
});

/** Writes `files` under `root`; a path that would leave `root` is refused. */
export const writeHomeFiles = Effect.fn("botHomeFiles.write")(function* (
  root: string,
  files: ReadonlyArray<BotHomeFile>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = path.resolve(root);
  for (const file of files) {
    const target = path.resolve(base, file.path);
    if (!target.startsWith(`${base}${path.sep}`)) {
      return yield* Effect.fail(`${file.path} is outside the bot's home folder.`);
    }
    const content = yield* Effect.fromResult(Encoding.decode(file.contentBase64)).pipe(
      Effect.mapError(() => `${file.path} isn't valid base64.`),
    );
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFile(target, content);
  }
});
