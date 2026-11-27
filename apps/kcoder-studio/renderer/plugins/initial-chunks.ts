interface ChunkingContext {
  getModuleInfo(id: string): { importedIds: readonly string[] } | null
}

/** Keep the lightweight boot graph independent from the already eager workbench. */
export function createInitialChunkName(startupId: string) {
  return (id: string, context: ChunkingContext): string | null => {
    const startup = new Set([startupId])
    for (const dependency of startup) {
      if (dependency === id) return null
      const info = context.getModuleInfo(dependency)
      if (!info) throw new Error(`Missing startup module while grouping initial chunks: ${dependency}`)
      for (const imported of info.importedIds) startup.add(imported)
    }
    return 'workbench-initial'
  }
}
