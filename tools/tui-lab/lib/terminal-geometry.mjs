import { maxConsecutiveBlankLines } from "./assertions.mjs";

export const TMUX_RESIZE_SEQUENCE = [
  { cols: 100, rows: 24 },
  { cols: 100, rows: 38 },
  { cols: 100, rows: 18 },
  { cols: 100, rows: 32 },
];

export const VISUAL_RESIZE_SEQUENCE = [
  { width: 980, height: 560 },
  { width: 980, height: 760 },
  { width: 980, height: 420 },
  { width: 980, height: 650 },
];

export function terminalLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function blankLinesBetween(lines, start, end) {
  if (start < 0 || end < 0 || end <= start + 1) {
    return 0;
  }
  return lines.slice(start + 1, end).filter((line) => line.trim() === "")
    .length;
}

export function maxBlankRunInLines(lines) {
  let max = 0;
  let current = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

export function visibleChromeGeometry(text) {
  const lines = terminalLines(text);
  const welcomeBottom = lines.findIndex((line) => line.includes("╰"));
  const composer = lines.findIndex((line) => line.includes("Ask KCoder"));
  const footer = lines.findIndex((line) => line.includes("? for shortcuts"));
  let previousContentBeforeComposer = composer - 1;
  while (
    previousContentBeforeComposer >= 0 &&
    lines[previousContentBeforeComposer].trim() === ""
  ) {
    previousContentBeforeComposer -= 1;
  }
  return {
    totalLines: lines.length,
    welcomeBottomLine: welcomeBottom >= 0 ? welcomeBottom + 1 : null,
    composerLine: composer >= 0 ? composer + 1 : null,
    footerLine: footer >= 0 ? footer + 1 : null,
    welcomeComposerBlankLines: blankLinesBetween(
      lines,
      welcomeBottom,
      composer,
    ),
    blankBeforeComposer: blankLinesBetween(
      lines,
      previousContentBeforeComposer,
      composer,
    ),
    footerBottomBlankLines:
      footer >= 0 ? lines.length - footer - 1 : Number.POSITIVE_INFINITY,
    footerBottomMaxBlankRun:
      footer >= 0
        ? maxBlankRunInLines(lines.slice(footer + 1))
        : Number.POSITIVE_INFINITY,
    maxBlankRun: maxConsecutiveBlankLines(text),
  };
}

export function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

export function assertTmuxResizeChrome(text, stage, options = {}) {
  const { requireWelcome = true, requireSentinel = true } = options;
  const expectedOnce = ["Ask KCoder", "? for shortcuts"];
  if (requireWelcome) {
    expectedOnce.unshift("Welcome to KCoder!");
  }
  const counts = Object.fromEntries(
    expectedOnce.map((needle) => [needle, countOccurrences(text, needle)]),
  );
  const bad = Object.entries(counts).filter(([, count]) => count !== 1);
  if (bad.length > 0) {
    throw new Error(
      `tmux ${stage} resize capture has stale/missing live chrome: ${JSON.stringify(counts)}`,
    );
  }
  const blankRun = maxConsecutiveBlankLines(text);
  const geometry = visibleChromeGeometry(text);
  if (
    geometry.blankBeforeComposer > 12 ||
    geometry.footerBottomBlankLines > 12
  ) {
    throw new Error(
      `tmux ${stage} visible capture has excessive chrome gap: ${JSON.stringify(
        {
          blankBeforeComposer: geometry.blankBeforeComposer,
          footerBottomBlankLines: geometry.footerBottomBlankLines,
          maxBlankRun: blankRun,
          composerLine: geometry.composerLine,
          footerLine: geometry.footerLine,
          totalLines: geometry.totalLines,
        },
      )}`,
    );
  }
  if (requireSentinel && !text.includes("tui-lab-final-sentinel")) {
    throw new Error(`tmux ${stage} resize capture lost final sentinel`);
  }
}

export function visualResizeChromeCheck(text, stage) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name: `${stage}:${name}`, ok: Boolean(ok), ...detail });
  const counts = {
    ask: countOccurrences(text, "Ask KCoder"),
    footer: countOccurrences(text, "? for shortcuts"),
  };
  add("composer-visible-once", counts.ask === 1, { count: counts.ask });
  add("footer-visible-once", counts.footer === 1, { count: counts.footer });
  add("screen-text-has-no-ansi-esc", !/\x1b/.test(text));
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
    counts,
  };
}
