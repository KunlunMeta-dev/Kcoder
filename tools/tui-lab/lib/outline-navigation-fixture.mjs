export const OUTLINE_MARKERS = {
  taskAlpha: "OUTLINE_TASK_ALPHA",
  taskBeta: "OUTLINE_TASK_BETA",
  answerStart: "OUTLINE_ANSWER_START",
  duplicateTitle: "Repeated navigation heading",
  firstDuplicate: "OUTLINE_FIRST_DUPLICATE_ONLY",
  secondDuplicate: "OUTLINE_SECOND_DUPLICATE_TARGET",
  latest: "OUTLINE_LATEST_SENTINEL",
  underlayLink: "OUTLINE_UNDERLAY_LINK",
  draft: "outline-draft-must-survive",
};

export function makeOutlineHistoryFixture({ longLines = 4500 } = {}) {
  const m = OUTLINE_MARKERS;
  const padding = (count, tag) =>
    Array.from(
      { length: count },
      (_, index) => `${tag} ${index + 1} synthetic outline-navigation body.`,
    ).join("\n\n");
  const answer = `# Navigation answer root\n\n${m.answerStart}\n\n${padding(50, "PRELUDE")}\n\n## ${m.duplicateTitle}\n\n${m.firstDuplicate}\n\n${padding(longLines, "LONG-BODY")}\n\n## ${m.duplicateTitle}\n\n${m.secondDuplicate}\n\n${padding(160, "AFTER-TARGET")}`;
  const messages = [
    [
      "user",
      `${m.taskAlpha} verify long-answer outline navigation and duplicate headings`,
    ],
    ["assistant", answer],
    ["user", `${m.taskBeta} second independent task`],
    [
      "assistant",
      `# Second task conclusion\n\n${Array.from({ length: 18 }, (_, index) => `[${m.underlayLink}_${index}](https://example.com/outline/${index})`).join("\n\n")}\n\n${m.latest}`,
    ],
  ];
  const entries = messages.map(([role, text], index) => ({
    session_id: "outline-navigation-fixture",
    timestamp_ms: 1_780_000_000_000 + index,
    uuid: `outline-fixture-${index}`,
    parentUuid: index ? `outline-fixture-${index - 1}` : null,
    role,
    content: [{ type: "text", text }],
  }));
  return {
    jsonl: `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    targetSourceByte: Buffer.byteLength(
      answer.slice(0, answer.lastIndexOf(`## ${m.duplicateTitle}`)),
    ),
    targetSourceLine: answer
      .slice(0, answer.lastIndexOf(`## ${m.duplicateTitle}`))
      .split("\n").length,
    entries: entries.length,
  };
}

export function verifyOutlineTargetVisible(text) {
  return (
    text.includes(OUTLINE_MARKERS.secondDuplicate) &&
    !text.includes(OUTLINE_MARKERS.firstDuplicate) &&
    !text.includes("Conversation outline")
  );
}

export function countPaletteQueries(ptyLog) {
  return {
    foreground: (ptyLog.match(/\x1b\]10;\?/g) || []).length,
    background: (ptyLog.match(/\x1b\]11;\?/g) || []).length,
  };
}
