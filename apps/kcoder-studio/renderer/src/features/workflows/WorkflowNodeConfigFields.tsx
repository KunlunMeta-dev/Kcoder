import { WorkflowReusePicker } from './WorkflowReusePicker'
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
export function PredicateFields({
  value,
  onChange,
  depth = 0,
}: {
  value: unknown
  onChange: (value: Record<string, unknown> | undefined) => void
  depth?: number
}) {
  const { t } = useTranslation('common')
  const predicate = record(value)
  const op = typeof predicate.op === 'string' ? predicate.op : 'exists'
  const grouped = op === 'all' || op === 'any'
  const children = Array.isArray(predicate.conditions) ? predicate.conditions : []
  const leaf = { op: 'exists', pointer: '/input' }
  if (depth > 8)
    return (
      <p role="alert" className="text-xs text-destructive">
        {t('workflowCanvas.predicateDepth')}
      </p>
    )
  return (
    <div className="space-y-2" data-testid="workflow-predicate">
      <label className="block space-y-1 text-sm">
        {t('workflowCanvas.operator')}
        <select
          data-testid="workflow-predicate-operator"
          className={field}
          value={op}
          onChange={event => {
            const next = event.target.value
            if (next === 'all' || next === 'any')
              onChange({
                op: next,
                conditions: grouped
                  ? children
                  : [op === 'not' ? (predicate.condition ?? leaf) : predicate],
              })
            else if (next === 'not') onChange({ op: next, condition: predicate })
            else
              onChange({
                op: next,
                pointer: predicate.pointer ?? '/input',
                ...(next === 'exists'
                  ? {}
                  : {
                      value: ['greater_than', 'less_than'].includes(next)
                        ? 0
                        : (predicate.value ?? ''),
                    }),
              })
          }}
        >
          {[
            'exists',
            'equals',
            'not_equals',
            'greater_than',
            'less_than',
            'contains',
            'all',
            'any',
            'not',
          ].map(item => (
            <option
              key={item}
              value={item}
              disabled={depth >= 8 && ['all', 'any', 'not'].includes(item)}
            >
              {t(`workflowCanvas.op_${item}`)}
            </option>
          ))}
        </select>
      </label>
      {grouped ? (
        <div className="space-y-3 border-l border-border pl-3">
          {children.map((child, index) => (
            <div key={index} className="space-y-1">
              <PredicateFields
                value={child}
                depth={depth + 1}
                onChange={next =>
                  onChange({
                    ...predicate,
                    conditions: children.map((entry, at) => (at === index ? next : entry)),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={children.length <= 1}
                onClick={() =>
                  onChange({ ...predicate, conditions: children.filter((_, at) => at !== index) })
                }
              >
                {t('workflowCanvas.removeCondition')}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={children.length >= 16 || depth >= 8}
            onClick={() => onChange({ ...predicate, conditions: [...children, leaf] })}
          >
            {t('workflowCanvas.addCondition')}
          </Button>
        </div>
      ) : op === 'not' ? (
        <div className="border-l border-border pl-3">
          <PredicateFields
            value={predicate.condition}
            depth={depth + 1}
            onChange={condition => onChange({ op: 'not', condition })}
          />
        </div>
      ) : (
        <>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.pointer')}
            <input
              className={field}
              value={String(predicate.pointer ?? '/input')}
              onChange={event => onChange({ ...predicate, pointer: event.target.value })}
            />
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
        </>
      )}
    </div>
  )
}

function SwitchFields({
  value,
  onChange,
}: {
  value: unknown
  onChange: (value: Record<string, unknown>) => void
}) {
  const { t } = useTranslation('common')
  const routes = record(value)
  const cases = Array.isArray(routes.cases) ? routes.cases.map(record) : []
  const update = (index: number, change: Record<string, unknown>) =>
    onChange({
      ...routes,
      cases: cases.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
    })
  const move = (index: number, delta: number) => {
    const next = [...cases]
    ;[next[index], next[index + delta]] = [next[index + delta], next[index]]
    onChange({ ...routes, cases: next })
  }
  return (
    <div className="space-y-3" data-testid="workflow-switch-fields">
      <p className="text-xs text-text-muted">{t('workflowCanvas.switchHint')}</p>
      {cases.map((entry, index) => (
        <fieldset key={index} className="space-y-2 border-l border-border pl-3">
          <legend className="text-sm">
            {t('workflowCanvas.route')} {index + 1}
          </legend>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.routeName')}
            <input
              className={field}
              value={String(entry.label ?? '')}
              onChange={event => update(index, { label: event.target.value })}
            />
          </label>
          <PredicateFields
            value={entry.condition}
            onChange={condition => update(index, { condition })}
          />
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              {t('workflowCanvas.moveUp')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={index === cases.length - 1}
              onClick={() => move(index, 1)}
            >
              {t('workflowCanvas.moveDown')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={cases.length <= 1}
              onClick={() => onChange({ ...routes, cases: cases.filter((_, at) => at !== index) })}
            >
              {t('workflowCanvas.removeRoute')}
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="workflow-switch-add-route"
        disabled={cases.length >= 16}
        onClick={() => {
          let suffix = cases.length + 1
          while (
            cases.some(entry => entry.label === `route_${suffix}`) ||
            routes.default === `route_${suffix}`
          )
            suffix++
          onChange({
            ...routes,
            cases: [
              ...cases,
              { label: `route_${suffix}`, condition: { op: 'exists', pointer: '/input' } },
            ],
          })
        }}
      >
        {t('workflowCanvas.addRoute')}
      </Button>
      <label className="block space-y-1 text-sm">
        {t('workflowCanvas.defaultRoute')}
        <input
          data-testid="workflow-switch-default"
          className={field}
          value={String(routes.default ?? '')}
          onChange={event => onChange({ ...routes, default: event.target.value })}
        />
      </label>
    </div>
  )
}
export function WorkflowNodeConfigFields({
  serverId,
  kind,
  config,
  node,
  definition,
  onChange,
}: {
  serverId?: string
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
      <details className="rounded-lg border border-border p-2">
        <summary data-testid="workflow-failure-toggle" className="cursor-pointer text-sm">{t('workflowCanvas.failurePolicy')}</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-text-muted">{t('workflowCanvas.failurePolicyHint')}</p>
          <label className="block space-y-1 text-sm">{t('workflowCanvas.failureAction')}
            <select data-testid="workflow-failure-action" className={field} value={record(config.failurePolicy).continueOnError ? 'continue' : 'stop'} onChange={event => patch({failurePolicy:{...record(config.failurePolicy),continueOnError:event.target.value === 'continue'}})}>
              <option value="stop">{t('workflowCanvas.stopOnError')}</option>
              <option value="continue">{t('workflowCanvas.routeOnError')}</option>
            </select>
          </label>
          {!['agent','loop','subworkflow','wait','human','event'].includes(kind) && <>
            <label className="block space-y-1 text-sm">{t('workflowCanvas.maxAttempts')}
              <input className={field} type="number" min={1} max={3} value={Number(record(config.failurePolicy).maxAttempts ?? 1)} onChange={event => patch({failurePolicy:{...record(config.failurePolicy),maxAttempts:Number(event.target.value)}})} />
            </label>
            <label className="block space-y-1 text-sm">{t('workflowCanvas.retryDelay')}
              <input className={field} type="number" min={0} max={60000} value={Number(record(config.failurePolicy).delayMs ?? 0)} onChange={event => patch({failurePolicy:{...record(config.failurePolicy),delayMs:Number(event.target.value)}})} />
            </label>
          </>}
        </div>
      </details>

      {kind === 'transform' && <p className="text-xs text-text-muted">{t('workflowCanvas.transformHint')}</p>}
      {['wait','human','event'].includes(kind) && <p className="text-xs text-text-muted">{t(`workflowCanvas.${kind}Hint`)}</p>}
      {kind === 'human' && <label className="block space-y-1 text-sm">{t('workflowCanvas.humanPrompt')}<textarea className={field} rows={3} value={String(record(config.human).prompt ?? '')} onChange={event => patch({human:{...record(config.human),prompt:event.target.value}})} /></label>}
      {kind === 'event' && <label className="block space-y-1 text-sm">{t('workflowCanvas.eventName')}<input className={field} value={String(record(config.event).name ?? '')} onChange={event => patch({event:{...record(config.event),name:event.target.value}})} /></label>}
      {kind === 'wait' && <label className="block space-y-1 text-sm">{t('workflowCanvas.waitDelay')}<input className={field} type="number" min={0} max={86400000} value={Number(record(config.wait).delayMs ?? 0)} onChange={event => patch({wait:{delayMs:Number(event.target.value)}})} /></label>}
      {kind === 'subworkflow' && (
        <div className="space-y-2">
          <p className="text-xs text-text-muted">{t('workflowCanvas.subworkflowHint')}</p>
          {serverId && <WorkflowReusePicker serverId={serverId} disabled={false} onInsert={() => {}}
            onChoose={(definition, args) => patch({ subworkflow: { definitionId: definition.id, version: definition.savedVersion, arguments: args, bindings: {} } })} />}
          <p className="break-all text-xs text-text-secondary">{String(record(config.subworkflow).definitionId ?? '')} · v{String(record(config.subworkflow).version ?? '')}</p>
        </div>
      )}
      {kind === 'tool' && (
        <>
          <p className="text-xs text-text-muted">{t('workflowCanvas.toolHint')}</p>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.toolName')}
            <input data-testid="workflow-node-tool-name" className={field} value={String(record(config.tool).name ?? '')}
              onChange={event => patch({ tool: { ...record(config.tool), name: event.target.value } })} />
          </label>
          <p className="text-xs text-text-muted">{t('workflowCanvas.toolBindingsHint')}</p>
        </>
      )}
      {kind === 'code' && (
        <>
          <p className="text-xs text-text-muted">{t('workflowCanvas.codeHint')}</p>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.codeSource')}
            <textarea data-testid="workflow-node-code-source" className={field} rows={8}
              value={String(record(config.code).source ?? '')}
              onChange={event => patch({ code: { ...record(config.code), source: event.target.value } })} />
          </label>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.codeTimeout')}
            <input type="number" min={1} max={10000} className={field}
              value={Number(record(config.code).timeoutMs ?? 1000)}
              onChange={event => patch({ code: { ...record(config.code), timeoutMs: Number(event.target.value) } })} />
          </label>
        </>
      )}
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
      {kind === 'switch' && (
        <SwitchFields value={config.switch} onChange={routes => patch({ switch: routes })} />
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
            {t('workflowCanvas.loopBody')}
            <select className={field} data-testid="workflow-loop-body-kind" value={loop.body ? 'subworkflow' : 'agent'}
              onChange={event => patch({validationRetries:undefined,loop:{...loop,body:event.target.value === 'subworkflow' ? {definitionId:'',version:1,arguments:{},bindings:{}} : undefined}})}>
              <option value="agent">{t('workflowCanvas.kind_agent')}</option>
              <option value="subworkflow">{t('workflowCanvas.kind_subworkflow')}</option>
            </select>
          </label>
          {Boolean(loop.body) && <div className="space-y-2">
            <p className="text-xs text-text-muted">{t('workflowCanvas.loopBodyHint')}</p>
            {serverId && <WorkflowReusePicker serverId={serverId} disabled={false} onInsert={() => {}}
              onChoose={(definition,args) => patch({loop:{...loop,body:{definitionId:definition.id,version:definition.savedVersion,arguments:args,bindings:{}}}})} />}
            <p className="break-all text-xs">{String(record(loop.body).definitionId ?? '')} · v{String(record(loop.body).version ?? '')}</p>
          </div>}

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
      {(kind === 'agent' || (kind === 'loop' && !loop.body)) && (
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
