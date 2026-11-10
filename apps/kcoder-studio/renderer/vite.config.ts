import path from 'path'
import fs from 'fs'
import { createLogger, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import { configDefaults } from 'vitest/config'
import { mountedLazyImports } from './plugins/mounted-lazy-imports'

function normalizeBackendUrl(value: string): string {
  const url = new URL(value)
  const segments = url.pathname.split('/').filter(Boolean)
  const apiIndex = segments.indexOf('api')
  const backendSegments = apiIndex >= 0 ? segments.slice(0, apiIndex) : segments
  url.pathname = backendSegments.length > 0 ? `/${backendSegments.join('/')}` : '/'
  return url.toString().replace(/\/$/, '')
}

const configuredBackendUrl = process.env.VITE_WEGENT_BACKEND_URL?.trim()
const backendProxyTarget = configuredBackendUrl ? normalizeBackendUrl(configuredBackendUrl) : undefined
const socketProxyTarget = process.env.VITE_WEGENT_SOCKET_URL?.trim() || backendProxyTarget
const configuredAppBasePath = process.env.VITE_APP_BASE_PATH || '/'
const appBasePath = configuredAppBasePath.endsWith('/')
  ? configuredAppBasePath
  : `${configuredAppBasePath}/`
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')
) as {
  version?: string
}
const internalExtensionsDir = path.resolve(__dirname, './wecode/extensions')
const extensionsDir = fs.existsSync(path.join(internalExtensionsDir, 'apps.tsx'))
  ? internalExtensionsDir
  : path.resolve(__dirname, './src/extensions')
const logger = createLogger()
const defaultWarn = logger.warn.bind(logger)
const browserExternalPackages = ['/avsc/', '/ag-psd/', '/jszip/', '/@ljheee/xmind-parser/']

logger.warn = (message, options) => {
  const isKnownBrowserExternal =
    message.includes('has been externalized for browser compatibility') &&
    browserExternalPackages.some(packagePath => message.includes(packagePath))
  if (!isKnownBrowserExternal) defaultWarn(message, options)
}

export default defineConfig(({ mode }) => ({
  base: appBasePath,
  customLogger: logger,
  experimental: {
    bundledDev: mode !== 'test' && process.env.KCODER_STUDIO_VITE_BUNDLED_DEV === '1',
  },
  plugins: [
    {
      name: 'kcoder-boot-loading-style',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          if (!html.includes('id="kcoder-boot-loading"')) return
          // Bundled dev puts stylesheet links in the app entry. The boot screen
          // must be styled before that entry finishes loading.
          const css = fs.readFileSync(path.resolve(__dirname, 'src/styles/page-loading.css'), 'utf-8')
          return [{ tag: 'style', attrs: { id: 'kcoder-boot-loading-style' }, children: css, injectTo: 'head' }]
        },
      },
    },
    mountedLazyImports(),
    react(),
    fileViewerRenderers({
      preset: 'auto',
      autoPresets: ['office', 'lite', 'engineering'],
      // The workspace viewer passes these presets to its own instance registry
      // and loads on demand. Global HTML injection would load every renderer
      // (PDF, 3D, CAD, OFD...) at startup.
      inject: false,
      // Unit tests must not rewrite assets watched by a shared development server.
      copyAssets: mode !== 'test',
      // Renderer manualChunks placed Vite's preload helper inside the three.js
      // chunk, forcing the 3D viewer into startup. Dynamic imports already
      // split each renderer into its own chunk.
      chunkStrategy: 'none',
    }),
  ],
  define: {
    __KCODER_STUDIO_APP_VERSION__: JSON.stringify(packageJson.version ?? '0.0.0'),
  },
  build: {
    // File-viewer renderers are split into dedicated chunks; the desktop shell
    // intentionally remains a single entry bundle.
    chunkSizeWarningLimit: 5_000,
  },
  server: {
    host: '0.0.0.0',
    // Middleware mode broadcasts HTML reloads; test fixtures are separate entrypoints.
    watch: { ignored: ['**/e2e/**', '**/test-results/**', '**/coverage/**'] },
    fs: {
      // Expose only the public channel descriptor, never the SDK/credential implementation.
      allow: [__dirname, path.resolve(__dirname, '../shared'),
        path.resolve(__dirname, '../../kcoder-channel-host/src/channel-platforms.json')],
    },
    proxy: {
      ...(backendProxyTarget && {
        '/api': { target: backendProxyTarget, changeOrigin: true, ws: true },
      }),
      ...(socketProxyTarget && {
        '/socket.io': { target: socketProxyTarget, changeOrigin: true, ws: true },
      }),
    },
  },
  resolve: {
    alias: {
      '@xmldom/xmldom': path.resolve(__dirname, './src/lib/browser-dom-parser.ts'),
      '@': path.resolve(__dirname, './src'),
      '@wecode': path.resolve(__dirname, './wecode'),
      '@extensions': extensionsDir,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    // Keep local and pre-push runs below the resource-contention point where
    // jsdom-heavy files begin timing out nondeterministically.
    maxWorkers: 4,
    exclude: [...configDefaults.exclude, 'e2e/**', 'test-results/**'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
}))
