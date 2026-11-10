import { useTranslation } from '@/hooks/useTranslation'
import type { TurnFileChangesCapture } from '../../../../shared/generated/contracts'

export function TaskCaptureObservation({ capture }: { capture: TurnFileChangesCapture }) {
  const { t, i18n } = useTranslation('chat')
  const format = (ms: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' }).format(ms)
  return (
    <div className="space-y-1" data-testid="task-capture-observation">
      <p role="status" data-testid="task-capture-state" data-capture-state={capture.state}>
        {t(`taskCapture.states.${capture.state}`)}
      </p>
      {capture.limitations.map(reason => (
        <p key={reason} className="text-xs text-text-muted">
          {t(`taskCapture.limitations.${reason}`)}
        </p>
      ))}
      <p className="text-xs text-text-muted">{t('taskCapture.intervalScope')}</p>
      {(capture.base || capture.head) && (
        <details>
          <summary
            data-testid="task-capture-windows"
            className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1"
          >
            {t('taskCapture.windows')}
          </summary>
          <dl className="space-y-1 text-xs text-text-muted">
            {(['base', 'head'] as const).map(side => {
              const window = capture[side]
              return window ? (
                <div key={side}>
                  <dt>{t(`taskCapture.${side}`)}</dt>
                  <dd>
                    <time dateTime={new Date(window.startedAtMs).toISOString()}>
                      {format(window.startedAtMs)}
                    </time>
                    {' – '}
                    <time dateTime={new Date(window.completedAtMs).toISOString()}>
                      {format(window.completedAtMs)}
                    </time>
                  </dd>
                </div>
              ) : null
            })}
          </dl>
        </details>
      )}
    </div>
  )
}
