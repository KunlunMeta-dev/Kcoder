import type { i18n, Resource } from 'i18next'

/** Replace owned locale bundles without reinitializing language or application state. */
export function replaceLocaleResources(instance: i18n, previous: Resource, next: Resource) {
  const owned = Object.entries(previous).flatMap(([language, namespaces]) =>
    Object.keys(namespaces).map(namespace => [language, namespace] as const)
  )
  for (const [language, namespace] of owned) instance.removeResourceBundle(language, namespace)
  const loaded: Record<string, Record<string, boolean>> = {}
  for (const [language, namespaces] of Object.entries(next)) {
    loaded[language] = {}
    for (const [namespace, bundle] of Object.entries(namespaces)) {
      instance.addResourceBundle(language, namespace, bundle)
      loaded[language][namespace] = true
    }
  }
  // React subscribers refresh translations after the complete replacement.
  instance.emit('loaded', loaded)
}
