import { ProjectId, ticketImageAttachmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as TicketImages from "./TicketImages.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-ticket-images-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-1");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it.effect("stores a ticket's image where the attachment route serves it", () =>
  Effect.gen(function* () {
    const images = yield* TicketImages.make;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    const { url } = yield* images.upload({
      projectId,
      fileName: "shot.png",
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    });
    const attachmentId = ticketImageAttachmentId(url);
    assert.isNotNull(attachmentId);
    const path = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: attachmentId!,
    });
    assert.isNotNull(path);
    assert.deepStrictEqual(Buffer.from(yield* fileSystem.readFile(path!)), png);

    const refused = yield* images
      .upload({ projectId, fileName: "shot.svg", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" })
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "Only PNG, JPEG, GIF and WebP images can go in a ticket.");
  }).pipe(Effect.provide(layer)),
);
