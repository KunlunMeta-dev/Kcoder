import { expect, it } from "vitest";
import { workspaceFileDraftForOpen } from "./workspace-file-draft";

const draft = { path: "/workspace/a.ts", revision: "old-revision", content: "saved edit", updatedAt: 1 };
const disk = { path: draft.path, revision: "new-revision", content: draft.content, editable: true, truncated: false };

it.each(["old-revision", "new-revision"])("does not restore or conflict when disk already contains the draft at %s", revision => {
  expect(workspaceFileDraftForOpen(draft, { ...disk, revision })).toBeUndefined();
});

it("preserves a real edit for the existing conflict check", () => {
  expect(workspaceFileDraftForOpen(draft, { ...disk, content: "changed externally" })).toBe(draft);
});

it("preserves an empty draft that intentionally clears a nonempty file", () => {
  const cleared = { ...draft, content: "" };
  expect(workspaceFileDraftForOpen(cleared, disk)).toBe(cleared);
});

it.each([{ truncated: true }, { editable: false }])("does not treat a limited preview as confirmation: %j", limitations => {
  expect(workspaceFileDraftForOpen(draft, { ...disk, ...limitations })).toBe(draft);
});

it("does not attach a draft to a different file", () => {
  expect(workspaceFileDraftForOpen(draft, { ...disk, path: "/workspace/b.ts" })).toBeUndefined();
  expect(workspaceFileDraftForOpen(undefined, disk)).toBeUndefined();
});
