import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

const documentContext = vi.hoisted(() => ({ value: {} as any }));

vi.mock("expo-router/html", () => ({
  ScrollViewStyleReset: () => createElement("style", { "data-scroll-reset": "loaded" }),
  useServerDocumentContext: () => documentContext.value,
}));

import RootHtml from "@/app/+html";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: ReactNode): string;
};

it("renders the SDK58 server document attributes and injected nodes", () => {
  documentContext.value = {
    htmlAttributes: { "data-router-html": "active" },
    bodyAttributes: { "data-router-body": "active" },
    headNodes: createElement("meta", { name: "router-head", content: "included" }),
    bodyNodes: createElement("span", { "data-router-body-node": "included" }, "router body node"),
  };

  const markup = renderToStaticMarkup(createElement(RootHtml, null, createElement("main", null, "page content")));

  expect(markup).toContain("<html lang=\"en\"");
  expect(markup).toContain("data-router-html=\"active\"");
  expect(markup).toContain("data-router-body=\"active\"");
  expect(markup).toContain("name=\"router-head\"");
  expect(markup).toContain("data-scroll-reset=\"loaded\"");
  expect(markup).toContain("data-router-body-node=\"included\"");
  expect(markup.indexOf("page content")).toBeLessThan(markup.indexOf("router body node"));
});
