import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type {
  RemoteTerminalClient,
  RemoteTerminalClientFactory,
} from '@/lib/remote-terminal-socket'
import {
  applyTerminalTheme,
  createTerminalThemeScheduler,
  getTerminalTheme,
  observeTerminalTheme,
} from '@/lib/xterm-theme'
import { appendRuntimeTerminalContext } from '@/lib/runtime-terminal-context'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { createXtermWebLinksAddon } from './xtermLinks'
import { installXtermInputFallback, type XtermInputFallbackController } from './xtermInputFallback'
import { installXtermSelectionGuard } from './xtermSelectionGuard'

interface RemoteTerminalProps {
  sessionId: string
  clientFactory: RemoteTerminalClientFactory
  active: boolean
  taskId?: string | null
  workspacePath?: string | null
  cwd?: string | null
  title?: string | null
  onExit?: () => void
  onTitleChange?: (title: string) => void
  testIdsEnabled?: boolean
  showWorkbenchBackground?: boolean
}

interface RemoteTerminalResource {
  sessionId: string
  clientFactory: RemoteTerminalClientFactory
  showWorkbenchBackground: boolean
  dispose: () => void
}

const ACTIVATION_FIT_DELAY_MS = 300

function isExpectedTerminalDisconnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /连接已断开|尚未连接|disconnected|connection (?:is )?closed/i.test(message)
}

function matchesRemoteTerminalResource(
  resource: RemoteTerminalResource,
  sessionId: string,
  clientFactory: RemoteTerminalClientFactory,
  showWorkbenchBackground: boolean
): boolean {
  return (
    resource.sessionId === sessionId &&
    resource.clientFactory === clientFactory &&
    resource.showWorkbenchBackground === showWorkbenchBackground
  )
}

