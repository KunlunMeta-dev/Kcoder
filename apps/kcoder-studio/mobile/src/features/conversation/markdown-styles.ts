import { Platform } from "react-native";
import { chatTypography, radius, spacing, type ThemeColors } from "@/theme";
import type { ConversationFontScale, ConversationLineSpacing, ConversationSpacing, InterfaceVersion } from "@/storage/app-preferences";
import { conversationBlockGap, conversationLetterGap } from "../../../../shared/conversationReading";
import { longformMarkdownStyles } from "./longform-markdown-styles";
import { legacyMarkdownRecipe, markdownBodySizes, markdownLineHeightRatios } from "./markdown-reading-theme";

// Platform styles adapt the reading recipe; message/layout styles do not own Markdown metrics.
export const createTaskMarkdownStyles = (
  colors: ThemeColors,
  fontScale: ConversationFontScale = "normal",
  lineSpacing: ConversationLineSpacing = "normal",
  blockSpacing: ConversationSpacing = "normal",
  letterSpacing: ConversationSpacing = "normal",
  fontFamily?: string,
  boldFontFamily?: string,
  interfaceVersion: InterfaceVersion = "modern",
) => {
  const fontSize = markdownBodySizes[fontScale];
  const lineHeight = Math.round(fontSize * markdownLineHeightRatios[lineSpacing]);
  const gap = conversationBlockGap[blockSpacing];
  const bodyTypography = { fontSize, lineHeight, letterSpacing: conversationLetterGap[letterSpacing], ...(fontFamily ? { fontFamily } : {}) };
  const headingTypography = { letterSpacing: bodyTypography.letterSpacing, ...(boldFontFamily ? { fontFamily: boldFontFamily, fontWeight: "normal" as const } : {}) };
  const headingScale = fontSize / markdownBodySizes.normal;
  const heading = (index: number) => ({ ...headingTypography, color: colors.text,
    fontSize: Math.round(legacyMarkdownRecipe.headings[index][0] * headingScale),
    lineHeight: Math.round(legacyMarkdownRecipe.headings[index][1] * headingScale) });
  const styles = {
  body: {
    gap,
    color: colors.text,
    ...bodyTypography,
    ...(Platform.OS === "web"
      ? { overflowWrap: "anywhere" as const, wordBreak: "break-word" as const }
      : {}),
  },
  heading1: heading(0),
  heading2: heading(1),
  heading3: heading(2),
  heading4: heading(3),
  heading5: heading(4),
  heading6: heading(5),
  blockquote: {
    color: colors.text,
    ...bodyTypography,
    backgroundColor: colors.surfaceHover,
    borderColor: colors.border,
    borderLeftColor: colors.borderAccent,
    borderLeftWidth: 2,
    marginLeft: spacing.xs,
    marginVertical: 0,
    gap,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  paragraph: { marginTop: 0, marginBottom: 0, ...bodyTypography },
  list_item: { flexDirection: "row" as const, justifyContent: "flex-start" as const, ...bodyTypography },
  bullet_list_content: { flex: 1, gap, ...bodyTypography },
  ordered_list_content: { flex: 1, gap, ...bodyTypography },
  code_inline: {
    color: colors.text,
    backgroundColor: colors.surfaceHover,
    borderWidth: 0,
    borderRadius: radius.sm,
    padding: 0,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    fontFamily: "monospace",
    ...chatTypography.inlineCode,
  },
  fence: {
    fontFamily: "monospace", fontSize: 12, lineHeight: 18, letterSpacing: 0,
    color: colors.text,
    backgroundColor: colors.background,
    borderColor: colors.border,
    padding: 12,
  },
  code_block: {
    fontFamily: "monospace", fontSize: 12, lineHeight: 18, letterSpacing: 0,
    color: colors.text,
    backgroundColor: colors.background,
    borderColor: colors.border,
    padding: 12,
  },
  bullet_list: { marginTop: 0, marginBottom: 0, gap: spacing.xs },
  ordered_list: { marginTop: 0, marginBottom: 0, gap: spacing.xs },
  table: { marginTop: 0, marginBottom: 0, ...bodyTypography },
  th: { ...bodyTypography, gap },
  td: { ...bodyTypography, gap },
  strong: { fontWeight: "700" as const, ...headingTypography },
  link: { color: colors.blue },
  fileCodeLink: {
    color: colors.accentBright,
    textDecorationLine: "underline" as const,
  },
  };
  if (interfaceVersion !== "v3") return styles;
  const reading = longformMarkdownStyles(colors, bodyTypography, gap, boldFontFamily);
  return { ...styles, ...reading, body: { ...styles.body, ...reading.body } };
};
