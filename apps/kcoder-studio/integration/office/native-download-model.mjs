// Deterministic Provider protocol steps only. Native tools generate all files.
import { createHash } from 'node:crypto';
export const claimPrompt = 'OFFICE_NATIVE_BROWSER_CLAIM_FIXTURE';
export const claimTitle = 'Native Office browser claim';
export const discoveryCall = 'office-browser-discover';
export const documentCall = 'office-browser-create';

export function claimSpecification(seed) {
  // Independent digest blocks give an incompressible literal document whose
  // actual ZIP output must cross the existing direct-preview limit.
  const paragraphs = [{ text: 'Literal fixture: approved amount 1234.56; responsible person pending confirmation.' }];
  for (let paragraph = 0; paragraph < 48; paragraph++) {
    let text = '';
    for (let block = 0; text.length < 9600; block++)
      text += createHash('sha256').update(`${seed}:${paragraph}:${block}`).digest('base64');
    paragraphs.push({ text: text.slice(0, 9600) });
  }
  return { schemaVersion: 1, kind: 'docx', title: claimTitle, paragraphs };
}
export function toolResult(body, id) {
  const message = [...(body.messages ?? [])].reverse().find(item => item.role === 'tool' && item.tool_call_id === id);
  if (!message) return null;
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  try { return JSON.parse(text); } catch { return { text }; }
}
export function discoveryResult(body) {
  const value = toolResult(body, discoveryCall);
  if (!value || typeof value.text !== 'string') throw new Error('Native discovery Markdown receipt missing');
  const fenced = value.text.match(/```json\s*([\s\S]*?)```/);
  if (!fenced) throw new Error('Native discovery JSON metadata missing');
  return JSON.parse(fenced[1]);
}
export function toolSteps(id, name, input) {
  return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }, { finishReason: 'tool_calls' }];
}
