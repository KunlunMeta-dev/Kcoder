import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { createElement } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { getLocale, setLocale } from "@/i18n/locale-state";
import { darkColors, lightColors } from "@/theme";
import {
  statusDotAccessibilityLabel,
  statusDotAccessibilityProps,
  statusDotColor,
} from "./status-dot-presentation";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: ReactNode): string;
};

describe("status dot presentation", () => {
  it.each([
    ["dark", darkColors],
    ["light", lightColors],
  ] as const)("uses distinct semantic colors in the %s theme", (_mode, colors) => {
    expect(statusDotColor("online", colors)).toBe(colors.green);
    expect(statusDotColor("offline", colors)).toBe(colors.red);
    expect(statusDotColor("checking", colors)).toBe(colors.yellow);
    expect(statusDotColor("unknown", colors)).toBe(colors.blue);
    expect(statusDotColor("unknown", colors)).not.toBe(statusDotColor("offline", colors));
  });

  it.each([
    ["en", "Online", "Offline", "Checking", "Unknown"],
    ["zh-CN", "在线", "离线", "检查中", "暂不可识别"],
  ] as const)("uses localized accessible labels in %s", (locale, online, offline, checking, unknown) => {
    const previousLocale = getLocale();
    try {
      setLocale(locale);
      expect(statusDotAccessibilityLabel("online")).toBe(online);
      expect(statusDotAccessibilityLabel("offline")).toBe(offline);
      expect(statusDotAccessibilityLabel("checking")).toBe(checking);
      expect(statusDotAccessibilityLabel("unknown")).toBe(unknown);
    } finally {
      setLocale(previousLocale);
    }
  });

  it("keeps a localized label on standalone dots and hides decorative dots from accessibility", () => {
    const previousLocale = getLocale();
    try {
      setLocale("en");
      expect(statusDotAccessibilityProps("online", false)).toEqual({
        accessible: true,
        accessibilityRole: "image",
        accessibilityLabel: "Online",
      });
      expect(statusDotAccessibilityProps("online", true)).toEqual({
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
        "aria-hidden": true,
      });
    } finally {
      setLocale(previousLocale);
    }
  });

  it("renders StatusDot with accessibility props selected by its decorative flag", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./ui.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("useLocale();");
    expect(source).toContain("decorative = false");
    expect(source).toContain("...statusDotAccessibilityProps(status, decorative)");
  });

  it("forwards decorative hiding and standalone labels to the RN-web accessibility tree", () => {
    const decorativeMarkup = renderToStaticMarkup(
      createElement(View, statusDotAccessibilityProps("online", true)),
    );
    const standaloneMarkup = renderToStaticMarkup(
      createElement(View, statusDotAccessibilityProps("online", false)),
    );
    expect(decorativeMarkup).toContain('aria-hidden="true"');
    expect(standaloneMarkup).toContain('aria-label="Online"');
    expect(standaloneMarkup).not.toContain('aria-hidden="true"');
  });

  it.each([
    ["Drawer", "./mobile-drawer.tsx", 1],
    ["Sessions", "../app/sessions.tsx", null],
  ] as const)("preserves the %s connection-status presentation and accessibility contract", (surface, path, expectedDotUsages) => {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const statusDots: ts.JsxSelfClosingElement[] = [];
    const chevrons: ts.JsxSelfClosingElement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "StatusDot") {
        statusDots.push(node);
        const decorative = jsxAttribute(node, "decorative", sourceFile);
        expect(decorative).toBeDefined();
        expect(decorative && ts.isJsxAttribute(decorative) && (
          decorative.initializer === undefined ||
          (ts.isJsxExpression(decorative.initializer) && decorative.initializer.expression?.getText(sourceFile) === "true")
        )).toBe(true);
      }
      if (ts.isJsxSelfClosingElement(node) && ["ChevronDown", "ChevronRight"].includes(node.tagName.getText(sourceFile))) {
        chevrons.push(node);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
    if (expectedDotUsages !== null) expect(statusDots).toHaveLength(expectedDotUsages);
    else expect(statusDots.length).toBeGreaterThan(0);

    if (surface === "Drawer") {
      const fallbackDot = statusDots[0]!;
      const fallbackStatus = jsxAttributeExpression(fallbackDot, "status", sourceFile)?.getText(sourceFile);
      expect(fallbackStatus).toBe("status");
      const fallback = nearestJsxElement(fallbackDot, element =>
        element.openingElement.tagName.getText(sourceFile) === "View" &&
        jsxAttributeText(element, "testID", sourceFile)?.includes("drawer-target-status-") === true,
      );
      expect(fallback).toBeDefined();
      expect(visibleConnectionStatusExpressions(fallback!, sourceFile)).toContain(fallbackStatus);

      const workspaceChevrons = chevrons.filter(chevron =>
        jsxAttributeExpression(chevron, "color", sourceFile)?.getText(sourceFile).includes("statusDotColor("),
      );
      expect(workspaceChevrons.map(chevron => chevron.tagName.getText(sourceFile)).sort())
        .toEqual(["ChevronDown", "ChevronRight"]);
      const accessibleName = findVariableInitializer(sourceFile, "accessibleName");
      expect(accessibleName?.getText(sourceFile)).toContain("connectionStatusLabel(status)");
      for (const chevron of workspaceChevrons) {
        expect(jsxAttributeExpression(chevron, "color", sourceFile)?.getText(sourceFile))
          .toBe("statusDotColor(status, colors)");
        const workspaceToggle = nearestJsxElement(chevron, element =>
          element.openingElement.tagName.getText(sourceFile) === "Pressable",
        );
        expect(jsxAttributeExpression(workspaceToggle!, "testID", sourceFile)?.getText(sourceFile))
          .toContain("drawer-toggle-");
        expect(jsxAttributeExpression(workspaceToggle!, "accessibilityLabel", sourceFile)?.getText(sourceFile))
          .toContain("accessibleName");
      }
    } else {
      expect(findVariableInitializer(sourceFile, "targetStatus")?.getText(sourceFile))
        .toContain("targetStatusFor(row.serverId)");
      expect(findVariableInitializer(sourceFile, "details")?.getText(sourceFile))
        .toContain("connectionStatusLabel(targetStatus)");
      // Each interface variant may place its dot differently. Every rendered
      // dot must still describe the row's target and expose its localized name.
      for (const targetDot of statusDots) {
        expect(jsxAttributeExpression(targetDot, "status", sourceFile)?.getText(sourceFile)).toBe("targetStatus");
        const statusLabel = nearestJsxElement(targetDot, element =>
          jsxAttributeExpression(element, "accessibilityLabel", sourceFile)?.getText(sourceFile) === "connectionStatusLabel(targetStatus)",
        );
        expect(statusLabel).toBeDefined();
        const targetPressable = nearestJsxElement(targetDot, element =>
          element.openingElement.tagName.getText(sourceFile) === "Pressable",
        );
        expect(targetPressable).toBeDefined();
        expect(jsxAttributeExpression(targetPressable!, "accessibilityLabel", sourceFile)?.getText(sourceFile))
          .toBe("details");
      }
    }
  });
});

