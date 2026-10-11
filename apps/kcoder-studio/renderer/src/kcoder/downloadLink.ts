import { desktopHost } from './desktopHost'

// Keep the browser download behavior; Electron uses a main-frame IPC permit and
// returns the actual DownloadItem outcome, including a cancelled save dialog.
export function downloadLink(link: HTMLAnchorElement): void {
  const host = desktopHost()
  if (!host?.download) {
    link.click()
    return
  }
  void host
    .download({ url: link.href, filename: link.download })
    .then(result => {
      window.dispatchEvent(new CustomEvent('kcoder:download-result', { detail: result }))
    })
    .catch(error => {
      console.error('[KCoder download]', error instanceof Error ? error.message : String(error))
      window.dispatchEvent(
        new CustomEvent('kcoder:download-result', {
          detail: { status: 'interrupted', filename: link.download },
        })
      )
    })
}
