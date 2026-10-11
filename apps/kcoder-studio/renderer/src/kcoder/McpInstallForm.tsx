import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function McpInstallForm({
  install,
  disabled,
}: {
  install: (config: Record<string, unknown>) => Promise<void>
  disabled: boolean
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState('http')
  const [endpoint, setEndpoint] = useState('')
  const [args, setArgs] = useState('[]')
  const [options, setOptions] = useState('{}')
  const [error, setError] = useState('')
  const input =
    'min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm md:min-h-8'
  return (
    <div>
      <button
        className="min-h-11 rounded-lg px-3 text-sm hover:bg-surface md:min-h-8"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {t('workbench.mcp_add')}
      </button>
      {open && (
        <form
          data-testid="kcoder-mcp-install-form"
          className="my-3 flex max-w-lg flex-col gap-3"
          onSubmit={event => {
            event.preventDefault()
            setError('')
            void (async () => {
              try {
                const extra: unknown = JSON.parse(options)
                if (
                  !extra ||
                  typeof extra !== 'object' ||
                  Array.isArray(extra) ||
                  Object.keys(extra).some(key => !['env', 'headers'].includes(key))
                ) {
                  throw new Error(t('workbench.mcp_options_invalid'))
                }
                const parsedArgs: unknown = transport === 'stdio' ? JSON.parse(args) : []
                if (
                  !Array.isArray(parsedArgs) ||
                  parsedArgs.some(value => typeof value !== 'string')
                ) {
                  throw new Error(t('workbench.mcp_args_invalid'))
                }
                await install({
                  ...extra,
                  name: name.trim(),
                  transport,
                  ...(transport === 'stdio'
                    ? { command: endpoint, args: parsedArgs }
                    : { url: endpoint }),
                })
                setOptions('{}')
                setName('')
                setEndpoint('')
                setOpen(false)
              } catch (value) {
                setError(
                  value instanceof SyntaxError
                    ? t('workbench.mcp_json_invalid')
                    : value instanceof Error
                      ? value.message
                      : String(value)
                )
              }
            })()
          }}
        >
          <label>
            {t('workbench.mcp_name')}
            <input
              className={input}
              required
              value={name}
              disabled={disabled}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label>
            {t('workbench.mcp_transport')}
            <select
              className={input}
              value={transport}
              disabled={disabled}
              onChange={event => {
                setTransport(event.target.value)
                setEndpoint('')
              }}
            >
              <option value="http">Streamable HTTP</option>
              <option value="stdio">stdio</option>
              <option value="sse">SSE</option>
            </select>
          </label>
          <label>
            {t(transport === 'stdio' ? 'workbench.mcp_command' : 'workbench.mcp_url')}
            <input
              className={input}
              required
              value={endpoint}
              disabled={disabled}
              onChange={event => setEndpoint(event.target.value)}
            />
          </label>
          {transport === 'stdio' && (
            <label>
              {t('workbench.mcp_args')}
              <textarea
                className={input}
                value={args}
                disabled={disabled}
                onChange={event => setArgs(event.target.value)}
              />
            </label>
          )}
          <label>
            {t('workbench.mcp_options')}
            <textarea
              className={input}
              value={options}
              disabled={disabled}
              spellCheck={false}
              onChange={event => setOptions(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-text-secondary">
              {error}
            </p>
          )}
          <button
            className="min-h-11 rounded-lg bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
            type="submit"
            disabled={disabled}
          >
            {t('workbench.mcp_save')}
          </button>
        </form>
      )}
    </div>
  )
}
