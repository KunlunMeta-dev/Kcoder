import { expect, it } from "vitest";
import { historicalControls } from "./migration-history-controls";
it("a failed archive can explicitly resume even without cancellation, while run cannot bypass Native resume", () => {
  expect(historicalControls("history", "failed")).toMatchObject({ run: false, resume: true });
  expect(historicalControls("history", "cancelled", true)).toMatchObject({ run: false, resume: true });
});
it("a sealed archive with Native SQLite recovery-required retains its explicit writer repair entrance", () => {
  expect(historicalControls("history", "normalized", false, false, "history_projection_recovery_required").run).toBe(true);
  expect(historicalControls("history", "normalized").run).toBe(false);
  expect(historicalControls("history", "normalized", false, true, "history_projection_recovery_required").run).toBe(false);
});
it("failed branch/tool/attachment jobs require explicit resume independently of the cancel flag", () => {
  for (const family of ["branch", "tools", "attachment"] as const) {
    expect(historicalControls(family, "failed")).toMatchObject({ run: false, resume: true });
    expect(historicalControls(family, "ready")).toMatchObject({ run: false, resume: false, cancel: false });
    expect(historicalControls(family, "failed", false, true).resume).toBe(false);
  }
});
it("continuation crash and unknown-publication states remain explicitly resumable without pretending they are imported", () => {
  for (const stage of ["preparing", "admitting", "publishing", "publish_unknown", "failed", "blocked", "cancelled"]) expect(historicalControls("continuation", stage)).toMatchObject({ run: false, resume: true });
  expect(historicalControls("continuation", "planned")).toMatchObject({ run: true, resume: false });
  expect(historicalControls("continuation", "imported")).toMatchObject({ run: false, resume: false, cancel: false });
});
