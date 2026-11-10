import type { ConversationFontScale, ConversationLineSpacing } from '@/storage/app-preferences';

// Reading preferences affect prose, not UI controls, code or terminal metrics.
export const markdownBodySizes: Record<ConversationFontScale, number> = { small: 15, normal: 17, large: 19 };
export const markdownLineHeightRatios: Record<ConversationLineSpacing, number> = {
  compact: 1.45, snug: 1.55, normal: 1.65, relaxed: 1.85, airy: 2.05,
};

// V1 and V2 intentionally share their established presentation.
export const legacyMarkdownRecipe = {
  headings: [[32, 38], [24, 31], [18, 25], [16, 23], [13, 20], [11, 18]],
} as const;

// Versioned visual decisions. Semantic colors, spacing and radii come from theme.ts.
export const v3MarkdownRecipe = {
  baseFontSize: 17,
  headings: [[26, 35], [22, 31], [19, 28], [17, 27], [17, 27], [17, 27]],
  rhythm: { section: 1.75, afterHeading: 0.65, listItem: 0.5 },
  list: { bulletMarkerWidth: 12, orderedMarkerWidth: 22 },
  quote: { leadingBorderWidth: 3 },
  table: { textScale: 0.88, fallbackLineHeight: 28, borderWidth: 1 },
} as const;
