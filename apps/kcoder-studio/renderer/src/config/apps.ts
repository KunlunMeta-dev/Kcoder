export interface AppTab {
  key: string
  label: string
  mode: 'native' | 'iframe'
  path?: string
  url?: string
  requiresAuth?: boolean
  hidden?: boolean
}

export const APP_TABS: AppTab[] = [
  { key: 'studio', label: 'KCoder Studio', mode: 'native', path: '/', requiresAuth: true },
  {
    key: 'apps',
    label: '应用',
    mode: 'native',
    path: '/apps',
    requiresAuth: true,
    hidden: true,
  },
  {
    key: 'wegent',
    label: '智能体',
    mode: 'iframe',
    requiresAuth: true,
    hidden: true,
  },
]

export const DEFAULT_APP_KEY = 'studio'
