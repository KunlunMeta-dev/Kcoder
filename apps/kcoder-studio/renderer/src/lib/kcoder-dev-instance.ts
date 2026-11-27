export interface KCoderDevInstanceInfo {
  title: string
  port?: string
  worktree?: string
  branch?: string
  parentTitle?: string
  parentProject?: string
  parentWorkspace?: string
}

export interface KCoderDevInstanceRow {
  key: string
  label: string
  value: string
}

function envValue(key: keyof ImportMetaEnv): string | undefined {
  return import.meta.env[key]?.trim() || undefined
}

export function getKCoderDevTitle(): string | null {
  return getKCoderDevInstanceInfo()?.title ?? null
}

export function getKCoderDevInstanceInfo(): KCoderDevInstanceInfo | null {
  const title = envValue('VITE_KCODER_STUDIO_DEV_TITLE')
  if (!title) return null

  return {
    title,
    port: envValue('VITE_KCODER_STUDIO_DEV_PORT'),
    worktree: envValue('VITE_KCODER_STUDIO_DEV_WORKTREE'),
    branch: envValue('VITE_KCODER_STUDIO_DEV_BRANCH'),
    parentTitle: envValue('VITE_KCODER_STUDIO_PARENT_TITLE'),
    parentProject: envValue('VITE_KCODER_STUDIO_PARENT_PROJECT'),
    parentWorkspace: envValue('VITE_KCODER_STUDIO_PARENT_WORKSPACE'),
  }
}

export function getKCoderDocumentTitle(): string {
  const devTitle = getKCoderDevTitle()
  return devTitle ? `KCoder Studio - ${devTitle}` : 'KCoder Studio'
}

export function getKCoderDevInstanceRows(info: KCoderDevInstanceInfo): KCoderDevInstanceRow[] {
  return [
    { key: 'title', label: 'Title', value: info.title },
    info.port ? { key: 'port', label: 'Port', value: info.port } : null,
    info.branch ? { key: 'branch', label: 'Branch', value: info.branch } : null,
    info.worktree ? { key: 'worktree', label: 'Worktree', value: info.worktree } : null,
    info.parentTitle
      ? { key: 'parent-title', label: 'Parent task', value: info.parentTitle }
      : null,
    info.parentProject
      ? { key: 'parent-project', label: 'Parent project', value: info.parentProject }
      : null,
    info.parentWorkspace
      ? { key: 'parent-workspace', label: 'Parent workspace', value: info.parentWorkspace }
      : null,
  ].filter((row): row is KCoderDevInstanceRow => Boolean(row))
}
