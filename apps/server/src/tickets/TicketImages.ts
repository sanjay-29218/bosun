import {
  ISSUE_IMAGE_MAX_BYTES,
  TICKET_IMAGE_PREFIX,
  TicketOperationError,
  type IssueImageUpload,
  type IssueImageUploadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

/** Pasted images a ticket keeps, by the extension the attachment store serves them with. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Stores an image pasted into a ticket with the environment's attachments, where no thread's
 * cleanup reaches it. A ticket is private to the environment, so its images stay there too.
 */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const fail = (reason: string) => Effect.fail(new TicketOperationError({ reason }));

  const upload = Effect.fn("TicketImages.upload")(function* (input: IssueImageUploadInput) {
    const [, mimeType = "", base64 = ""] = /^data:([^;]+);base64,(.*)$/su.exec(input.dataUrl) ?? [];
    const extension = IMAGE_EXTENSIONS[mimeType.toLowerCase()];
    if (extension === undefined) {
      return yield* fail("Only PNG, JPEG, GIF and WebP images can go in a ticket.");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > ISSUE_IMAGE_MAX_BYTES) {
      return yield* fail("Images in a ticket are at most 10 MB.");
    }
    const id = createAttachmentId("ticket");
    const path =
      id === null
        ? null
        : resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${id}${extension}`,
          });
    if (id === null || path === null) return yield* fail("The image could not be stored.");
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFile(path, bytes)),
      Effect.catch((error) =>
        Effect.logWarning("Storing a ticket image failed", { error }).pipe(
          Effect.andThen(fail("The image could not be stored.")),
        ),
      ),
    );
    return { url: `${TICKET_IMAGE_PREFIX}${id}` } satisfies IssueImageUpload;
  });

  return { upload };
});

// An image's destination, with Markdown's optional angle brackets and title: `![a](attachment:id)`,
// `![a](<attachment:id> "Caption")`. The scheme matches in any case, as a URL's does.
const TICKET_IMAGE_DESTINATION =
  /(!\[[^\]\n]*\]\(\s*)<?attachment:([a-z0-9_-]+)>?((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))/giu;
// Any other place a stored image could be named, such as an HTML `<img src>`, which can't move.
const ANY_TICKET_IMAGE = /(?:\(|<|["'=\s])attachment:[a-z0-9_-]+/iu;
const MIME_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * A ticket's Markdown for somewhere `attachment:` doesn't resolve, such as a GitHub issue: each
 * image it names goes through `upload` and the link becomes the uploaded one. Fails, naming the
 * image, when one can't be read or uploaded, so the ticket isn't moved with a broken image.
 */
export const withUploadedImages = Effect.fn("TicketImages.withUploadedImages")(function* (
  markdown: string,
  upload: (image: {
    readonly fileName: string;
    readonly dataUrl: string;
  }) => Effect.Effect<{ readonly url: string }, TicketOperationError>,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const ids = [
    ...new Set(
      [...markdown.matchAll(TICKET_IMAGE_DESTINATION)].map((match) => match[2]!.toLowerCase()),
    ),
  ];
  const urls = new Map<string, string>();
  for (const id of ids) {
    const missing = new TicketOperationError({
      reason: `The ticket's image ${id} couldn't be read, so the ticket stays.`,
    });
    const path = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: id,
    });
    const extension = path?.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = MIME_TYPES[extension];
    if (path === null || mimeType === undefined) return yield* missing;
    const bytes = yield* fileSystem.readFile(path).pipe(Effect.mapError(() => missing));
    const { url } = yield* upload({
      fileName: `${id}.${extension}`,
      dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    });
    urls.set(id, url);
  }
  const rewritten = markdown.replace(
    TICKET_IMAGE_DESTINATION,
    (_match, before: string, id: string, after: string) =>
      `${before}${urls.get(id.toLowerCase())}${after}`,
  );
  if (ANY_TICKET_IMAGE.test(rewritten)) {
    return yield* new TicketOperationError({
      reason: "The ticket names a stored image in a form that can't move to GitHub, so it stays.",
    });
  }
  return rewritten;
});
