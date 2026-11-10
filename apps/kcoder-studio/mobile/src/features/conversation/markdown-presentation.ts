import type { RenderRules } from 'react-native-markdown-display';
import type { InterfaceVersion } from '@/storage/app-preferences';
import { markdownReadingRules } from './markdown-reading-rules';
import { longformMarkdownRules } from './longform-markdown-rules';
import { stableMarkdownRules } from './stable-markdown-rules';

/** One version boundary for live, cached, thinking and subagent Markdown. */
export function createConversationMarkdownRules(version: InterfaceVersion, overrides: RenderRules = {}): RenderRules {
  const rules = { ...(version === 'v3' ? longformMarkdownRules : markdownReadingRules), ...overrides };
  return version === 'v3' ? stableMarkdownRules(rules) : rules;
}
