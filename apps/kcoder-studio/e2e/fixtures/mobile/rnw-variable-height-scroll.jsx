import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FlatList, Text, View } from "react-native-web";

const TAIL = "RNW_FIXTURE_LAST_CHARACTER";
const LIMIT = 128;

function record(state, key, value) {
  if (state[key].length < LIMIT) state[key].push({ atMs: +(performance.now() - state.startedAt).toFixed(2), ...value });
  else state.dropped[key] = (state.dropped[key] || 0) + 1;
}

function Row({ row, state }) {
  useEffect(() => {
    record(state, "rowEvents", { kind: "mounted", fixtureRowIndex: row.index });
    return () => record(state, "rowEvents", { kind: "unmounted", fixtureRowIndex: row.index });
  }, [row.index, state]);
  return (
    <View testID={`fixture-row-${row.index}`} style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: "#d8dee4" }}>
      <Text style={{ fontSize: 13, lineHeight: 18, color: "#57606a", marginBottom: 5 }}>History {row.id}</Text>
      {row.blocks.map((block, index) => block.kind === "code" ? (
        <View key={index} style={{ padding: 7, marginBottom: 6, backgroundColor: "#f0f2f4" }}>
          <Text style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 17, whiteSpace: "pre-wrap" }}>{block.text}</Text>
        </View>
      ) : block.kind === "list" ? (
        <View key={index} style={{ marginBottom: 6 }}>
          {block.items.map((item, itemIndex) => <Text key={itemIndex} style={{ fontSize: 14, lineHeight: 20 }}>• {item}</Text>)}
        </View>
      ) : (
        <View key={index} style={{ marginBottom: 6 }}>
          <Text style={{ fontSize: 14, lineHeight: 20 }}>{block.text}</Text>
        </View>
      ))}
      {row.index === 499 ? <Text testID="fixture-tail-marker" style={{ fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{TAIL}</Text> : null}
    </View>
  );
}

function ListWindow({ rows, state, scenario, generation }) {
  const list = useRef(null);
  const retryScheduled = useRef(false);
  const lastFailure = useRef(null);
  const inverted = scenario === "reversed-data-inverted";
  useEffect(() => {
    record(state, "windowEvents", { kind: "mounted", generation, rowCount: rows.length });
    return () => record(state, "windowEvents", { kind: "unmounted", generation, rowCount: rows.length });
  }, [generation, rows.length, state]);

  function onScrollToIndexFailed(info) {
    const failure = { index: info.index, averageItemLength: info.averageItemLength, highestMeasuredFrameIndex: info.highestMeasuredFrameIndex };
    record(state, "indexFailures", { ...failure, source: "public onScrollToIndexFailed payload" });
    lastFailure.current = failure;
    if (scenario !== "initial-latest-measured-retry" || retryScheduled.current || state.retryCount >= 48) return;
    retryScheduled.current = true;
    requestAnimationFrame(() => {
      retryScheduled.current = false;
      const latest = lastFailure.current;
      if (!latest || !list.current || state.retryCount >= 48) return;
      state.retryCount += 1;
      const offset = Math.max(0, latest.averageItemLength * latest.index);
      record(state, "retries", { attempt: state.retryCount, targetIndex: latest.index, measuredAverage: latest.averageItemLength, measuredFrontier: latest.highestMeasuredFrameIndex, estimatedOffset: offset });
      list.current.scrollToOffset({ offset, animated: false });
      requestAnimationFrame(() => requestAnimationFrame(() => list.current?.scrollToIndex({ index: latest.index, animated: false, viewPosition: 1 })));
    });
  }

  return <FlatList
    ref={list}
    testID="fixture-scroll-list"
    data={rows}
    keyExtractor={row => row.id}
    renderItem={({ item }) => <Row row={item} state={state} />}
    style={{ flex: 1 }}
    inverted={inverted}
    contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
    initialNumToRender={12}
    maxToRenderPerBatch={10}
    windowSize={7}
    initialScrollIndex={rows.length && scenario !== "initial-index-zero-scroll-to-end" ? (inverted ? 0 : rows.length - 1) : 0}
    onScrollToIndexFailed={onScrollToIndexFailed}
    scrollEventThrottle={16}
    onScroll={event => record(state, "scrollEvents", { offsetY: event.nativeEvent?.contentOffset?.y ?? null })}
    onContentSizeChange={(width, height) => record(state, "contentEvents", { width, height })}
    onLayout={event => {
      const layout = event.nativeEvent?.layout;
      record(state, "layoutEvents", { width: layout?.width ?? null, height: layout?.height ?? null, generation });
      if (scenario === "initial-index-zero-scroll-to-end" && !state.initialScrollToEndIssued && list.current) {
        state.initialScrollToEndIssued = true;
        list.current.scrollToEnd({ animated: false });
      }
    }}
  />;
}

