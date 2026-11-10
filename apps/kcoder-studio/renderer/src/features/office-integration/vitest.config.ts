import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } }, test: { root: fileURLToPath(new URL('.', import.meta.url)), environment: 'jsdom', include: ['*.test.ts', '*.test.tsx'], maxWorkers: 1 } })
