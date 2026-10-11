import { describe, expect, it } from "vitest";
import { workspaceAttachmentPathsForThreadDeletion } from "./workspace-attachment-paths";

describe("workspace thread deletion attachment paths", () => {
  it("includes queued and failed attachments once, including unknown submissions", () => {
    expect(
      workspaceAttachmentPathsForThreadDeletion({
        queuedMessages: [
          {
            id: "queued-1",
            content: "queued",
            createdAt: 1,
            attachments: [
              {
                filename: "shared.txt",
                mimeType: "text/plain",
                fileSize: 1,
                path: "/attachments/shared.txt",
              },
            ],
          },
        ],
        failedSubmissions: [
          {
            id: "failed-1",
            content: "failed",
            createdAt: 2,
            outcome: "failed",
            attachments: [
              {
                filename: "shared.txt",
                mimeType: "text/plain",
                fileSize: 1,
                path: "/attachments/shared.txt",
              },
              {
                filename: "failed.txt",
                mimeType: "text/plain",
                fileSize: 2,
                path: "/attachments/failed.txt",
              },
            ],
          },
          {
            id: "unknown-1",
            content: "unknown",
            createdAt: 3,
            outcome: "unknown",
            attachments: [
              {
                filename: "unknown.txt",
                mimeType: "text/plain",
                fileSize: 3,
                path: "/attachments/unknown.txt",
              },
            ],
          },
        ],
      }),
    ).toEqual([
      "/attachments/shared.txt",
      "/attachments/failed.txt",
      "/attachments/unknown.txt",
    ]);
  });
});
