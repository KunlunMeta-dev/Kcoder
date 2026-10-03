import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  listenLocalTerminalExit,
  listenLocalTerminalOutput,
  resizeLocalTerminal,
  writeLocalTerminal,
} from '@/lib/local-terminal'
import {
  applyTerminalTheme,
  createTerminalThemeScheduler,
  getTerminalTheme,
  observeTerminalTheme,
} from '@/lib/xterm-theme'
import { appendRuntimeTerminalContext } from '@/lib/runtime-terminal-context'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { installXtermInputFallback, type XtermInputFallbackController } from './xtermInputFallback'
import { createXtermWebLinksAddon } from './xtermLinks'
import { installXtermSelectionGuard } from './xtermSelectionGuard'

interface EmbeddedLocalTerminalProps {
  sessionId: string
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

const ACTIVATION_FIT_DELAY_MS = 300

export function EmbeddedLocalTerminal({
  sessionId,
  active,
  taskId,
  workspacePath,
  cwd,
  title,
  onExit,
  onTitleChange,
  testIdsEnabled = true,
  showWorkbenchBackground = false,
}: EmbeddedLocalTerminalProps) {
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  const activationFitNotBeforeRef = useRef(Infinity)
  const contextRef = useRef({ taskId, workspacePath, cwd, title })
  const onExitRef = useRef(onExit)
  const onTitleChangeRef = useRef(onTitleChange)
  const lastSizeRef = useRef<{ rows: number; cols: number } | null>(null)
  const appearanceRef = useRef(appearance)
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
        console.error('Failed to resize local terminal after typography change:', error)
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
    let inputFallback: XtermInputFallbackController = {
      noteData: () => undefined,
      dispose: () => undefined,
    }
    const dataDisposable = terminal.onData(data => {
      inputFallback.noteData(data)
      void writeLocalTerminal(sessionId, data)
    })
    const titleDisposable = terminal.onTitleChange(title => {
      onTitleChangeRef.current?.(title)
    })
    let disposed = false
    const unlisteners: Array<() => void> = []

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(container)
    const selectionGuard = installXtermSelectionGuard({ container, terminal })
    inputFallback = installXtermInputFallback({
      terminal,
      writeData: data => {
        inputFallback.noteData(data)
        void writeLocalTerminal(sessionId, data)
      },
    })
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
    const scheduleThemeSync = createTerminalThemeScheduler(
      terminal,
      container,
      showWorkbenchBackground
    )
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
        syncTerminalSize()
      } catch (error) {
        console.error('Failed to resize local terminal:', error)
      }
    }

    const syncTerminalSize = () => {
      if (!activeRef.current || terminal.rows <= 0 || terminal.cols <= 0) return

      const lastSize = lastSizeRef.current
      if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

      lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
      void resizeLocalTerminal(sessionId, terminal.rows, terminal.cols)
    }

    const resizeObserver = new ResizeObserver(fitAndResize)
    resizeObserver.observe(container)
    requestAnimationFrame(fitAndResize)

    void listenLocalTerminalOutput(payload => {
      if (!disposed && payload.session_id === sessionId) {
        const context = contextRef.current
        appendRuntimeTerminalContext({
          sessionId,
          taskId: context.taskId,
          workspacePath: context.workspacePath,
          cwd: context.cwd,
          title: context.title,
          kind: 'local',
          data: payload.data,
        })
        terminal.write(payload.data)
        scheduleThemeSync()
      }
    }).then(unlisten => {
      if (disposed) {
        unlisten()
      } else {
        unlisteners.push(unlisten)
      }
    })

    void listenLocalTerminalExit(payload => {
      if (!disposed && payload.session_id === sessionId) {
        onExitRef.current?.()
      }
    }).then(unlisten => {
      if (disposed) {
        unlisten()
      } else {
        unlisteners.push(unlisten)
      }
    })

    return () => {
      disposed = true
      unobserveTheme()
      resizeObserver.disconnect()
      dataDisposable.dispose()
      titleDisposable.dispose()
      selectionGuard.dispose()
      inputFallback.dispose()
      unlisteners.forEach(unlisten => unlisten())
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId, showWorkbenchBackground])

  useEffect(() => {
    if (!active) return

    let frame: number | null = null
    const delay = Math.max(0, activationFitNotBeforeRef.current - Date.now())
    const timer = window.setTimeout(() => {
      frame = requestAnimationFrame(() => {
        const terminal = terminalRef.current
        const fitAddon = fitAddonRef.current
        const container = containerRef.current
        if (!terminal || !fitAddon || !container) return
        const bounds = wrapperRef.current?.getBoundingClientRect()
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          lastVisibleSizeRef.current = { width: bounds.width, height: bounds.height }
        }

        try {
          applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
          fitAddon.fit()
          terminal.focus()
          if (terminal.rows > 0 && terminal.cols > 0) {
            const lastSize = lastSizeRef.current
            if (lastSize?.rows !== terminal.rows || lastSize.cols !== terminal.cols) {
              lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
              void resizeLocalTerminal(sessionId, terminal.rows, terminal.cols)
            }
          }
        } catch (error) {
          console.error('Failed to activate local terminal:', error)
        }
        const wrapper = wrapperRef.current
        if (wrapper && activeRef.current) {
          wrapper.style.removeProperty('width')
          wrapper.style.removeProperty('height')
        }
      })
    }, delay)

    return () => {
      window.clearTimeout(timer)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [active, sessionId, showWorkbenchBackground])

  return (
    <div
      ref={wrapperRef}
      data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
      aria-hidden={!active}
      className={`absolute inset-0 overflow-hidden px-2 pb-4 pt-2 ${
        active ? 'visible pointer-events-auto' : 'invisible pointer-events-none'
      } ${showWorkbenchBackground ? 'bg-transparent' : 'bg-background'}`}
    >
      <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  )
}
