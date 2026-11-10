import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { waitFor } from "../../../harness/run-context.mjs";

/** Exercises only the caller's isolated task, browser storage and workspace file. */
export async function verifyDraftNotices({ page, ui, workspace, capture }) {
  await page.addInitScript(() => {
    const key = sessionStorage.getItem("owned-draft-notice-review-reset");
    if (key) {
      sessionStorage.removeItem("owned-draft-notice-review-reset");
      localStorage.removeItem(key);
    }
  });
  const fileName = "draft-notice-review.txt";
  const filePath = resolve(workspace, fileName);
  await writeFile(filePath, "Original file\n");
  const acceptDialog = dialog => { void dialog.accept(); };
  page.on("dialog", acceptDialog);
  try {
    await ui("task-more").click();
    await ui("task-menu-workspace").click();
    await ui("workspace-tab-files-1").click();
    const files = ui("files-panel");
    await files.getByLabel("刷新", { exact: true }).click();
    await files.getByText(fileName, { exact: true }).click();
    const editor = ui("file-editor");
    await editor.waitFor({ timeout: 30_000 });
    const savedElsewhere = "The retained edit is already on disk\n";
    await editor.fill(savedElsewhere);
    await waitFor(async () => page.evaluate(text => Object.keys(localStorage).some(key =>
      key.startsWith("kcoder-studio:mobile-workspace-state:v3:") &&
      localStorage.getItem(key)?.includes(JSON.stringify(text))), savedElsewhere), 10_000, "file draft is persisted before external save");
    await writeFile(filePath, savedElsewhere);
    await page.reload({ waitUntil: "domcontentloaded" });
    await editor.waitFor({ timeout: 30_000 });
    assert.equal(await editor.inputValue(), savedElsewhere);
    await files.getByText(/^已保存 · Ln /).waitFor();
    assert.equal(await files.getByText("已恢复上次未保存的本地草稿。", { exact: true }).count(), 0);
    assert.equal(await ui("file-conflict-banner").count(), 0);
    assert.equal(await files.getByText("服务器文件已变化；已恢复本地草稿，保存时会先检查版本冲突。", { exact: true }).count(), 0);
    await capture("draft-already-saved");
    await ui("task-more").click();
    await ui("task-menu-workspace").click();
    await ui("workspace-tab-agent").click();
    await ui("message-input").waitFor();

    const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
    const currentKey = await page.evaluate(id => Object.keys(localStorage).find(key =>
      key.startsWith("kcoder-studio:mobile-workspace-state:v3:") &&
      key.includes(`:${encodeURIComponent(id)}:scope:`)), threadId);
    assert.ok(currentKey, "the owned task has an authorization-scoped state");
    const notice = page.getByText("此前授权下的草稿或待处理内容已保留，未自动恢复到当前授权。", { exact: true }).filter({ visible: true });
    for (const [name, state, expectedNotice] of [
      ["settings-only", { activeTab: "files", model: "previous-model" }, false],
      ["actual-draft", { composerDraft: "Owned earlier-authorization draft" }, true],
    ]) {
      const retained = await page.evaluate(({ key, state }) => {
        const marker = key.lastIndexOf(":scope:");
        const scope = JSON.parse(decodeURIComponent(key.slice(marker + 7)));
        scope[1] = "owned-earlier-authorization";
        const oldScope = JSON.stringify(scope);
        const otherKey = key.slice(0, marker + 7) + encodeURIComponent(oldScope);
        const indexKey = key.slice(0, marker).replace("mobile-workspace-state:v3", "mobile-workspace-scope-index:v1");
        const scopes = JSON.parse(localStorage.getItem(indexKey) ?? "[]");
        if (!scopes.includes(oldScope)) scopes.push(oldScope);
        const raw = JSON.stringify(state);
        localStorage.setItem(otherKey, raw);
        localStorage.setItem(indexKey, JSON.stringify(scopes));
        localStorage.removeItem(key);
        sessionStorage.setItem("owned-draft-notice-review-reset", key);
        return { otherKey, raw };
      }, { key: currentKey, state });
      await page.reload({ waitUntil: "domcontentloaded" });
      await ui("message-input").waitFor({ timeout: 30_000 });
      if (expectedNotice) await notice.waitFor();
      else assert.equal(await notice.count(), 0, "settings alone must not announce a retained draft");
      assert.equal(await ui("message-input").inputValue(), "", "another authorization's draft is never restored");
      assert.equal(await page.evaluate(key => localStorage.getItem(key), retained.otherKey), retained.raw);
      await capture(`retained-${name}`);
      await page.evaluate(key => localStorage.removeItem(key), retained.otherKey);
    }
    await page.evaluate(key => sessionStorage.setItem("owned-draft-notice-review-reset", key), currentKey);
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui("message-input").waitFor({ timeout: 30_000 });
    assert.equal(await notice.count(), 0, "a stale scope index without a retained record stays quiet");
  } finally {
    page.off("dialog", acceptDialog);
  }
}
