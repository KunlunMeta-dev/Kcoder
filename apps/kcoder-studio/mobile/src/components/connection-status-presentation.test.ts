import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  selectMobileConnectionStatusProps,
  type ConnectionStatusSource,
} from "./connection-status-presentation";

function source(
  overrides: Partial<ConnectionStatusSource> = {},
): ConnectionStatusSource {
  return {
    servers: [{ id: "online-target" }, { id: "offline-target" }, { id: "missing-target" }],
    statuses: [
      { id: "online-target", status: "online" },
      { id: "offline-target", status: "offline" },
    ],
    loading: false,
    serversReady: true,
    serversUpdatedAt: 1,
    error: null,
    reauthorizationRequired: false,
    statusRefreshing: false,
    statusError: null,
    ...overrides,
  };
}

describe("mobile connection status presentation", () => {
  it("keeps Gateway and per-target status separate when settled", () => {
    expect(selectMobileConnectionStatusProps(source())).toEqual({
      gatewayStatus: "online",
      serverStatuses: {
        "online-target": "online",
        "offline-target": "offline",
        "missing-target": "unknown",
      },
    });
  });

  it("gives reauthorization precedence and does not infer connection health", () => {
    expect(selectMobileConnectionStatusProps(source({
      reauthorizationRequired: true,
      error: "gateway error",
      loading: true,
      statusRefreshing: true,
    }))).toEqual({
      gatewayStatus: "unknown",
      serverStatuses: {
        "online-target": "unknown",
        "offline-target": "unknown",
        "missing-target": "unknown",
      },
    });
  });

  it("keeps the initial or newly switched runtime checking until listServers succeeds", () => {
    const emptyRuntime = source({
      serversReady: false,
      serversUpdatedAt: null,
      loading: false,
    });
    expect(selectMobileConnectionStatusProps(emptyRuntime)).toEqual({
      gatewayStatus: "checking",
      serverStatuses: {
        "online-target": "unknown",
        "offline-target": "unknown",
        "missing-target": "unknown",
      },
    });

    expect(selectMobileConnectionStatusProps(source({
      serversReady: true,
      serversUpdatedAt: null,
      loading: false,
    })).gatewayStatus).toBe("checking");
    expect(selectMobileConnectionStatusProps(source({
      serversReady: false,
      serversUpdatedAt: 1,
      loading: false,
    })).gatewayStatus).toBe("checking");
  });

  it("uses Gateway transport failure before checking while target errors remain unknown", () => {
    expect(selectMobileConnectionStatusProps(source({
      error: "gateway error",
      loading: true,
      statusRefreshing: true,
    }))).toEqual({
      gatewayStatus: "offline",
      serverStatuses: {
        "online-target": "unknown",
        "offline-target": "unknown",
        "missing-target": "unknown",
      },
    });
  });

  it("marks an in-progress target refresh as checking without changing Gateway status", () => {
    expect(selectMobileConnectionStatusProps(source({
      loading: true,
      statusRefreshing: true,
    }))).toEqual({
      gatewayStatus: "checking",
      serverStatuses: {
        "online-target": "checking",
        "offline-target": "checking",
        "missing-target": "checking",
      },
    });
  });

  it("marks every target unknown when the shared target-status read fails", () => {
    expect(selectMobileConnectionStatusProps(source({
      statusError: "target probe failed",
    }))).toEqual({
      gatewayStatus: "online",
      serverStatuses: {
        "online-target": "unknown",
        "offline-target": "unknown",
        "missing-target": "unknown",
      },
    });
  });

  it("shares the selector across Home, Sessions, and TaskScreen, then forwards it to the task Drawer", () => {
    const paths = [
      "../app/h/[profileId]/index.tsx",
      "../app/sessions.tsx",
      "../features/task/TaskScreen.tsx",
    ];
    const sources = paths.map((path) => readFileSync(
      fileURLToPath(new URL(path, import.meta.url)),
      "utf8",
    ));
    for (const sourceText of sources)
      expect(sourceText).toContain("selectMobileConnectionStatusProps(");

    const taskSource = ts.createSourceFile(
      "TaskScreen.tsx",
      sources[2],
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let selectorWiredFromRuntime = false;
    let drawerReceivesSelectorOutput = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "drawerConnectionStatusProps" && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "selectMobileConnectionStatusProps" &&
        node.initializer.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "appRuntime")) {
        selectorWiredFromRuntime = true;
      }
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) &&
        node.tagName.text === "MobileDrawer" && node.attributes.properties.some((attribute) =>
          ts.isJsxSpreadAttribute(attribute) && ts.isIdentifier(attribute.expression) &&
          attribute.expression.text === "drawerConnectionStatusProps")) {
        drawerReceivesSelectorOutput = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(taskSource);
    expect(selectorWiredFromRuntime).toBe(true);
    expect(drawerReceivesSelectorOutput).toBe(true);
  });
});
