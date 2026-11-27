import { useEffect, useState, type ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

type Canvas = typeof import('./WorkflowExecutionCanvas')['WorkflowExecutionCanvas']

/** Both conversation and automation viewers load the canvas only when opened. */
export function DeferredWorkflowExecutionCanvas(props: ComponentProps<Canvas>) {
  const { t } = useTranslation('common')
  const [Content, setContent] = useState<Canvas | 'failed' | null>(null)
  useEffect(() => {
    let active = true
    import('./WorkflowExecutionCanvas').then(module => {
      if (active) setContent(() => module.WorkflowExecutionCanvas)
    }).catch(() => {
      if (active) setContent('failed')
    })
    return () => { active = false }
  }, [])
  if (Content && Content !== 'failed') return <Content {...props} />
  return (
    <div className="flex min-h-0 w-full flex-col gap-3 p-4" data-testid="workflow-canvas-module">
      <p role={Content === 'failed' ? 'alert' : 'status'} aria-busy={Content !== 'failed'}
        className="text-sm text-text-secondary">
        {t(Content === 'failed' ? 'workflowCanvas.loadFailed' : 'common.loading')}
      </p>
      <Button variant="outline" className="self-start max-md:min-h-11" onClick={props.onClose}>
        {t('common.close')}
      </Button>
    </div>
  )
}
