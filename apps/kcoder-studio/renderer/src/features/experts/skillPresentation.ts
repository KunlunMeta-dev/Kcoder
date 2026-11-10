import type {
  OfficeAssistantSkill,
  OfficeExpertPackage,
} from '../../../../shared/generated/contracts'
import { splitMarkdownFrontmatter } from '@/features/octop/workflowMarkdown'

export function packageSkills(bundle: OfficeExpertPackage | null) {
  if (!bundle) return []
  return bundle.files.flatMap(file => {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)
    return match && bundle.skillSlugs.includes(match[1])
      ? [{ slug: match[1], path: file.path }]
      : []
  })
}

export function skillSnapshot(slug: string, content: string): OfficeAssistantSkill {
  const { raw } = splitMarkdownFrontmatter(content)
  const field = (name: string) => {
    const value = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(raw ?? '')?.[1]?.trim() ?? ''
    return value.replace(/^(['"])(.*)\1$/, '$2')
  }
  return {
    slug,
    title: field('name') || slug,
    description: field('description').slice(0, 4000),
    // Retain declarations for Native to interpret; the browser grants no tools.
    content: content.trim(),
    enabled: false,
  }
}
