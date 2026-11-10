import { useEffect, useRef, useState, type RefObject } from "react";
import { Keyboard, Platform, type TextInputInstance } from "react-native";
import { COMPOSER_INPUT_LINE_HEIGHT, reduceComposerLayoutState, resolveComposerLayout, type ComposerLayoutEvent } from "./taskComposerLayout";
import { subscribeComposerWebKeyboardDismiss } from "./composer-web-keyboard-dismiss";

/** Shared input geometry and focus policy; sending remains owned by each conversation. */
export function useComposerInputLayout({ input, attachmentCount, messageInputRef, overlayOpen, compactDraftWhenUnfocused }: {
  input: string; attachmentCount: number; messageInputRef: RefObject<TextInputInstance | null>;
  overlayOpen: boolean; compactDraftWhenUnfocused: boolean;
}) {
  const [layoutState, setLayoutState] = useState(() => ({ focused: false,
    contentHeight: Math.max(COMPOSER_INPUT_LINE_HEIGHT, input.split(/\r?\n/).length * COMPOSER_INPUT_LINE_HEIGHT) }));
  const [controlPressPending, setControlPressPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preserveExpanded = overlayOpen || controlPressPending;
  const preserveExpandedRef = useRef(preserveExpanded);
  preserveExpandedRef.current = preserveExpanded;
  const updateLayout = (event: ComposerLayoutEvent) => setLayoutState(previous => reduceComposerLayoutState(previous, event));
  const composerLayout = resolveComposerLayout(layoutState, { draft: input, attachmentCount,
    preserveExpanded, compactDraftWhenUnfocused });
  const beginControlPress = () => {
    preserveExpandedRef.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setControlPressPending(true);
  };
  const endControlPress = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setControlPressPending(false); }, 250);
  };
  useEffect(() => {
    const dismiss = () => { if (!preserveExpandedRef.current) updateLayout({ type: "keyboard-hidden" }); };
    const subscription = Keyboard.addListener("keyboardDidHide", dismiss);
    const stopWeb = compactDraftWhenUnfocused && Platform.OS === "web"
      ? subscribeComposerWebKeyboardDismiss(() => Boolean(messageInputRef.current?.isFocused()), dismiss) : undefined;
    return () => { subscription.remove(); stopWeb?.(); };
  }, [compactDraftWhenUnfocused, messageInputRef]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (preserveExpanded || (!compactDraftWhenUnfocused && (input.length > 0 || attachmentCount > 0)) || messageInputRef.current?.isFocused()) return;
    updateLayout({ type: "blur" });
  }, [preserveExpanded, compactDraftWhenUnfocused, input.length, attachmentCount, messageInputRef]);
  return { layoutState, composerLayout, updateLayout, preserveExpandedRef, beginControlPress, endControlPress };
}
