import assert from "node:assert/strict";

/** Assert user-visible cached-session capability boundaries within the cache route. */
export async function assertCachedSessionComposerReadOnly(page, label = "cached session") {
  const cachedView = page.getByTestId("session-cache-view");
  assert.equal(await cachedView.count(), 1, `${label} must have one cache-scoped view`);
  assert.equal(await cachedView.isVisible(), true, `${label} cache view must be visible`);

  const input = cachedView.getByTestId("message-input");
  assert.equal(await input.count(), 1, `${label} must retain the unified composer input`);
  assert.equal(await input.isVisible(), true, `${label} composer input must be visible`);
  assert.equal(await input.isEditable(), false, `${label} composer input must remain read-only`);

  const disabledActions = [
    ["send-message", "send"],
    ["composer-attachment", "attachment"],
    ["cached-session-model-selector", "model selection"],
    ["cached-session-permission-selector", "permission selection"],
  ];
  for (const [testId, description] of disabledActions) {
    const action = cachedView.getByTestId(testId);
    assert.equal(await action.count(), 1, `${label} must show the ${description} control`);
    assert.equal(await action.isVisible(), true, `${label} ${description} control must be visible`);
    assert.equal(await action.isDisabled(), true, `${label} ${description} control must be disabled`);
  }

  const quickPhrases = cachedView.getByTestId("composer-quick-phrases");
  if (await quickPhrases.count()) {
    assert.equal(await quickPhrases.isVisible(), true, `${label} quick phrases control must be visible`);
    assert.equal(await quickPhrases.isDisabled(), true, `${label} quick phrases control must not modify its preserved draft`);
  }

  return {
    inputVisible: await input.isVisible(),
    inputEditable: false,
    disabledControls: disabledActions.map(([, description]) => description),
    quickPhrasesVisible: Boolean(await quickPhrases.count()),
  };
}

export async function createAndPersistUnsentMultilineDraft(page, { threadId, waitFor }) {
  const draft = [
    "CACHE_RESTORE_UNSENT_DRAFT_LINE_01",
    "CACHE_RESTORE_UNSENT_DRAFT_LINE_02",
    "CACHE_RESTORE_UNSENT_DRAFT_LINE_03",
    "CACHE_RESTORE_UNSENT_DRAFT_LINE_04",
    "CACHE_RESTORE_UNSENT_DRAFT_LINE_05",
    "CACHE_RESTORE_UNSENT_DRAFT_LINE_06",
    "CACHE_RESTORE_UNSENT_DRAFT_LINE_07",
  ].join("\n");
  const composer = page.getByTestId("message-input");
  await composer.fill(draft);
  assert.equal(await composer.inputValue(), draft,
    "the live composer must retain the multiline unsent draft before navigation");
  await waitFor(async () => {
    const persisted = await page.evaluate(({ threadId, draft }) => {
      const prefix = "kcoder-studio:mobile-workspace-state:v3:";
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix) || !key.includes(encodeURIComponent(threadId))) continue;
        try {
          const state = JSON.parse(localStorage.getItem(key) ?? "null");
          if (state?.composerDraft === draft) return true;
        } catch { /* Ignore unrelated or malformed local state keys. */ }
      }
      return false;
    }, { threadId, draft });
    return persisted ? true : null;
  }, 30_000, "the exact thread's local composer draft to finish its ordinary workspace-state save");
  return draft;
}

export async function verifyCachedReadOnlyMultilineDraft(page, {
  draft,
  anchorDomId,
  persistedAnchorOffset,
  initialAnchorOffset,
  readTranscriptViewport,
  waitFor,
}) {
  const input = page.getByTestId("session-cache-view").getByTestId("message-input");
  await waitFor(async () => await input.inputValue() === draft ? true : null,
    30_000, "the owner-scoped multiline local draft to hydrate while the authority response remains held");
  assert.equal(await input.isEditable(), false, "the restored cached draft must remain read-only");
  const geometry = await input.evaluate(element => ({
    tagName: element.tagName,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert.equal(geometry.tagName, "TEXTAREA", "the shared multiline composer must remain a native textarea in the browser");
  assert.ok(geometry.scrollHeight > geometry.clientHeight,
    "a restored draft longer than five lines must keep an internally scrollable input");
  await input.hover();
  await page.mouse.wheel(0, 240);
  await waitFor(async () => await input.evaluate(element => element.scrollTop > 0) ? true : null,
    5_000, "the read-only multiline draft input to scroll internally to older text");
  const scrollTop = await input.evaluate(element => element.scrollTop);
  const viewport = await readTranscriptViewport(page, {
    rowDomId: anchorDomId,
    rowTestId: "message-user",
  });
  assert.equal(viewport.rowMatchCount, 1, "the cached anchor row must remain present while authority is held");
  assert.equal(viewport.rowIntersectsWindow, true, "the cached anchor row must remain in the browser viewport while authority is held");
  assertNear(viewport.row.offsetFromHost, persistedAnchorOffset,
    "cached row offset versus persisted reading anchor");
  assertNear(viewport.row.offsetFromHost, initialAnchorOffset,
    "cached row offset before and after owner-scoped draft expands the footer");
  return { scrollTop, viewport };
}

export function assertCachedAuthorityIdentitySnapshot(snapshot, expectedMessageIds, label, removedAnchorMessageId = null) {
  assert.ok(snapshot.ready, `${label} must commit its complete authority page`);
  assert.equal(snapshot.markerPresent, true, `${label} must contain its expected marker`);
  const cachedMessageIds = snapshot.messageIdentities.map(message => message.id);
  assert.deepEqual([...cachedMessageIds].sort(), [...expectedMessageIds].sort(),
    `${label} message identities must equal the exact authority response`);
  assert.ok(!snapshot.anchorPresent || expectedMessageIds.includes(snapshot.anchor.messageId),
    `${label} must not retain an anchor to a message outside its authority page`);
  assert.ok(removedAnchorMessageId === null || !snapshot.anchorPresent || snapshot.anchor.messageId !== removedAnchorMessageId,
    `${label} must not retain the removed source anchor`);
}

function assertNear(actual, expected, label, tolerance = 4) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label} must be finite`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label} changed from ${expected}px to ${actual}px (tolerance ${tolerance}px)`);
}
