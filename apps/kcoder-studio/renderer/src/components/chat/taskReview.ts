import { normalizeReviewEvidence } from '../../../../shared/reviewEvidence'
import type { ToolBlock, WorkbenchMessage } from '@/types/workbench'
import { normalizeTurnFileCapture } from '../../../../shared/turnFileCapture'
import {
  getFileInputPaths,
  isCommandToolName,
  isFileCreateToolName,
  isFileEditToolName,
} from './blocks/toolBlockKinds'

export function taskReviewFacts(message: WorkbenchMessage) {
  const review = normalizeReviewEvidence(message.reviewEvidence, { turnId: message.turnId ?? undefined, attemptId: message.attemptId })
  const capture = normalizeTurnFileCapture(message.fileChangesCapture, {
    turnId: message.turnId ?? undefined,
    attemptId: message.attemptId,
  })
  const tools = (message.blocks ?? []).filter((block): block is ToolBlock => block.type === 'tool')
  const commands = tools.filter(block => isCommandToolName(block.toolName))
  const files = new Set(message.fileChanges?.files.map(file => file.path) ?? [])
  const deleted = new Set(
    message.fileChanges?.files.filter(file => file.change_type === 'deleted').map(file => file.path)
  )
  const previewFiles = new Set(
    message.fileChanges?.files.filter(file => file.change_type !== 'deleted').map(file => file.path)
  )
  let hasResult = Boolean(message.fileChanges || message.attachments?.length)
  for (const tool of tools) {
    if (isFileCreateToolName(tool.toolName) || isFileEditToolName(tool.toolName)) {
      hasResult = true
      const nativeName = tool.toolName.trim().toLowerCase().replace(/^functions\./, '')
      const workspaceWrite = !nativeName.includes('.') && !nativeName.includes('__')
      for (const path of getFileInputPaths(tool)) {
        files.add(path)
        if (workspaceWrite && tool.status === 'done' && tool.toolOutput !== undefined && !deleted.has(path))
          previewFiles.add(path)
      }
    }
    if (tool.toolName === 'show_widget') hasResult = true
  }
  return {
    commands,
    files: [...files],
    previewFiles: [...previewFiles].filter(path =>
      path.length > 0 && path.length <= 4096 &&
      Array.from(path).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    ),
    visible: hasResult || commands.length > 0 || Boolean(capture) || Boolean(review),
    ...(review && { review }),
    ...(capture && { capture }),
  }
}

export function taskFeedbackContext(message: WorkbenchMessage): string {
  const fields = [
    ['message', message.id],
    ['task', message.taskId],
    ['subtask', message.subtaskId],
    ['turn', message.turnId],
    ['attempt', message.attemptId],
  ] as const
  const identity = fields
    .filter(
      (field): field is readonly [(typeof field)[0], string] =>
        typeof field[1] === 'string' && field[1].length > 0 && field[1].length <= 512
    )
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
  const files = taskReviewFacts(message)
    .files.filter(path => path.length <= 4096)
    .slice(0, 10)
  return [...identity, ...files.map(path => `file: ${JSON.stringify(path)}`)].join('\n')
}
