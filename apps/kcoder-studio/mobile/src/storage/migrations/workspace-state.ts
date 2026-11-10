// These are format versions, not client release versions. Existing keys remain
// stable; profile and authorization fences stay with the owning storage writer.
export const WORKSPACE_TAB_V1 = "kcoder-studio:mobile-workspace-tab:v1";
export const WORKSPACE_STATE_V2 = "kcoder-studio:mobile-workspace-state:v2";
export const WORKSPACE_STATE_V3 = "kcoder-studio:mobile-workspace-state:v3";

export function parseWorkspaceStateDocument(bytes: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace_state_corrupt");
  }
  return value as Record<string, unknown>;
}
