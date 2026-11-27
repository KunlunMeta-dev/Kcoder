import React from "react";
import { createRoot } from "react-dom/client";
import { Pressable, ScrollView, Text, View } from "react-native";
import { getResponderNode } from "react-native-web/dist/modules/useResponderEvents/ResponderSystem.js";

const ROW_COUNT = 16;
const ROW_HEIGHT = 82;
const LIST_HEIGHT = 374;
const LIST_WIDTH = 390;
const CONTENT_HEIGHT = 1336;

function FixtureRow({ index, mode, pressableTestId, onPress, state }) {
  const rowContent = (
    <>
      <View style={styles.icon} />
      <View style={styles.copy}>
        <Text style={styles.title}>A Sessions first</Text>
        <Text style={styles.meta}>A-fast · KCoder · recent</Text>
        <Text
          testID={index === 3 ? "rnw-control-clipped-text" : undefined}
          numberOfLines={1}
          style={styles.clippedText}
        >
          /fixture/workspace/with/a/path/long/enough/to/exceed/the-visible-width-and-match-the-real-row
        </Text>
      </View>
      <Pressable testID={`rnw-control-action-${index}`} onPress={() => {}} style={styles.action}>
        <Text>⋯</Text>
      </Pressable>
    </>
  );
  const responderComparison = mode === "non-pressable-same-action" && index === 3;
  return (
    <View style={styles.virtualRow}>
      {responderComparison ? (
        <View testID={pressableTestId} style={[styles.pressableRow, styles.nonPressableSameAction]}>
          {rowContent}
        </View>
      ) : (
        <Pressable
          testID={pressableTestId}
          onPress={onPress}
          onPressIn={() => state.pressLifecycle.push({ phase: "press-in", atPageMs: performance.now() })}
          onPressOut={() => state.pressLifecycle.push({ phase: "press-out", atPageMs: performance.now() })}
          style={styles.pressableRow}
        >
          {rowContent}
        </Pressable>
      )}
    </View>
  );
}

function TouchControl({ mode, state }) {
  return (
    <View testID="rnw-control-overlay" style={styles.overlay}>
      <View testID="rnw-control-outer" style={styles.outer}>
        <ScrollView
          testID="rnw-control-scrollport"
          style={styles.scrollport}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          onResponderGrant={() => state.scrollViewResponderEvents.push({ phase: "grant", atPageMs: performance.now() })}
          onResponderTerminate={() => state.scrollViewResponderEvents.push({ phase: "terminate", atPageMs: performance.now() })}
        >
          {Array.from({ length: ROW_COUNT }, (_, index) => (
            <FixtureRow
              key={index}
              index={index}
              mode={mode}
              pressableTestId={`rnw-control-row-${index}`}
              onPress={() => { state.pressCount += 1; }}
              state={state}
            />
          ))}
          <View testID="rnw-control-content-tail" style={styles.contentTail} />
        </ScrollView>
      </View>
      <View
        pointerEvents="none"
        style={styles.modeMarker}
        accessibilityLabel={mode}
      />
    </View>
  );
}

const styles = {
  overlay: {
    position: "fixed",
    left: 0,
    top: 470,
    width: LIST_WIDTH,
    height: LIST_HEIGHT,
    zIndex: 2147483000,
    pointerEvents: "auto",
    backgroundColor: "transparent",
  },
  outer: {
    position: "absolute",
    left: 0,
    top: 0,
    width: LIST_WIDTH,
    height: LIST_HEIGHT,
    overflow: "auto",
    backgroundColor: "transparent",
  },
  scrollport: {
    width: LIST_WIDTH,
    height: LIST_HEIGHT,
    flexGrow: 0,
    flexShrink: 0,
    overflowX: "hidden",
    overflowY: "auto",
    touchAction: "auto",
    pointerEvents: "auto",
    WebkitOverflowScrolling: "touch",
  },
  content: {
    width: LIST_WIDTH,
    minHeight: CONTENT_HEIGHT,
    paddingHorizontal: 16,
  },
  virtualRow: {
    width: LIST_WIDTH - 32,
    height: ROW_HEIGHT,
    flexShrink: 0,
    justifyContent: "center",
  },
  pressableRow: {
    width: LIST_WIDTH - 32,
    height: ROW_HEIGHT,
    minHeight: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    overflow: "visible",
  },
  nonPressableSameAction: {
    touchAction: "manipulation",
  },
  icon: {
    width: 38,
    height: 38,
    flexShrink: 0,
  },
  copy: {
    width: 252,
    height: 51,
    flexGrow: 0,
    flexShrink: 0,
  },
  title: {
    height: 17,
    flexShrink: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontSize: 14,
    lineHeight: 17,
    fontWeight: "600",
  },
  meta: {
    height: 13,
    marginTop: 5,
    flexShrink: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontSize: 11,
    lineHeight: 13,
  },
  clippedText: {
    width: 252,
    height: 11,
    marginTop: 4,
    flexShrink: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    touchAction: "auto",
    pointerEvents: "auto",
    fontSize: 10,
    lineHeight: 11,
    fontFamily: "monospace",
  },
  action: {
    width: 44,
    height: 44,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  contentTail: {
    width: 1,
    height: CONTENT_HEIGHT - ROW_COUNT * ROW_HEIGHT,
    flexShrink: 0,
  },
  modeMarker: {
    position: "absolute",
    width: 1,
    height: 1,
    left: -2,
    top: -2,
  },
};

let activeRoot = null;
let activeHost = null;
let activeState = null;

export function mountRnwTouchControl(mode) {
  if (activeRoot) throw new Error("RNW touch control is already mounted");
  activeHost = document.createElement("div");
  activeHost.id = "kcoder-rnw-sessions-touch-control-host";
  activeHost.style.position = "fixed";
  activeHost.style.inset = "0";
  activeHost.style.zIndex = "2147483000";
  activeHost.style.pointerEvents = "none";
  document.body.appendChild(activeHost);
  activeRoot = createRoot(activeHost);
  activeState = { mode, pressCount: 0, pressLifecycle: [], scrollViewResponderEvents: [] };
  activeRoot.render(<TouchControl mode={mode} state={activeState} />);
  window.__kcoderRnwSessionsTouchControl = {
    mode,
    state: activeState,
    currentResponderOwner() {
      const node = getResponderNode();
      if (!(node instanceof Element)) return null;
      return {
        tag: node.tagName,
        testId: node.getAttribute("data-testid"),
        closestTestId: node.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      };
    },
    unmount() {
      activeRoot?.unmount();
      activeRoot = null;
      activeState = null;
      activeHost?.remove();
      activeHost = null;
      delete window.__kcoderRnwSessionsTouchControl;
    },
  };
  return true;
}
