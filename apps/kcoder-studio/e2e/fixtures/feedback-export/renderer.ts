import { captureFeedbackScreenshot, exportFeedbackBundle, feedbackCapabilities } from '../../../renderer/src/features/feedback/feedbackExport'

document.querySelector('button')!.addEventListener('click', () => {
  const button = document.querySelector('button')!
  button.disabled = true
  void (async () => {
    const capabilities = feedbackCapabilities()
    const result = await exportFeedbackBundle({
      destination: null, includeRuntimeLogs: capabilities.runtimeLogs,
      includeTaskInfo: true, includeScreenshot: capabilities.screenshot, includeSystemInfo: true,
      note: 'Owned feedback acceptance', taskContext: { taskId: 'owned-feedback-task' },
      screenshotDataUrl: capabilities.screenshot ? await captureFeedbackScreenshot() : null,
    })
    document.querySelector('output')!.textContent = JSON.stringify(result)
  })().catch(error => { document.querySelector('output')!.textContent = JSON.stringify({ error: String(error) }) })
})
