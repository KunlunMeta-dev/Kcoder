import "@/i18n";
import "@/styles/globals.css";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopDownloadStatus } from "@/kcoder/DesktopDownloadStatus";
import { Button } from "@/components/ui/button";
import { installStudioAutomationBridge } from "@/e2e/automation";
import { readSelectedDeliveryFiles } from "@/tauri/droppedFiles";
import { downloadLink } from "@/kcoder/downloadLink";

function Fixture() {
  const [paths, setPaths] = useState("[]"),
    [result, setResult] = useState("idle");
  const controller = useRef<AbortController | null>(null);
  const read = async () => {
    const next = new AbortController();
    controller.current?.abort();
    controller.current = next;
    setResult("reading");
    try {
      const files = await readSelectedDeliveryFiles(JSON.parse(paths), {
        signal: next.signal,
      });
      const items = await Promise.all(
        files.map(async (item) => ({
          name: item.file.name,
          size: item.file.size,
          relativePath: item.relativePath,
          ...(item.file.size < 1024 ? { text: await item.file.text() } : {}),
        })),
      );
      setResult(JSON.stringify(items));
    } catch (error) {
      setResult(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      );
    }
  };
  const download = (kind: string) => {
    const blob = new Blob(
      [
        kind === "workflow"
          ? '{"id":"owned-workflow","nodes":[]}'
          : "# Owned Wiki source\n",
      ],
      { type: "text/plain" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download =
      kind === "workflow" ? "workflow-owned.json" : "wiki-original.md";
    downloadLink(link);
    // Match product callers: a save dialog may remain open beyond URL revocation.
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  return (
    <main className="min-h-screen bg-background p-5 text-text-primary">
      <h1 className="heading-sm">Owned native file transfer</h1>
      <input
        data-testid="file-paths"
        value={paths}
        onChange={(event) => setPaths(event.target.value)}
      />
      <Button data-testid="read-files" onClick={() => void read()}>
        Read selected files
      </Button>
      <Button
        data-testid="cancel-files"
        onClick={() => controller.current?.abort()}
      >
        Cancel selected-file read
      </Button>
      <pre data-testid="file-read-result">{result}</pre>
      <Button data-testid="download-wiki" onClick={() => download("wiki")}>
        Wiki Blob export
      </Button>
      <Button
        data-testid="download-workflow"
        onClick={() => download("workflow")}
      >
        Workflow Blob export
      </Button>
      <DesktopDownloadStatus />
    </main>
  );
}
window.addEventListener("kcoder:download-result", (event) => {
  document.documentElement.dataset.downloadResult = JSON.stringify(
    (event as CustomEvent).detail,
  );
});
createRoot(document.getElementById("root")!).render(<Fixture />);
installStudioAutomationBridge();

declare const __NATIVE_FILE_CASES__: null | {
  small: string;
  large: string;
  rejects: [string, string][];
  token: string;
};
if (__NATIVE_FILE_CASES__) {
  const cases = __NATIVE_FILE_CASES__;
  void (async () => {
    const result: Record<string, unknown> = {
      nativeAppCommands: true,
      binaryChunkBytes: 262144,
      modelCalls: 0,
    };
    try {
      const small = await readSelectedDeliveryFiles([cases.small]);
      if ((await small[0].file.text()) !== "owned native text")
        throw new Error("Small file content mismatch");
      const large = await readSelectedDeliveryFiles([cases.large]);
      if (large[0].file.size !== 104857600)
        throw new Error("100 MiB file size mismatch");
      result.smallFileContentVerified = true;
      result.exact100MiBImported = true;
      for (const [path, message] of cases.rejects) {
        let rejected = false;
        try {
          await readSelectedDeliveryFiles([path]);
        } catch (error) {
          rejected = String(error).includes(message);
        }
        if (!rejected)
          throw new Error(`Metadata budget did not reject ${message}`);
      }
      result.metadataSingleTotalCountDepthRejected = true;
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 25);
      let cancelled = false;
      try {
        await readSelectedDeliveryFiles([cases.large], {
          signal: controller.signal,
        });
      } catch (error) {
        cancelled = error instanceof Error && error.name === "AbortError";
      } finally {
        clearTimeout(timer);
      }
      if (!cancelled)
        throw new Error("Native transfer cancellation did not stop reading");
      await readSelectedDeliveryFiles([cases.small]);
      result.cancelledAndRecovered = true;
      result.status = "passed";
    } catch (error) {
      result.status = "failed";
      result.error = String(error);
    }
    document.querySelector('[data-testid="file-read-result"]')!.textContent =
      JSON.stringify(result);
    await fetch("/native-file-result", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cases.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(result),
    });
  })();
}
