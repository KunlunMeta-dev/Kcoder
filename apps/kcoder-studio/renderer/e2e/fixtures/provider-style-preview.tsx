import { createRoot } from 'react-dom/client'
import { KCoderProviderSettingsPage } from '../../src/components/settings/KCoderProviderSettingsPage'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import '../../src/styles/disclosures.css'

// Rendering-only fixture: no saved credentials, model calls, configuration writes or imports.
await i18n.changeLanguage('zh-CN')
registerGatewayCommandTransport((command, args) => {
  if (command !== 'local_executor_request') throw new Error('Preview permits no native commands')
  const request = args as { params: { method: string } }
  if (request.params.method === 'runtime.providers.list')
    return {
      profiles: [
        {
          id: 'demo',
          apiFormat: 'openai_chat_completions',
          endpoint: 'https://example.invalid/v1',
          model: 'MiniMax-M3',
          contextWindowTokens: 1000000,
          maxOutputTokens: 8192,
          apiKeyConfigured: false,
          isDefault: true,
          isProviderDefault: true,
          canDelete: true,
        },
      ],
      restartRequired: false,
      supportsMultipleModels: true,
      supportsIndependentProbe: true,
      supportsOptimisticConcurrency: true,
      revision: 'a'.repeat(64),
    }
  if (request.params.method === 'runtime.providers.templates') return { templates: [] }
  if (request.params.method === 'settings/templates/list') return { templates: [], defaultId: null }
  throw new Error('Rendering preview: operation unavailable')
})
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-background text-text-primary">
    <div className="border-b border-border bg-surface px-6 py-3 text-sm text-text-secondary">
      Studio 模型设置预览 · 示例数据，不保存配置或调用模型
    </div>
    <div className="p-6">
      <KCoderProviderSettingsPage />
    </div>
  </main>
)
