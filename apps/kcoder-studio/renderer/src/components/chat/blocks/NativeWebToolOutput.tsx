import type { ToolBlock } from '@/types/workbench'
import { terminalOutputToText } from '@/lib/terminal-text'

/** Ordinary output is readable detail and never evidence for source badges. */
export function NativeWebToolOutput({ block }: { block: ToolBlock }) {
  const output = typeof block.toolOutput === 'string'
    ? block.toolOutput
    : block.toolOutput === undefined ? '' : JSON.stringify(block.toolOutput, null, 2)
  return output ? <pre data-testid="web-tool-output" className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-bg px-3 py-2 text-xs leading-5 text-text-secondary">{terminalOutputToText(output)}</pre> : null
}