function jsxAttribute(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  sourceFile: ts.SourceFile,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
  );
}

function jsxAttributeExpression(
  node: ts.Node,
  name: string,
  sourceFile: ts.SourceFile,
): ts.Expression | undefined {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return undefined;
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const initializer = jsxAttribute(opening, name, sourceFile)?.initializer;
  return initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
}

function jsxAttributeText(
  node: ts.Node,
  name: string,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return undefined;
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const initializer = jsxAttribute(opening, name, sourceFile)?.initializer;
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer)) return initializer.expression?.getText(sourceFile);
  return undefined;
}

function nearestJsxElement(
  node: ts.Node,
  predicate: (element: ts.JsxElement) => boolean,
): ts.JsxElement | undefined {
  let parent = node.parent;
  while (parent) {
    if (ts.isJsxElement(parent) && predicate(parent)) return parent;
    parent = parent.parent;
  }
  return undefined;
}

function findVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) initializer = node.initializer;
    if (!initializer) node.forEachChild(visit);
  };
  visit(sourceFile);
  return initializer;
}

function visibleConnectionStatusExpressions(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const expressions: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && child.expression.getText(sourceFile) === "connectionStatusLabel") {
      const argument = child.arguments[0];
      let ancestor = child.parent;
      while (ancestor && ancestor !== node) {
        if (ts.isJsxElement(ancestor) && ancestor.openingElement.tagName.getText(sourceFile) === "Text") {
          if (argument) expressions.push(argument.getText(sourceFile));
          break;
        }
        ancestor = ancestor.parent;
      }
    }
    child.forEachChild(visit);
  };
  visit(node);
  return expressions;
}
