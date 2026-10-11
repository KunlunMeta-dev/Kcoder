const MAX_APPROVAL_ACTION_CHARACTERS = 4_000;

export interface ApprovalActionPresentation {
  text: string;
  safeToApprove: boolean;
}

function limitedText(value: string): ApprovalActionPresentation {
  if (value.length <= MAX_APPROVAL_ACTION_CHARACTERS)
    return { text: value, safeToApprove: true };
  return {
    text: `${value.slice(0, MAX_APPROVAL_ACTION_CHARACTERS)}\n… [input truncated; ${value.length} characters total]`,
    safeToApprove: false,
  };
}

function limitedJson(value: unknown): ApprovalActionPresentation {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined)
      return {
        text: "[input cannot be serialized; approval disabled]",
        safeToApprove: false,
      };
    return limitedText(serialized);
  } catch {
    return {
      text: "[input cannot be displayed safely; approval disabled]",
      safeToApprove: false,
    };
  }
}

export function approvalActionPresentation(
  action: Record<string, unknown>,
): ApprovalActionPresentation {
  if (action.type === "command")
    return limitedText(String(action.command ?? "Shell command"));
  if (action.type === "file_change")
    return limitedText(String(action.path ?? "File change"));
  if (action.type === "tool") {
    const name = String(action.name ?? "Unknown tool");
    if (!Object.hasOwn(action, "input"))
      return {
        text: `Tool: ${name}\nInput: [missing input; approval disabled]`,
        safeToApprove: false,
      };
    const input = limitedJson(action.input);
    return {
      text: `Tool: ${name}\nInput: ${input.text}`,
      safeToApprove: input.safeToApprove,
    };
  }
  return limitedJson(action);
}

export function actionDescription(action: Record<string, unknown>): string {
  return approvalActionPresentation(action).text;
}
