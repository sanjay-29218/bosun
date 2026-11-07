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
import { createAttachmentId } from "../attachmentStore.ts";
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
