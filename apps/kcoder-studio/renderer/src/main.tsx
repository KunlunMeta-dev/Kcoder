// KCoder modification: install the browser-to-app-server compatibility boundary before the
// otherwise upstream-identical renderer application graph evaluates.
import './kcoder/installGatewayRuntime'
import './i18n'
import { Profiler, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'prosemirror-view/style/prosemirror.css'
import './styles/globals.css'
import App from './App.tsx'
import { installAppLogging } from './lib/app-logging'
import { installDebugPanelLogCapture } from './lib/debugPanel'
import { installDeveloperCommandMenu } from './lib/developerCommandMenu'
import { installExternalLinkHandler } from './lib/external-links'
import { installPageZoomGuard } from './lib/pageZoomGuard'
import { installPerformanceDiagnostics, recordReactCommit } from './lib/performanceDiagnostics'
import { installStudioAutomationBridge } from './e2e/automation'
import { installDesktopExtensions } from '@extensions/desktop'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { installFrontendRecoveryBridge } from '@/lib/frontendRecovery'

const isSystemDragPanel = isTauriRuntime() && window.location.pathname === '/system-drag'
if (!isSystemDragPanel) {
  installDebugPanelLogCapture()
  installAppLogging()
  installFrontendRecoveryBridge()
  installStudioAutomationBridge()
  installDesktopExtensions()
  installExternalLinkHandler()
  installPageZoomGuard()
  installDeveloperCommandMenu()
}
const performanceDiagnostics = isSystemDragPanel ? null : installPerformanceDiagnostics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {performanceDiagnostics ? (
      <Profiler id="studio-root" onRender={recordReactCommit}>
        <App />
      </Profiler>
    ) : (
      <App />
    )}
  </StrictMode>
)
