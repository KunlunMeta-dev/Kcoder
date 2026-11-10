import { safeErrorDiagnostic } from '@/lib/error-diagnostics'
import { isGatewayRuntime } from '@/lib/runtime-environment'

export interface RuntimeTaskCompletionNotification {
  title: string
  body: string
}

export async function sendRuntimeTaskCompletionNotification({
  title,
  body,
}: RuntimeTaskCompletionNotification): Promise<void> {
  if (!isGatewayRuntime()) return

  try {
    if (typeof Notification === 'undefined') return
    // Completion must not open a permission prompt without a user gesture.
    if (Notification.permission !== 'granted') return
    new Notification(title, { body })
  } catch (error) {
    console.error('[KCoder Studio] Failed to send task completion notification', safeErrorDiagnostic(error))
  }
}
