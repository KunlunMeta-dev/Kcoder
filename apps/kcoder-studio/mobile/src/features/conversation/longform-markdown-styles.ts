import { spacing, radius, type ThemeColors } from '@/theme';
import type { TextStyle } from 'react-native';
import { v3MarkdownRecipe as recipe } from './markdown-reading-theme';

/** V3 reading rhythm; user preferences remain the source of body metrics. */
export function longformMarkdownStyles(colors: ThemeColors, body: TextStyle, gap: number, boldFontFamily?: string) {
  const size = body.fontSize ?? recipe.baseFontSize;
  const scale = size / recipe.baseFontSize;
  const bold: TextStyle = boldFontFamily ? { fontFamily: boldFontFamily, fontWeight: 'normal' } : { fontWeight: '700' };
  const heading = (fontSize: number, lineHeight: number) => ({ ...body, ...bold, color: colors.text,
    fontSize: Math.round(fontSize * scale), lineHeight: Math.round(lineHeight * scale), marginTop: 0, marginBottom: 0 });
  const tableText = { ...body, fontSize: Math.round(size * recipe.table.textScale), lineHeight: Math.round((body.lineHeight ?? recipe.table.fallbackLineHeight) * recipe.table.textScale),
    minWidth: 0, flex: 1, paddingHorizontal: spacing.sm + spacing.xs, paddingVertical: spacing.sm, gap: spacing.xs };
  return {
    body: { ...body, gap: 0, width: '100%' as const, minWidth: 0 },
    readingBlock: { marginTop: gap },
    readingSection: { marginTop: Math.round(gap * recipe.rhythm.section) },
    readingHeadingBody: { marginTop: Math.round(gap * recipe.rhythm.afterHeading) },
    heading1: heading(...recipe.headings[0]),
    heading2: heading(...recipe.headings[1]),
    heading3: heading(...recipe.headings[2]),
    heading4: heading(...recipe.headings[3]),
    heading5: heading(...recipe.headings[4]),
    heading6: { ...heading(...recipe.headings[5]), color: colors.textMuted },
    paragraph: { ...body, marginTop: 0, marginBottom: 0, minWidth: 0 },
    bullet_list: { marginTop: 0, marginBottom: 0, gap: Math.round(gap * recipe.rhythm.listItem), minWidth: 0 },
    ordered_list: { marginTop: 0, marginBottom: 0, gap: Math.round(gap * recipe.rhythm.listItem), minWidth: 0 },
    bullet_list_icon: { marginLeft: 0, marginRight: spacing.sm, minWidth: recipe.list.bulletMarkerWidth, color: colors.textMuted },
    ordered_list_icon: { marginLeft: 0, marginRight: spacing.sm, minWidth: recipe.list.orderedMarkerWidth, textAlign: 'right' as const, flexShrink: 0, color: colors.textMuted },
    bullet_list_content: { ...body, flex: 1, minWidth: 0, gap: Math.round(gap * recipe.rhythm.listItem) },
    ordered_list_content: { ...body, flex: 1, minWidth: 0, gap: Math.round(gap * recipe.rhythm.listItem) },
    blockquote: { ...body, color: colors.text, marginLeft: 0, marginVertical: 0, minWidth: 0,
      gap, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderLeftWidth: recipe.quote.leadingBorderWidth, borderLeftColor: colors.borderAccent,
      backgroundColor: colors.surfaceHover, borderRadius: radius.md },
    hr: { height: 1, backgroundColor: colors.border, marginTop: 0, marginBottom: 0 },
    tableFrame: { maxWidth: '100%' as const, minWidth: 0, borderWidth: recipe.table.borderWidth, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' as const },
    table: { borderWidth: 0, marginTop: 0, marginBottom: 0, minWidth: 0 },
    tr: { flexDirection: 'row' as const, borderBottomWidth: recipe.table.borderWidth, borderColor: colors.border },
    thead: { backgroundColor: colors.surfaceHover },
    th: { ...tableText, ...bold, color: colors.text },
    td: { ...tableText, color: colors.text },
  };
}
