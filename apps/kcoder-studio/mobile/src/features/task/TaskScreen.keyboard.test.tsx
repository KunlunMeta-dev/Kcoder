import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const mobileRequire = createRequire(join(testDirectory, "../../../package.json"));

type KeyboardEventName = "keyboardDidShow" | "keyboardDidHide";
type KeyboardEventListener = (event: {
  duration: number;
  easing: string;
  endCoordinates: { height: number; screenY: number };
}) => void;

const keyboardListeners = new Map<KeyboardEventName, KeyboardEventListener>();
const pendingUpdates: Promise<void>[] = [];
const androidPlatform = { OS: "android" };
const fakeKeyboard = {
  addListener(name: KeyboardEventName, listener: KeyboardEventListener) {
    keyboardListeners.set(name, listener);
    return { remove() {} };
  },
  isVisible: () => false,
};

function loadReactNativeKeyboardAvoidingView() {
  const reactNativeRoot = dirname(mobileRequire.resolve("react-native/package.json"));
  const sourcePath = join(
    reactNativeRoot,
    "Libraries/Components/Keyboard/KeyboardAvoidingView.js",
  );
  const source = readFileSync(sourcePath, "utf8");
  const babel = mobileRequire("@babel/core") as {
    transformSync(
      code: string,
      options: Record<string, unknown>,
    ): { code?: string | null } | null;
  };
  const flowPlugin = mobileRequire("@babel/plugin-transform-flow-strip-types");
  const jsxPlugin = mobileRequire("@babel/plugin-transform-react-jsx");
  const commonJsPlugin = mobileRequire("@babel/plugin-transform-modules-commonjs");
  const transformed = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    plugins: [flowPlugin, jsxPlugin, commonJsPlugin],
  });
  if (!transformed?.code) throw new Error("Failed to load React Native KAV source");

  const styleSheet = {
    compose: (style: unknown, addition: unknown) =>
      style == null ? addition : [style, addition],
  };
  const view = function NativeView() {};
  const layoutAnimation = {
    configureNext() {},
    Types: { keyboard: "keyboard" },
  };
  const accessibilityInfo = {
    async prefersCrossFadeTransitions() {
      return false;
    },
  };
  const importedModule = (value: unknown) => ({ __esModule: true, default: value });
  const moduleRequire = (specifier: string) => {
    switch (specifier) {
      case "react":
        return mobileRequire("react");
      case "../../LayoutAnimation/LayoutAnimation":
        return importedModule(layoutAnimation);
      case "../../StyleSheet/StyleSheet":
        return importedModule(styleSheet);
      case "../../Utilities/Platform":
        return importedModule(androidPlatform);
      case "../AccessibilityInfo/AccessibilityInfo":
        return importedModule(accessibilityInfo);
      case "../View/View":
        return importedModule(view);
      case "./Keyboard":
        return importedModule(fakeKeyboard);
      default:
        return mobileRequire(specifier);
    }
  };
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", transformed.code)(
    moduleRequire,
    module,
    module.exports,
  );

  return module.exports.default as new (props: Record<string, unknown>) => {
    state: { bottom: number };
    _frame: { y: number; height: number } | null;
    _initialFrameHeight: number;
    _updateBottomIfNecessary(): Promise<void>;
    _onLayout(event: {
      nativeEvent: { layout: { y: number; height: number } };
      persist(): void;
    }): Promise<void>;
    componentDidMount(): void;
    render(): React.ReactElement<{ style?: unknown }>;
    setState(update: { bottom: number }): void;
  };
}

const NativeKeyboardAvoidingView = loadReactNativeKeyboardAvoidingView();

function flushKeyboardUpdates() {
  return Promise.all(pendingUpdates.splice(0));
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return (style ?? {}) as Record<string, unknown>;
}

async function simulateAndroidResizeHideRestore(behavior: "height" | undefined) {
  keyboardListeners.clear();
  pendingUpdates.length = 0;

  const view = new NativeKeyboardAvoidingView({
    behavior,
    style: { flex: 1 },
  });
  view.setState = (update) => {
    view.state = { ...view.state, ...update };
  };
  const updateBottom = view._updateBottomIfNecessary.bind(view);
  view._updateBottomIfNecessary = () => {
    const pending = updateBottom();
    pendingUpdates.push(pending);
    return pending;
  };

  const layout = (height: number) => ({
    nativeEvent: { layout: { y: 0, height } },
    persist() {},
  });

  view.componentDidMount();
  await view._onLayout(layout(800));
  await view._onLayout(layout(500));

  const didShow = keyboardListeners.get("keyboardDidShow");
  expect(didShow).toBeDefined();
  didShow?.({
    duration: 0,
    easing: "keyboard",
    endCoordinates: { height: 300, screenY: 500 },
  });
  await flushKeyboardUpdates();

  // This synthetic order follows RN Android source: hide reports a zero-height
  // keyboard at visibleViewArea.height while adjustResize has the root at 500 px.
  // It characterizes RN's JS calculation, not the native event order on a device.
  const didHide = keyboardListeners.get("keyboardDidHide");
  expect(didHide).toBeDefined();
  didHide?.({
    duration: 0,
    easing: "keyboard",
    endCoordinates: { height: 0, screenY: 500 },
  });
  await flushKeyboardUpdates();
  expect(view.state.bottom).toBe(0);

  // The OS restores the full root after the hide event. KAV retains that event,
  // so its height calculation now treats the hidden keyboard's old Y as an inset.
  await view._onLayout(layout(800));
  return { bottom: view.state.bottom, style: flattenStyle(view.render().props.style) };
}

function taskScreenBehaviorAttribute() {
  const sourcePath = join(testDirectory, "TaskScreen.tsx");
  const source = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let behaviorAttribute: ts.JsxAttribute | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "behavior") {
      behaviorAttribute = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { behaviorAttribute, sourceFile };
}

describe("TaskScreen keyboard layout", () => {
  it("characterizes the installed RN Android KAV hide/frame-restore residual", async () => {
    const result = await simulateAndroidResizeHideRestore("height");

    expect(result).toEqual({
      bottom: 300,
      style: { flex: 0, height: 500 },
    });
  });

  it("does not shrink the root when Android KAV behavior is disabled", async () => {
    const result = await simulateAndroidResizeHideRestore(undefined);

    expect(result).toEqual({
      bottom: 300,
      style: { flex: 1 },
    });
  });

  it("keeps iOS padding and leaves Android/Web without KAV behavior", () => {
    const { behaviorAttribute, sourceFile } = taskScreenBehaviorAttribute();
    expect(behaviorAttribute).toBeDefined();
    const initializer = behaviorAttribute?.initializer;
    expect(initializer && ts.isJsxExpression(initializer)).toBe(true);
    if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
      throw new Error("TaskScreen KeyboardAvoidingView behavior must be an expression");
    }

    const expression = initializer.expression;
    expect(ts.isConditionalExpression(expression)).toBe(true);
    if (!ts.isConditionalExpression(expression)) {
      throw new Error("TaskScreen behavior must remain platform conditional");
    }

    expect(expression.condition.getText(sourceFile)).toBe('Platform.OS === "ios"');
    expect(expression.whenTrue.getText(sourceFile)).toBe('"padding"');
    expect(expression.whenFalse.getText(sourceFile)).toBe("undefined");
  });
});
