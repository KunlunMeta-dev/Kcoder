export function parseOllamaServerLogEvidence(text) {
  const truncations = [...text.matchAll(/truncating input prompt["']?\s+limit=(\d+) prompt=(\d+) keep=(\d+) new=(\d+)/g)]
    .map(match => ({
      limit: Number(match[1]),
      prompt: Number(match[2]),
      keep: Number(match[3]),
      newCount: Number(match[4]),
    }));
  const processedPromptCounts = [...text.matchAll(/(?:prompt processing reaches n_tokens=|prompt processing,\s*n_tokens\s*=\s*)(\d+)/g)]
    .map(match => Number(match[1]));
  const runnerContexts = [...text.matchAll(/\bn_ctx\s*=\s*(\d+)/g)]
    .map(match => Number(match[1]));
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    truncations,
    processedPromptCounts,
    runnerContexts,
  };
}
