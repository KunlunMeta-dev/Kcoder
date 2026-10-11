import { createContext } from 'react'

export const WorkspaceMarkdownImageLoaderContext = createContext<
  ((path: string) => Promise<Blob>) | null
>(null)
