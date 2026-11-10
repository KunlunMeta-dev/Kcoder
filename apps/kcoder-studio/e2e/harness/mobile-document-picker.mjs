import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/**
 * Select files through Playwright's real filechooser event. Expo's Web picker
 * creates its input and clicks it asynchronously, so the chooser listener and
 * DOM event observation must both be installed before clicking the UI.
 */
export async function setExpoWebDocumentPickerFiles(page, files) {
  const payloads = Array.isArray(files) ? files : [files];
  assert.ok(payloads.length > 0, "Expo DocumentPicker needs at least one file");

  const inputs = page.locator('input[type="file"]');
  const inputCountBefore = await inputs.count();
  const captureKey = `__kcoderExpoPickerEvidence_${randomUUID().replaceAll("-", "")}`;
  await page.evaluate(({ key }) => {
    const observer = { events: [], listeners: [] };
    for (const type of ["input", "change", "cancel"]) {
      const listener = event => {
        const element = event.target;
        if (!(element instanceof HTMLInputElement) || element.type !== "file") return;
        observer.events.push({
          type,
          inputIndex: Array.from(document.querySelectorAll('input[type="file"]')).indexOf(element),
          fileCount: element.files?.length ?? 0,
          files: Array.from(element.files ?? [], file => ({
            name: file.name,
            type: file.type,
            size: file.size,
            lastModified: file.lastModified,
          })),
        });
      };
      document.addEventListener(type, listener, true);
      observer.listeners.push([type, listener]);
    }
    Object.defineProperty(window, key, { configurable: true, value: observer });
  }, { key: captureKey });

  let filechooserObserved = false;
  let chooserMultiple = null;
  let details = null;
  let inputCountAfterCreate = null;
  let setFilesCompleted = false;
  let events = [];
  const collectEvents = async () => {
    const collected = await page.evaluate(key => {
      const observer = window[key];
      if (!observer) return [];
      for (const [type, listener] of observer.listeners) {
        document.removeEventListener(type, listener, true);
      }
      delete window[key];
      return observer.events;
    }, captureKey);
    events = Array.isArray(collected) ? collected : [];
    return events;
  };
  const evidence = () => {
    const changeEvent = events.find(event => event.type === "change");
    return {
      inputCountBefore,
      inputCountAfterCreate,
      inputIndex: changeEvent?.inputIndex ?? null,
      filechooserObserved,
      filechooserMultiple: chooserMultiple,
      chooserSetFilesCompleted: setFilesCompleted,
      inputType: details?.type ?? null,
      inputHidden: details?.display === "none",
      multiple: details?.multiple ?? null,
      accept: details?.accept ?? null,
      fileCount: payloads.length,
      inputEventCount: events.filter(event => event.type === "input").length,
      changeEventCount: events.filter(event => event.type === "change").length,
      cancelEventCount: events.filter(event => event.type === "cancel").length,
      selectionEvents: events,
      selectedFiles: changeEvent?.files ?? [],
    };
  };

  try {
    const chooserResult = page.waitForEvent("filechooser", { timeout: 10_000 }).then(
      chooser => ({ chooser }),
      error => ({ error }),
    );
    await page.getByText("选择文件", { exact: true }).click();
    const result = await chooserResult;
    if (result.error) throw result.error;

    filechooserObserved = true;
    const chooser = result.chooser;
    const input = chooser.element();
    details = await input.evaluate(element => ({
      type: element.type,
      display: element.style.display,
      multiple: element.multiple,
      accept: element.getAttribute("accept"),
      connected: element.isConnected,
    }));
    inputCountAfterCreate = await inputs.count();
    assert.ok(inputCountAfterCreate > inputCountBefore, "Expo must append a new file input before opening the chooser");
    assert.equal(details.type, "file", "Expo DocumentPicker must create a file input");
    assert.equal(details.display, "none", "Expo Web picker input is intentionally hidden");
    assert.equal(details.connected, true, "the picker input must still be attached before selection");
    chooserMultiple = await chooser.isMultiple();
    assert.equal(chooserMultiple, details.multiple, "Playwright chooser and file input must agree on multiple selection");

    await chooser.setFiles(payloads);
    setFilesCompleted = true;
    await page.waitForFunction(
      key => window[key]?.events.some(event => event.type === "change"),
      captureKey,
      { timeout: 10_000 },
    );
    await collectEvents();
    return evidence();
  } catch (error) {
    await collectEvents().catch(() => {});
    const wrapped = new Error(
      `Expo Web DocumentPicker filechooser flow failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    wrapped.pickerEvidence = evidence();
    throw wrapped;
  }
}
