/** Decode the actual Rust description literal; never synthesize a historical prompt. */
export function extractWorkflowDescription(source) {
  const body = source.split('fn description(&self) -> String {')[1];
  if (!body) throw new Error('historical WorkflowDraft description method missing');
  const raw = body.match(/^\s*r#"([\s\S]*?)"#\.into\(\)/);
  if (raw) return raw[1];
  const quoted = body.match(/^\s*("(?:\\.|[^"\\])*")\.into\(\)/);
  if (!quoted) throw new Error('unsupported historical Rust description literal; do not invent a replacement');
  return JSON.parse(quoted[1]);
}

/** Streaming usage is cumulative; Anthropic cached context is separate from input. */
export function contextInputUsage(rows, apiFormat) {
  if (!['anthropic_messages', 'openai_chat_completions', 'openai_responses'].includes(apiFormat)) throw new Error('unsupported actual usage semantics');
  return rows.reduce((total, row) => total + Math.max(0, ...row.usageEvents.map(usage => usage.input_tokens +
    (apiFormat === 'anthropic_messages' ? (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : 0))), 0);
}
