export async function waitForTerminalText(page, text, timeout) {
  await page.waitForFunction(
    (expected) => window.tuiLab && window.tuiLab.text().includes(expected),
    text,
    { timeout },
  );
}

export async function waitForTerminalTextMissing(page, text, timeout) {
  await page.waitForFunction(
    (expected) => window.tuiLab && !window.tuiLab.text().includes(expected),
    text,
    {
      timeout,
    },
  );
}

export async function waitForTerminalTextState(page, text, expected, timeout) {
  await page.waitForFunction(
    ({ needle, present }) =>
      Boolean(window.tuiLab) &&
      window.tuiLab.text().includes(needle) === present,
    { needle: text, present: expected },
    { timeout },
  );
}

export async function waitForTerminalTextPattern(page, pattern, timeout) {
  await page.waitForFunction(
    (source) =>
      Boolean(window.tuiLab) && new RegExp(source).test(window.tuiLab.text()),
    pattern,
    { timeout },
  );
}

export async function readComposerText(page) {
  return page.evaluate(() => {
    const lines = window.tuiLab.text().split("\n");
    return lines.findLast((line) => line.trimStart().startsWith("›")) || "";
  });
}

export async function waitForComposerText(page, text, timeout) {
  await page.waitForFunction(
    (expected) => {
      const lines = window.tuiLab.text().split("\n");
      const composer =
        lines.findLast((line) => line.trimStart().startsWith("›")) || "";
      return composer.includes(expected);
    },
    text,
    { timeout },
  );
}

export async function readShellComposerText(page) {
  return page.evaluate(() => {
    const lines = window.tuiLab.text().split("\n");
    const start = lines.findLastIndex((line) =>
      line.trimStart().startsWith("!"),
    );
    if (start < 0) return "";
    const composer = [lines[start].trimStart().slice(1).trimStart()];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim() || line.includes("Shell mode")) break;
      composer.push(line.trim());
    }
    return composer.join("\n").trim();
  });
}

export async function waitForShellComposerText(page, text, timeout) {
  await page.waitForFunction(
    (expected) => {
      const lines = window.tuiLab.text().split("\n");
      const start = lines.findLastIndex((line) =>
        line.trimStart().startsWith("!"),
      );
      if (start < 0) return false;
      const composer = [lines[start].trimStart().slice(1).trimStart()];
      for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim() || line.includes("Shell mode")) break;
        composer.push(line.trim());
      }
      const normalize = (value) => value.replace(/\s+/g, "");
      return normalize(composer.join("\n")).includes(normalize(expected));
    },
    text,
    { timeout },
  );
}

export async function tryWaitForTerminalText(page, text, timeout) {
  try {
    await waitForTerminalText(page, text, timeout);
    return true;
  } catch {
    return false;
  }
}

export async function tryWaitForTerminalTextMissing(page, text, timeout) {
  try {
    await waitForTerminalTextMissing(page, text, timeout);
    return true;
  } catch {
    return false;
  }
}

export async function typeHumanText(page, text) {
  for (const ch of Array.from(text)) {
    await page.keyboard.insertText(ch);
    await page.waitForTimeout(20);
  }
}

export async function focusTerminal(page) {
  await page.locator("#terminal").click();
  // Clicking rendered cells may not focus xterm's hidden input in every ConPTY frame, so explicitly ask the terminal to capture input.
  await page.evaluate(() => window.tuiLab.focus());
}

export async function pressTerminalEscape(page, platform) {
  // Unix crossterm uses Kitty keyboard disambiguation, while ConPTY needs a traditional ESC byte that maps to VK_ESCAPE.
  await page.evaluate(
    (windows) => window.tuiLab.sendInput(windows ? "\u001b" : "\u001b[27u"),
    platform === "win32",
  );
}

export async function submitTerminalLine(page, text) {
  await focusTerminal(page);
  await typeHumanText(page, text);
  await page.waitForTimeout(120);
  // Write xterm Enter's exact CR byte through the existing PTY WebSocket to avoid browser focus races.
  await page.evaluate(() => window.tuiLab.sendInput("\r"));
}

export async function waitForTerminalTextCount(
  page,
  text,
  expectedCount,
  timeout,
) {
  await page.waitForFunction(
    ({ expectedText, minCount }) => {
      if (!window.tuiLab) return false;
      const haystack = window.tuiLab.text();
      let count = 0;
      let offset = 0;
      while (true) {
        const next = haystack.indexOf(expectedText, offset);
        if (next === -1) break;
        count += 1;
        offset = next + expectedText.length;
      }
      return count >= minCount;
    },
    { expectedText: text, minCount: expectedCount },
    { timeout },
  );
}
