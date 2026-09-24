import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeKind } from './workflowApi'
const field =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30'
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const scalar = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
const display = (value: unknown) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
function PredicateFields({
  value,
  onChange,
}: {
  value: unknown
  onChange: (value: Record<string, unknown> | undefined) => void
}) {
  const { t } = useTranslation('common')
  const predicate = record(value)
  const op = typeof predicate.op === 'string' ? predicate.op : 'exists'
  const simple = [
    'exists',
    'equals',
    'not_equals',
    'greater_than',
    'less_than',
    'contains',
  ].includes(op)
  if (!simple)
    return <p className="text-xs text-text-muted">{t('workflowCanvas.complexPredicate')}</p>
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-sm">
        {t('workflowCanvas.pointer')}
        <input
          className={field}
          value={String(predicate.pointer ?? '/input')}
          onChange={event => onChange({ ...predicate, pointer: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm">
        {t('workflowCanvas.operator')}
        <select
          className={field}
          value={op}
          onChange={event =>
            onChange({
              op: event.target.value,
              pointer: predicate.pointer ?? '/input',
              ...(event.target.value !== 'exists' ? { value: predicate.value ?? '' } : {}),
            })
          }
        >
          {['exists', 'equals', 'not_equals', 'greater_than', 'less_than', 'contains'].map(item => (
            <option key={item} value={item}>
              {t(`workflowCanvas.op_${item}`)}
            </option>
          ))}
        </select>
      </label>
      {op !== 'exists' && (
        <label className="block space-y-1 text-sm">
          {t('workflowCanvas.compareValue')}
          <input
            className={field}
            value={display(predicate.value)}
            onChange={event => onChange({ ...predicate, value: scalar(event.target.value) })}
          />
        </label>
      )}
    </div>
  )
}
export function WorkflowNodeConfigFields({
  kind,
  config,
  node,
  definition,
  onChange,
}: {
  kind: WorkflowNodeKind
  config: Record<string, unknown>
  node: WorkflowNode
  definition: WorkflowDefinition
  onChange: (value: Record<string, unknown>) => void
}) {
  const { t } = useTranslation('common')
  const patch = (value: Record<string, unknown>) => onChange({ ...config, ...value })
  const loop = record(config.loop)
  const references = [
    '/input',
    ...node.dependsOn
      .filter(id => definition.nodes.some(item => item.id === id))
      .map(id => `/nodes/${id}`),
    ...(kind === 'loop' ? ['/iteration/index', '/iteration/item', '/iteration/output'] : []),
  ]
  return (
    <div className="space-y-3" data-testid="workflow-node-config-fields">
      {(kind === 'input' || kind === 'output') && (
        <label className="block space-y-1 text-sm">
          {t('workflowCanvas.pointer')}
          <input
            data-testid="workflow-node-pointer"
            className={field}
            value={String(config.pointer ?? '')}
            onChange={event => patch({ pointer: event.target.value })}
          />
        </label>
      )}
      {kind === 'template' && (
        <label className="block space-y-1 text-sm">
          {t('workflowCanvas.templateBody')}
          <textarea
            data-testid="workflow-node-template"
            className={field}
            rows={5}
            value={String(config.template ?? '')}
            onChange={event => patch({ template: event.target.value })}
          />
        </label>
      )}
      {kind === 'condition' && (
        <PredicateFields value={config.condition} onChange={condition => patch({ condition })} />
      )}
      {kind === 'merge' && (
        <label className="block space-y-1 text-sm">
          {t('workflowCanvas.mergePolicy')}
          <select
            className={field}
            value={String(config.mergePolicy ?? 'all')}
            onChange={event => patch({ mergePolicy: event.target.value })}
          >
            <option value="all">{t('workflowCanvas.mergeAll')}</option>
            <option value="any">{t('workflowCanvas.mergeAny')}</option>
          </select>
        </label>
      )}
      {kind === 'loop' && (
        <>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.loopMode')}
            <select
              className={field}
              value={String(loop.mode ?? 'repeat')}
              onChange={event =>
                patch({
                  loop: {
                    ...loop,
                    mode: event.target.value,
                    ...(event.target.value === 'for_each'
                      ? { collectionPointer: loop.collectionPointer ?? '/input/items' }
                      : { collectionPointer: undefined }),
                  },
                })
              }
            >
              <option value="repeat">{t('workflowCanvas.repeat')}</option>
              <option value="for_each">{t('workflowCanvas.forEach')}</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.maxIterations')}
            <input
              type="number"
              min={1}
              max={10}
              className={field}
              value={Number(loop.maxIterations ?? 3)}
              onChange={event =>
                patch({ loop: { ...loop, maxIterations: Number(event.target.value) } })
              }
            />
          </label>
          {loop.mode === 'for_each' && (
            <label className="block space-y-1 text-sm">
              {t('workflowCanvas.collectionPointer')}
              <input
                className={field}
                value={String(loop.collectionPointer ?? '/input/items')}
                onChange={event =>
                  patch({ loop: { ...loop, collectionPointer: event.target.value } })
                }
              />
            </label>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              patch({
                loop: {
                  ...loop,
                  until: loop.until ? undefined : { op: 'exists', pointer: '/iteration/output' },
                },
              })
            }
          >
            {t(loop.until ? 'workflowCanvas.removeUntil' : 'workflowCanvas.addUntil')}
          </Button>
          {Boolean(loop.until) && (
            <PredicateFields
              value={loop.until}
              onChange={until => patch({ loop: { ...loop, until } })}
            />
          )}
        </>
      )}
      {(kind === 'agent' || kind === 'loop') && (
        <label className="block space-y-1 text-sm">
          {t('workflowCanvas.validationRetries')}
          <input
            type="number"
            min={0}
            max={2}
            className={field}
            value={Number(config.validationRetries ?? 0)}
            onChange={event => patch({ validationRetries: Number(event.target.value) })}
          />
        </label>
      )}
      {['input', 'output', 'template'].includes(kind) && (
        <div className="space-y-1">
          <p className="text-xs text-text-muted">{t('workflowCanvas.insertVariable')}</p>
          <div className="flex flex-wrap gap-1">
            {references.map(pointer => (
              <Button
                key={pointer}
                size="sm"
                variant="ghost"
                className="max-w-full truncate font-mono text-xs"
                onClick={() =>
                  kind === 'template'
                    ? patch({ template: `${config.template ?? ''}{{${pointer}}}` })
                    : patch({ pointer })
                }
              >
                {pointer}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
