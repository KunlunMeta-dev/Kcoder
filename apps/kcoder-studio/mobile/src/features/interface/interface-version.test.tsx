vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
import React from "react";
import { Text, View } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async () => null, setItem: async () => {},
} }));
vi.mock("react-native", () => ({
  Appearance: { getColorScheme: () => "light", addChangeListener: () => ({ remove() {} }) },
  Platform: { OS: "web" }, useWindowDimensions: () => ({ width: 390, height: 844 }), StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  ActivityIndicator: "ActivityIndicator", Keyboard: {}, Modal: "Modal", Pressable: "Pressable",
  ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View",
}));
vi.mock("lucide-react-native", () => ({
  ArrowUp: "ArrowUp", Send: "Send", Paperclip: "Paperclip", Plus: "Plus", Sparkles: "Sparkles", Square: "Square", X: "X",
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("../task/TaskAttachments", () => ({ ComposerAttachmentPreview: "Preview", StagedAttachmentChip: "Chip" }));
vi.mock("../task/TaskPermissionSelector", () => ({ PermissionModeIcon: "PermissionModeIcon" }));

import { ComposerField } from "../task/TaskComposer";
import { resolveComposerLayout } from "../task/taskComposerLayout";
import { appPreferencesTestHelpers, updateAppPreferencesAndWait } from "@/storage/app-preferences";
import { themeTestHelpers } from "@/theme";

let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  appPreferencesTestHelpers.reset();
});
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
  themeTestHelpers.reset();
});

it("switches presentation in place without replacing the input, attachments or current send/stop handlers", async () => {
  const submit = vi.fn(), stop = vi.fn(), edit = vi.fn();
  const state = { focused: true, contentHeight: 21 };
  await act(async () => {
    await updateAppPreferencesAndWait({ interfaceVersion: "modern" });
    rendered = create(<ComposerField draft="保留正在编辑的草稿" layoutState={state}
      layout={resolveComposerLayout(state, { draft: "保留正在编辑的草稿", attachmentCount: 1 })}
      inputEditable canSend showAttachment attachmentDisabled={false} placeholder="Message"
      sendLabel="Queue" sendTestID="queue-message" running onChangeText={edit} onSubmit={submit}
      stopAction={{ label: "Stop", disabled: false, onPress: stop }}
      attachmentPreview={<View testID="kept-attachment"><Text>keep.txt</Text></View>}
      toolbar={<Text testID="toolbar-model">model</Text>} />);
  });
  const input = rendered!.root.findByProps({ testID: "message-input" });
  const preview = rendered!.root.findByProps({ testID: "kept-attachment" });
  expect(input.props.value).toBe("保留正在编辑的草稿");
  const modernSendStyle = rendered!.root.findByProps({ testID: "queue-message" }).props.style;
  for (const interfaceVersion of ["classic", "v3", "modern"] as const) {
    await act(async () => { await updateAppPreferencesAndWait({ interfaceVersion }); });
    expect(rendered!.root.findByProps({ testID: "message-input" })).toBe(input);
    expect(rendered!.root.findByProps({ testID: "kept-attachment" })).toBe(preview);
    expect(input.props.value).toBe("保留正在编辑的草稿");
    expect(input.props.editable).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(rendered!.root.findByProps({ testID: "queue-message" }).props.style).toEqual(
      interfaceVersion === "modern" ? modernSendStyle : expect.not.arrayContaining([modernSendStyle[0]]),
    );
  }
  rendered!.root.findByProps({ testID: "queue-message" }).props.onPress();
  rendered!.root.findByProps({ testID: "stop-turn" }).props.onPress();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
});
