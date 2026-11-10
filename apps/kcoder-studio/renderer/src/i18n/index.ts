import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { resources, extensionNamespaces } from './resources'
import { replaceLocaleResources } from './hotResources'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Keep static bundle ownership separate from runtime extension resources.
    resources: structuredClone(resources),
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    defaultNS: 'common',
    ns: [
      'experts',
      'taskMembers',
      'taskCollaboration',
      'migration',
      'migrationPrivate',
      'migrationResources',
      'migrationPlugins',
      'migrationMemory',
      'migrationDefinitions',
      'migrationProjects',
      'migrationAgents',
      'migrationInstructions',
      'migrationUpload',
      'knowledge',
      'knowledgeIntegration',
      'officeIntegration',
      'modelPolicies',
      'remoteCapabilities',
      'taskWorkspace',
      'common',
      'chat',
      'localRuntime',
      'sites',
      'hooks',
      'sshTerminal',
      'taskComparison',
      'taskDelivery',
      'taskCapabilityScope',
      'connectivity',
      ...extensionNamespaces,
    ],
    interpolation: { escapeValue: false },
    react: { bindI18n: 'languageChanged loaded' },
  })

if (import.meta.hot) {
  let previousResources = resources
  import.meta.hot.accept('./resources', updated => {
    if (!updated) return
    replaceLocaleResources(i18n, previousResources, updated.resources)
    previousResources = updated.resources
  })
}

export default i18n
