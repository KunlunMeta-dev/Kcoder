import { join } from "node:path";
import { isTrustedGatewayUrl } from "./security-policy.mjs";

// DownloadItem exposes a WebContents, not its initiating frame. Only an IPC
// request from the trusted main frame can mint a one-use URL permit; all other
// downloads are refused. The host initiates the permitted download itself.
export function registerDownloads({
  session,
  ipcMain,
  getWindow,
  getGatewayOrigin,
  downloadsDirectory,
}) {
  const pending = new Map();
  const allowedUrl = (value) =>
    typeof value === "string" &&
    value.length <= 32768 &&
    (value.startsWith("blob:")
      ? isTrustedGatewayUrl(value.slice(5), getGatewayOrigin())
      : /^https?:/.test(value) &&
        isTrustedGatewayUrl(value, getGatewayOrigin()));
  ipcMain.handle("kcoder:download", async (event, params) => {
    const window = getWindow(event.sender);
    const authorize = () =>
      window &&
      !window.isDestroyed() &&
      !event.sender.isDestroyed() &&
      event.senderFrame === event.sender.mainFrame &&
      isTrustedGatewayUrl(event.senderFrame?.url, getGatewayOrigin());
    if (!authorize())
      throw new Error("Download is restricted to the main application frame");
    if (
      !params ||
      Object.keys(params).some((key) => !["url", "filename"].includes(key)) ||
      !allowedUrl(params.url) ||
      typeof params.filename !== "string" ||
      !params.filename.trim() ||
      params.filename.length > 255 ||
      /[\\/\x00-\x1f]/.test(params.filename)
    )
      throw new Error("Invalid application download");
    if (pending.has(event.sender))
      throw new Error("A download is already pending");
    return new Promise((resolve, reject) => {
      const entry = {
        url: params.url,
        filename: params.filename,
        authorize,
        resolve,
        reject,
        item: null,
      };
      const finish = (result) => {
        if (pending.get(event.sender) !== entry) return;
        clearTimeout(entry.timer);
        pending.delete(event.sender);
        resolve(result);
      };
      entry.finish = finish;
      entry.timer = setTimeout(() => {
        entry.item?.cancel();
        finish({ status: "interrupted", filename: entry.filename });
      }, 10 * 60_000);
      entry.timer.unref();
      pending.set(event.sender, entry);
      try {
        event.sender.downloadURL(params.url);
      } catch (error) {
        clearTimeout(entry.timer);
        pending.delete(event.sender);
        reject(error);
      }
    });
  });
  const willDownload = (event, item, contents) => {
    const entry = pending.get(contents);
    if (
      !entry ||
      entry.item ||
      !entry.authorize() ||
      item.getURL() !== entry.url ||
      !item.getURLChain().every(allowedUrl)
    ) {
      event.preventDefault();
      return;
    }
    entry.item = item;
    item.setSaveDialogOptions({
      defaultPath: join(downloadsDirectory, entry.filename),
    });
    item.once("done", (_event, state) =>
      entry.finish({
        status: ["completed", "cancelled"].includes(state)
          ? state
          : "interrupted",
        filename: entry.filename,
      }),
    );
  };
  session.on("will-download", willDownload);
  return () => {
    ipcMain.removeHandler("kcoder:download");
    session.off("will-download", willDownload);
    for (const entry of pending.values()) {
      entry.item?.cancel();
      entry.finish({ status: "cancelled", filename: entry.filename });
    }
  };
}
