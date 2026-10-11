import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkflowArguments } from './WorkflowArguments'
import type { WorkflowDefinition, WorkflowScenarioInput } from './workflowApi'
export function WorkflowVerificationPrepare({
  definition,
  workspace,
  args,
  disabled = false,
  scenariosSupported = false,
  onClose,
  onPrepared,
}: {
  definition: WorkflowDefinition
  workspace: string
  args: string
  disabled?: boolean
  scenariosSupported?: boolean
  onClose: () => void
  onPrepared: (workspace: string, args: unknown, scenario?: WorkflowScenarioInput) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [path, setPath] = useState(workspace)
  const [input, setInput] = useState(args)
  const [named, setNamed] = useState(false)
  const [caseId, setCaseId] = useState('verification')
  const [checked, setChecked] = useState<string[]>([])
  const [assertSkipped, setAssertSkipped] = useState(false)
  const [skipped, setSkipped] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const candidates = definition.nodes.filter(node => node.config?.resultCheck != null)
  const validCase = !named || (/^[A-Za-z0-9_-]{1,64}$/.test(caseId) && checked.length > 0)
  const prepare = async () => {
    if (disabled || pending || !path.trim() || !validCase) return
    setPending(true)
    setError('')
    try {
      const args: unknown = JSON.parse(input)
      await onPrepared(
        path.trim(),
        args,
        named
          ? {
              id: caseId,
              requiredCheckNodes: checked,
              ...(assertSkipped
                ? { expectedSkippedNodes: skipped.filter(id => !checked.includes(id)) }
                : {}),
            }
          : undefined
      )
    } catch (failure) {
      setError(String(failure))
      setPending(false)
    }
  }
  return (
    <ModalDialog
      title={t('workflowVerification.prepare')}
      testId="workflow-prepare-dialog"
      pending={pending}
      onClose={onClose}
      closeLabel={t('workflowVerification.cancel')}
    >
      <p className="my-3 text-sm">
        {t('workflowVerification.prepareExplanation', { version: definition.savedVersion })}
      </p>
      <label className="my-3 block text-sm">
        {t('workflowCanvas.workspace')}
        <input
          value={path}
          disabled={pending || disabled}
          onChange={event => setPath(event.target.value)}
          data-testid="workflow-verification-workspace"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2"
        />
      </label>
      <WorkflowArguments schema={definition.inputSchema} value={input} onChange={setInput} />
      <label className="my-3 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={named}
          disabled={pending || disabled || !scenariosSupported || !candidates.length}
          onChange={event => setNamed(event.target.checked)}
          data-testid="workflow-named-case"
        />
        {t('workflowVerification.namedCase')}
      </label>
      {named && (
        <div className="space-y-2">
          <label className="block text-sm">
            {t('workflowVerification.caseId')}
            <input
              value={caseId}
              disabled={pending || disabled}
              onChange={event => setCaseId(event.target.value)}
              data-testid="workflow-case-id"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2"
            />
          </label>
          <p className="text-sm">{t('workflowVerification.chooseCaseChecks')}</p>
          {candidates.map(node => (
            <label key={node.id} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked.includes(node.id)}
                disabled={pending || disabled}
                onChange={event =>
                  setChecked(current =>
                    event.target.checked
                      ? [...current, node.id]
                      : current.filter(id => id !== node.id)
                  )
                }
                data-testid={`workflow-case-check-${node.id}`}
              />
              {node.title} · {node.id}
            </label>
          ))}
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={assertSkipped}
              disabled={pending || disabled}
              onChange={event => setAssertSkipped(event.target.checked)}
              data-testid="workflow-case-assert-skips"
            />
            {t('workflowVerification.assertSkipped')}
          </label>
          {assertSkipped &&
            definition.nodes
              .filter(node => !checked.includes(node.id))
              .map(node => (
                <label key={`skip-${node.id}`} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={skipped.includes(node.id)}
                    disabled={pending || disabled}
                    onChange={event =>
                      setSkipped(current =>
                        event.target.checked
                          ? [...current, node.id]
                          : current.filter(id => id !== node.id)
                      )
                    }
                    data-testid={`workflow-case-skip-${node.id}`}
                  />
                  {t('workflowVerification.expectSkipped', { node: node.title })}
                </label>
              ))}
        </div>
      )}
      {error && (
        <p role="alert" className="my-3">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          {t('workflowVerification.cancel')}
        </Button>
        <Button
          type="button"
          disabled={disabled || pending || !path.trim() || !validCase}
          data-testid="workflow-prepare-send"
          onClick={() => void prepare()}
        >
          {t('workflowVerification.toConversation')}
        </Button>
      </div>
    </ModalDialog>
  )
}
