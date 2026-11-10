import React from "react";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { StyleSheet } from "react-native";
import Markdown, { renderRules, type RenderRules } from "react-native-markdown-display";
import { darkColors } from "@/theme";
import { createTaskMarkdownStyles, createTaskStyles } from "@/features/task/taskStyles";
import { markdownReadingRules } from "./markdown-reading-rules";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup(element: React.ReactNode): string };
vi.mock("react-native-fit-image", () => ({ default: () => null }));

describe("conversation Markdown AST reading layout", () => {
  it.each(["compact", "normal", "relaxed"] as const)("owns each block gap once for %s spacing", (blockSpacing) => {
    const style = createTaskMarkdownStyles(darkColors, "normal", "airy", blockSpacing, "relaxed", "Noto Sans SC", "Noto Sans SC Bold");
    const seen: Record<string, Record<string, unknown>[]> = {};
    const rules: RenderRules = { ...markdownReadingRules };
    for (const type of ["body", "paragraph", "heading1", "bullet_list", "ordered_list", "list_item", "table", "tr", "th", "td", "code_inline", "fence", "strong"]) {
      rules[type] = (...args) => {
        const node = (markdownReadingRules[type] ?? renderRules[type])!(...args) as React.ReactElement<{ style: unknown }>;
        (seen[type] ??= []).push(StyleSheet.flatten(node.props.style as never));
        return node;
      };
    }
    const html = renderToStaticMarkup(<Markdown style={style} rules={rules}>{"# 中文标题\n\n第一段 `code`。\n\n第二段 **强调**。\n\n1. 第一项\n   - 嵌套项目\n2. 第二项\n\n| 列 | Value |\n| --- | --- |\n| 内容 | text |\n\n```js\nconst value = 1;\n```"}</Markdown>);
    expect(html).toContain('data-testid="conversation-markdown-table"');
    expect(html).toContain('data-testid="conversation-markdown-list-item"');
    expect(seen.body[0].gap).toBe(style.body.gap);
    for (const paragraph of seen.paragraph) expect(paragraph).toMatchObject({ marginTop: 0, marginBottom: 0 });
    for (const type of ["bullet_list", "ordered_list", "table"]) expect(seen[type][0]).toMatchObject({ marginTop: 0, marginBottom: 0 });
    expect(seen.code_inline[0]).toMatchObject({ fontFamily: "monospace", fontSize: 15, letterSpacing: 0 });
    expect(seen.code_inline[0].lineHeight).toBe(style.body.lineHeight);
    expect(seen.fence[0]).toMatchObject({ fontFamily: "monospace", fontSize: 12, lineHeight: 18, letterSpacing: 0 });
    const geometry = createTaskStyles(darkColors, blockSpacing);
    expect(geometry.orderedMessageSegments.gap).toBe(style.body.gap);
    expect(geometry.legacyMessageSegments.gap).toBe(style.body.gap);
    expect(geometry.orderedProcessingGroup).not.toHaveProperty("marginTop");
    expect(style.strong.fontFamily).toBe("Noto Sans SC Bold");
  });
});
