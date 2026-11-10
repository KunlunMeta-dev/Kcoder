import { cloneElement, isValidElement } from 'react';
import { View, type ViewStyle } from 'react-native';
import { renderRules, type RenderRules } from 'react-native-markdown-display';
import { markdownReadingRules } from './markdown-reading-rules';
import { MarkdownTable } from './MarkdownTable';

const isHeading = (type?: string) => /^heading[1-6]$/.test(type ?? '');
type ReadingStyles = Record<string, ViewStyle>;

export function readingBlockStyle(type: string, previous: string | undefined, styles: ReadingStyles): ViewStyle {
  // One stack owns block spacing; headings have a larger lead-in and a shorter follow-on.
  return !previous ? { marginTop: 0 } : isHeading(type) && !isHeading(previous) ? styles.readingSection
    : isHeading(previous) ? styles.readingHeadingBody : styles.readingBlock;
}

/** Retain Markdown's parser and inline rules; only the V3 block layout changes. */
export const longformMarkdownRules: RenderRules = {
  ...markdownReadingRules,
  body: (node, children, _parents, styles: ReadingStyles) => <View key={node.key} testID="conversation-markdown-body" style={styles._VIEW_SAFE_body}>
    {children.map((child, index) => child == null ? null : <View key={node.children[index].key}
      testID="conversation-markdown-block" style={[{ minWidth: 0 }, readingBlockStyle(node.children[index].type, node.children[index - 1]?.type, styles)]}>{child}</View>)}
  </View>,
  table: (node, children, _parents, styles) => <MarkdownTable key={node.key} node={node} styles={styles}>{children}</MarkdownTable>,
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`heading${level}`, (...args: Parameters<NonNullable<RenderRules[string]>>) => {
    const rendered = renderRules[`heading${level}`]!(...args);
    return isValidElement(rendered) ? cloneElement(rendered, { testID: 'conversation-markdown-heading', accessibilityRole: 'header', 'aria-level': level } as Record<string, unknown>) : rendered;
  }])),
};
