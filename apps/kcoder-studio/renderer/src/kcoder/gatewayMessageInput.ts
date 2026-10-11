export function messagePrompt(execution: Record<string, unknown>, message: unknown): string {
  const prompt =
    typeof execution.prompt === 'string' && execution.prompt.trim()
      ? execution.prompt.trim()
      : typeof message === 'string'
        ? message.trim()
        : ''
  if (!prompt && !(Array.isArray(execution.attachments) && execution.attachments.length > 0)) {
    throw new Error('消息不能为空')
  }
  // Attachment ownership and content validation still happen before creating a thread.
  return prompt
}

export function messageTitle(execution: Record<string, unknown>, prompt: string): string {
  if (prompt) return prompt.split(/\r?\n/, 1)[0].slice(0, 80)
  const first = Array.isArray(execution.attachments) ? execution.attachments[0] : null
  return (
    typeof first?.filename === 'string' && first.filename.trim()
      ? first.filename.trim()
      : 'Attachment'
  ).slice(0, 80)
}
