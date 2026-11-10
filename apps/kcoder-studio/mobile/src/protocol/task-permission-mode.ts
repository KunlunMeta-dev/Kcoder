export const TASK_PERMISSION_MODES = [
  "default",
  "ask",
  "auto",
  "accept_edits",
  "dont_ask",
  "bypass",
  "yolo",
] as const;

export type PermissionMode = (typeof TASK_PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    TASK_PERMISSION_MODES.includes(value as PermissionMode)
  );
}