export function RemoteTerminal({
  sessionId,
  clientFactory,
  active,
  taskId,
  workspacePath,
  cwd,
  title,
  onExit,
  onTitleChange,
  testIdsEnabled = true,
  showWorkbenchBackground = false,
}: RemoteTerminalProps) {
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const clientRef = useRef<RemoteTerminalClient | null>(null)
  const activeRef = useRef(active)
  const activationFitNotBeforeRef = useRef(Infinity)
  const contextRef = useRef({ taskId, workspacePath, cwd, title })
  const onExitRef = useRef(onExit)
  const onTitleChangeRef = useRef(onTitleChange)
  const lastSizeRef = useRef<{ rows: number; cols: number } | null>(null)
  const appearanceRef = useRef(appearance)
  const resourceRef = useRef<RemoteTerminalResource | null>(null)
  const cleanupTimerRef = useRef<number | null>(null)
  const lastVisibleSizeRef = useRef<{ width: number; height: number } | null>(null)

  useEffect(() => {
    appearanceRef.current = appearance
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal) return

    terminal.options.fontFamily = appearance.codeFont
    terminal.options.fontSize = appearance.codeFontSize
    requestAnimationFrame(() => {
      if (!activeRef.current || Date.now() < activationFitNotBeforeRef.current) return
      try {
        fitAddon?.fit()
      } catch (error) {
        console.error('Failed to resize remote terminal after typography change:', error)
      }
    })
  }, [appearance])

  useLayoutEffect(() => {
    activeRef.current = active
    activationFitNotBeforeRef.current = active ? Date.now() + ACTIVATION_FIT_DELAY_MS : Infinity
    const wrapper = wrapperRef.current
    const size = lastVisibleSizeRef.current
    if (wrapper && size) {
      wrapper.style.width = `${size.width}px`
      wrapper.style.height = `${size.height}px`
    }
  }, [active])

  useEffect(() => {
    contextRef.current = { taskId, workspacePath, cwd, title }
  }, [cwd, taskId, title, workspacePath])

  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }
    // StrictMode replays effects in development. Keep the live socket and xterm
    // through that replay so initial PTY output cannot land on a discarded client.
    const currentResource = resourceRef.current
    if (
      currentResource &&
      matchesRemoteTerminalResource(
        currentResource,
        sessionId,
        clientFactory,
        showWorkbenchBackground
      )
    ) {
      return () => {
        cleanupTimerRef.current = window.setTimeout(currentResource.dispose, 0)
      }
    }
    currentResource?.dispose()

    const terminalAppearance = appearanceRef.current
    const terminal = new Terminal({
      allowTransparency: showWorkbenchBackground,
      cursorBlink: true,
      convertEol: true,
      fontFamily: terminalAppearance.codeFont,
      fontSize: terminalAppearance.codeFontSize,
      lineHeight: 1.2,
      scrollback: 2000,
      theme: getTerminalTheme(showWorkbenchBackground),
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = createXtermWebLinksAddon()
    const client = clientFactory(sessionId)
    let disposed = false
    let scheduleThemeSync: () => void = () => undefined

    const writeTerminalOutput = (data: string) => {
      if (disposed || !data) return
      const context = contextRef.current
      appendRuntimeTerminalContext({
        sessionId,
        taskId: context.taskId,
        workspacePath: context.workspacePath,
        cwd: context.cwd,
        title: context.title,
        kind: 'remote',
        data,
      })
      terminal.write(data)
      scheduleThemeSync()
    }

    let inputFallback: XtermInputFallbackController = {
      noteData: () => undefined,
      dispose: () => undefined,
    }
    const dataDisposable = terminal.onData(data => {
      inputFallback.noteData(data)
      void client.write(data).catch(error => {
        if (!disposed) {
          console.error('Failed to write to remote terminal:', error)
        }
      })
    })
    const unsubscribeOutput = client.onOutput(payload => {
      if (!disposed && payload.session_id === sessionId) {
        writeTerminalOutput(payload.data)
      }
    })
    const titleDisposable = terminal.onTitleChange(title => {
      onTitleChangeRef.current?.(title)
    })
    const unsubscribeExit = client.onExit(payload => {
      if (!disposed && payload.session_id === sessionId) {
        onExitRef.current?.()
      }
    })

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(container)
    const selectionGuard = installXtermSelectionGuard({ container, terminal })
    inputFallback = installXtermInputFallback({
      terminal,
      writeData: data => {
        inputFallback.noteData(data)
        void client.write(data).catch(error => {
          if (!disposed) {
            console.error('Failed to write fallback input to remote terminal:', error)
          }
        })
      },
    })
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    clientRef.current = client
    applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
    scheduleThemeSync = createTerminalThemeScheduler(terminal, container, showWorkbenchBackground)
    const unobserveTheme = observeTerminalTheme(theme => {
      applyTerminalTheme(terminal, container, theme, showWorkbenchBackground)
    })

    const fitAndResize = () => {
      if (
        disposed ||
        !container.isConnected ||
        !activeRef.current ||
        Date.now() < activationFitNotBeforeRef.current
      ) {
        return
      }
      const bounds = wrapperRef.current?.getBoundingClientRect()
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        lastVisibleSizeRef.current = { width: bounds.width, height: bounds.height }
      }
      try {
        fitAddon.fit()
      } catch (error) {
        console.error('Failed to resize remote terminal:', error)
        return
      }
      syncTerminalSize(error => {
        if (!disposed) {
          console.error('Failed to resize remote terminal:', error)
        }
      })
    }

    const syncTerminalSize = (onError: (error: unknown) => void) => {
      if (!activeRef.current || terminal.rows <= 0 || terminal.cols <= 0) return

      const lastSize = lastSizeRef.current
      if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

      lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
      void client.resize(terminal.rows, terminal.cols).catch(onError)
    }

    const resizeObserver = new ResizeObserver(fitAndResize)
    resizeObserver.observe(container)

    void client
      .attach()
      .then(() => {
        requestAnimationFrame(fitAndResize)
      })
      .catch(error => {
        if (!disposed) {
          console.error('Failed to attach remote terminal:', error)
          terminal.writeln('\r\n[Terminal connection failed]')
        }
      })

    const resource: RemoteTerminalResource = {
      sessionId,
      clientFactory,
      showWorkbenchBackground,
      dispose: () => {
        if (disposed) return
        disposed = true
        unobserveTheme()
        resizeObserver.disconnect()
        dataDisposable.dispose()
        titleDisposable.dispose()
        selectionGuard.dispose()
        inputFallback.dispose()
        unsubscribeOutput()
        unsubscribeExit()
        // Component unmount may mean refresh, task switch, or panel collapse. Detach
        // frontend resources only; explicit terminal close owns remote PTY termination so it can be reattached later.
        client.dispose()
        terminal.dispose()
        if (resourceRef.current === resource) {
          terminalRef.current = null
          fitAddonRef.current = null
          clientRef.current = null
          resourceRef.current = null
        }
      },
    }
    resourceRef.current = resource

    return () => {
      cleanupTimerRef.current = window.setTimeout(resource.dispose, 0)
    }
  }, [clientFactory, sessionId, showWorkbenchBackground])

  useEffect(() => {
    if (!active) return

    let frame: number | null = null
    const delay = Math.max(0, activationFitNotBeforeRef.current - Date.now())
    const timer = window.setTimeout(() => {
      frame = requestAnimationFrame(() => {
        const terminal = terminalRef.current
        const fitAddon = fitAddonRef.current
        const client = clientRef.current
        const container = containerRef.current
        if (!terminal || !fitAddon || !client || !container) return
        const bounds = wrapperRef.current?.getBoundingClientRect()
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          lastVisibleSizeRef.current = { width: bounds.width, height: bounds.height }
        }

        try {
          applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
          fitAddon.fit()
          terminal.focus()
        } catch (error) {
          console.error('Failed to activate remote terminal:', error)
          return
        }
        const wrapper = wrapperRef.current
        if (wrapper && activeRef.current) {
          wrapper.style.removeProperty('width')
          wrapper.style.removeProperty('height')
        }
        if (terminal.rows <= 0 || terminal.cols <= 0) return

        const lastSize = lastSizeRef.current
        if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

        lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
        void client.resize(terminal.rows, terminal.cols).catch(error => {
          // Refresh or target switching releases the old connection deliberately. A late
          // resize rejection is normal lifecycle behavior, not a terminal failure to report to users or diagnostics.
          if (clientRef.current === client && !isExpectedTerminalDisconnect(error)) {
            console.error('Failed to sync remote terminal size on activate:', error)
          }
        })
      })
    }, delay)

    return () => {
      window.clearTimeout(timer)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [active, showWorkbenchBackground])

  return (
    <div
      ref={wrapperRef}
      data-testid={testIdsEnabled ? 'remote-terminal' : undefined}
      aria-hidden={!active}
      className={`absolute inset-0 overflow-hidden px-2 pb-4 pt-2 ${
        active ? 'visible pointer-events-auto' : 'invisible pointer-events-none'
      } ${showWorkbenchBackground ? 'bg-transparent' : 'bg-background'}`}
    >
      <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  )
}
