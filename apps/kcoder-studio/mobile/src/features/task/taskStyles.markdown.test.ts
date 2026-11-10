import { describe, expect, it } from "vitest";
import { darkColors, lightColors, radius, spacing } from "@/theme";
import { createTaskMarkdownStyles } from "./taskStyles";

type MarkdownDefaultStyles = {
  body: { color?: string };
  blockquote: {
    color?: string;
    backgroundColor?: string;
    borderLeftColor?: string;
    borderLeftWidth?: number;
    marginVertical?: number;
    paddingHorizontal?: number;
  };
};

const markdownDisplayDefaultStyles = import(
  "react-native-markdown-display/src/lib/styles" as string
).then((module) =>
  (module as unknown as { styles: MarkdownDefaultStyles }).styles,
);

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const match = color.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    if (!match) throw new Error(`Expected a six-digit hex color, received ${color}`);
    const linear = (hex: string) => {
      const channel = Number.parseInt(hex, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(match[1]) + 0.7152 * linear(match[2]) + 0.0722 * linear(match[3]);
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("task markdown styles", () => {
  it("applies reply size and spacing to paragraphs, lists, and quotes while leaving code independent", () => {
    const normal = createTaskMarkdownStyles(darkColors);
    const large = createTaskMarkdownStyles(darkColors, "large", "relaxed");

    expect(large.body.fontSize).toBeGreaterThan(normal.body.fontSize);
    expect(large.body.lineHeight).toBeGreaterThan(normal.body.lineHeight);
    expect(large.paragraph).toMatchObject({ fontSize: large.body.fontSize, lineHeight: large.body.lineHeight });
    expect(large.list_item).toMatchObject({ fontSize: large.body.fontSize, lineHeight: large.body.lineHeight });
    expect(large.bullet_list_content).toMatchObject({ fontSize: large.body.fontSize, lineHeight: large.body.lineHeight });
    expect(large.blockquote).toMatchObject({ fontSize: large.body.fontSize, lineHeight: large.body.lineHeight });
    expect(large.code_inline).toEqual(normal.code_inline);
    expect(large.fence).toEqual(normal.fence);
    expect(large.code_block).toEqual(normal.code_block);
  });

  it.each([
    ["dark", darkColors],
    ["light", lightColors],
  ] as const)("keeps inline code compact in the %s theme", (_name, colors) => {
    const styles = createTaskMarkdownStyles(colors);

    expect(styles.code_inline).toMatchObject({
      color: colors.text,
      backgroundColor: colors.surfaceHover,
      borderWidth: 0,
      borderRadius: radius.sm,
      padding: 0,
      paddingHorizontal: spacing.xs,
      paddingVertical: 1,
      fontFamily: "monospace",
      fontSize: 15,
    });
  });

  it.each([
    ["dark", darkColors],
    ["light", lightColors],
  ] as const)("keeps workspace-file code links underlined in the %s theme", (_name, colors) => {
    expect(createTaskMarkdownStyles(colors).fileCodeLink).toEqual({
      color: colors.accentBright,
      textDecorationLine: "underline",
    });
  });

  it.each([
    ["dark", darkColors],
    ["light", lightColors],
  ] as const)("keeps blockquotes readable after Markdown's default style merge in the %s theme", async (_name, colors) => {
    const defaultStyles = await markdownDisplayDefaultStyles;
    const overrides = createTaskMarkdownStyles(colors);
    const mergedBody = {
      ...defaultStyles.body,
      ...overrides.body,
    };
    const mergedBlockquote = {
      ...defaultStyles.blockquote,
      ...overrides.blockquote,
    };
    const inheritedTextColor = mergedBlockquote.color ?? mergedBody.color;

    expect(mergedBlockquote.backgroundColor).toBe(colors.surfaceHover);
    expect(mergedBlockquote.borderLeftColor).toBe(colors.borderAccent);
    expect(mergedBlockquote.borderLeftWidth).toBe(2);
    expect(mergedBlockquote.marginVertical).toBe(0);
    expect(mergedBlockquote.paddingHorizontal).toBe(spacing.md);
    expect(contrastRatio(inheritedTextColor, mergedBlockquote.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });
});
