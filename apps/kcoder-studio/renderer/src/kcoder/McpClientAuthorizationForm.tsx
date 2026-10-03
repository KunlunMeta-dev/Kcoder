import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function McpClientAuthorizationForm({
  disabled,
  authorize,
}: {
  disabled: boolean
  authorize: (options: Record<string, unknown>) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [method, setMethod] = useState('none')
  const [scope, setScope] = useState('')
  const input =
    'min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm md:min-h-8'
  return (
    <details className="w-full text-sm" open={expanded}>
      <summary
        className="cursor-pointer text-text-secondary"
        onClick={event => {
          event.preventDefault()
          setExpanded(value => !value)
        }}
      >
        {t('workbench.mcp_client_options')}
      </summary>
      {expanded && (
        <form
          className="mt-3 flex max-w-lg flex-col gap-3"
          onSubmit={event => {
            event.preventDefault()
            const options: Record<string, unknown> = {
              scopes: scope.trim().split(/\s+/).filter(Boolean),
            }
            if (clientId.trim()) {
              options.clientId = clientId.trim()
              options.clientAuthentication = method
              if (method !== 'none') options.clientSecret = secret
            }
            setSecret('')
            void authorize(options)
          }}
        >
          <label>
            {t('workbench.mcp_client_id')}
            <input
              className={input}
              value={clientId}
              required={method !== 'none'}
              disabled={disabled}
              onChange={event => setClientId(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            {t('workbench.mcp_client_method')}
            <select
              className={input}
              value={method}
              disabled={disabled}
              onChange={event => {
                setMethod(event.target.value)
                setSecret('')
              }}
            >
              <option value="none">{t('workbench.mcp_client_public')}</option>
              <option value="client_secret_basic">client_secret_basic</option>
              <option value="client_secret_post">client_secret_post</option>
            </select>
          </label>
          {method !== 'none' && (
            <label>
              {t('workbench.mcp_client_secret')}
              <input
                className={input}
                type="password"
                value={secret}
                required
                disabled={disabled}
                onChange={event => setSecret(event.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}
          <label>
            {t('workbench.mcp_client_scopes')}
            <input
              className={input}
              value={scope}
              disabled={disabled}
              onChange={event => setScope(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={disabled}
            className="min-h-11 rounded-lg bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
          >
            {t('workbench.mcp_authorize')}
          </button>
        </form>
      )}
    </details>
  )
}