function App({ scenario, rows, state }) {
  const initialRows = useMemo(() => scenario === "reversed-data-inverted" ? [...rows].reverse() : rows, [rows, scenario]);
  const [data, setData] = useState(scenario === "hydrate-empty-one-window-init" ? [] : initialRows);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (scenario !== "hydrate-empty-one-window-init") return undefined;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (state.hydrationCount) return;
      state.hydrationCount = 1;
      state.hydrationAtMs = +(performance.now() - state.startedAt).toFixed(2);
      setData(initialRows);
      setGeneration(1);
    }));
    return undefined;
  }, [initialRows, scenario, state]);
  return <View style={{ width: "100%", height: "100%", flex: 1 }}>
    <ListWindow key={`window-${generation}`} rows={data} state={state} scenario={scenario} generation={generation} />
  </View>;
}

function readDom(state) {
  const list = document.querySelector('[data-testid="fixture-scroll-list"]');
  const marker = document.querySelector('[data-testid="fixture-tail-marker"]');
  const rowIndexes = list ? [...list.querySelectorAll('[data-testid^="fixture-row-"]')]
    .map(node => Number(node.getAttribute("data-testid").slice("fixture-row-".length))).filter(Number.isInteger).sort((a, b) => a - b) : [];
  const host = list?.getBoundingClientRect();
  let charRect = null;
  if (marker) {
    const walker = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT);
    let node;
    let match = null;
    while ((node = walker.nextNode())) {
      const offset = node.data.lastIndexOf(TAIL);
      if (offset >= 0) match = { node, offset };
    }
    if (match) {
      const range = document.createRange();
      range.setStart(match.node, match.offset + TAIL.length - 1);
      range.setEnd(match.node, match.offset + TAIL.length);
      const rect = range.getBoundingClientRect();
      charRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
  }
  return {
    atMs: +(performance.now() - state.startedAt).toFixed(2),
    tailVisible: Boolean(host && charRect && charRect.right > host.left && charRect.left < host.right && charRect.bottom > host.top && charRect.top < host.bottom),
    lastCharacterRect: charRect,
    scrollHost: list ? { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, scrollTop: list.scrollTop, bottomGap: list.scrollHeight - list.clientHeight - list.scrollTop } : null,
    mountedRows: { count: rowIndexes.length, firstFixtureIndex: rowIndexes[0] ?? null, lastFixtureIndex: rowIndexes.at(-1) ?? null },
  };
}

window.mountRnwVariableHeightScenario = (scenario, rows) => {
  const state = {
    scenario, startedAt: performance.now(), retryCount: 0, hydrationCount: 0, hydrationAtMs: null,
    initialScrollToEndIssued: false, firstVisiblePollUpperBoundMs: null, stableAtMs: null, dropped: {},
    scrollEvents: [], contentEvents: [], layoutEvents: [], rowEvents: [], windowEvents: [], indexFailures: [], retries: [],
  };
  const root = createRoot(document.getElementById("root"));
  root.render(<App scenario={scenario} rows={rows} state={state} />);
  window.__rnwVariableHeightState = state;
  window.__rnwVariableHeightReadDom = () => readDom(state);
  window.__rnwVariableHeightWaitTwoFrames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  state.summary = () => ({
    scenario, retryCount: state.retryCount, hydrationCount: state.hydrationCount, hydrationAtMs: state.hydrationAtMs,
    initialScrollToEndIssued: state.initialScrollToEndIssued,
    firstVisiblePollUpperBoundMs: state.firstVisiblePollUpperBoundMs, stableAtMs: state.stableAtMs,
    scrollEvents: state.scrollEvents, contentEvents: state.contentEvents, layoutEvents: state.layoutEvents,
    rowEvents: state.rowEvents, windowEvents: state.windowEvents, indexFailures: state.indexFailures, retries: state.retries, dropped: state.dropped,
  });
};
