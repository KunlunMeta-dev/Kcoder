import { cloneElement, isValidElement } from "react";
import { renderRules, type RenderRules } from "react-native-markdown-display";

const nodeNames: Record<string, string> = {
  body: "body", paragraph: "paragraph", heading1: "heading", heading2: "heading", heading3: "heading",
  bullet_list: "bullet-list", ordered_list: "ordered-list", list_item: "list-item",
  table: "table", tr: "table-row", th: "table-cell", td: "table-cell",
};

// Preserve the library's AST layout and inherited text styles while exposing reading landmarks.
export const markdownReadingRules: RenderRules = Object.fromEntries(
  Object.entries(nodeNames).map(([type, name]) => [type, (...args: Parameters<NonNullable<RenderRules[string]>>) => {
    const rendered = renderRules[type]?.(...args);
    return isValidElement<{ testID?: string }>(rendered)
      ? cloneElement(rendered, { testID: `conversation-markdown-${name}` })
      : rendered;
  }]),
);
