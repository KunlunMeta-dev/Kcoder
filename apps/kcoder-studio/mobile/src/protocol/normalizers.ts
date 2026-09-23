export function visibleUserContent(content: string): string {
  return content
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/gi, "")
    .replace(/<kcoder_client_context[^>]*>[\s\S]*?<\/kcoder_client_context>\s*/gi, "")
    .replace(/<kcoder_client_attachments>[\s\S]*?<\/kcoder_client_attachments>\s*/gi, "")
    .replace(/<kcoder_attachments[^>]*>[\s\S]*?<\/kcoder_attachments>\s*/gi, "")
    .trim();
}

export function timestampMs(value: string | number): number {
  const parsed =
    typeof value === "number"
      ? value
      : /^\d{10,16}$/.test(value.trim())
        ? Number(value)
        : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r(?!\n)/g, "");
}
