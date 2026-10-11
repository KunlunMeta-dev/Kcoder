import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useEffect, useRef } from 'react'
import {
  languageForPath,
  workspaceFileLineSeparator,
  WORKSPACE_EDITOR_HIGHLIGHT_STYLE,
  WORKSPACE_EDITOR_THEME,
} from './workspaceTextFileEditorConfig'

interface WorkspaceTextFileEditorProps {
  path: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
}

export function WorkspaceTextFileEditor({
  path,
  value,
  onChange,
  onSave,
}: WorkspaceTextFileEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const initialValueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)

  useEffect(() => {
    onChangeRef.current = onChange
    onSaveRef.current = onSave
  }, [onChange, onSave])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const saveKeymap = {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSaveRef.current()
        return true
      },
    }
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          EditorState.lineSeparator.of(workspaceFileLineSeparator(initialValueRef.current)),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          bracketMatching(),
          syntaxHighlighting(WORKSPACE_EDITOR_HIGHLIGHT_STYLE),
          languageForPath(path),
          keymap.of([
            saveKeymap,
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.sliceDoc())
          }),
          EditorView.theme(WORKSPACE_EDITOR_THEME),
        ],
      }),
    })
    view.focus()
    return () => view.destroy()
  }, [path])

  return <div ref={hostRef} data-testid="workspace-file-editor" className="min-h-0 flex-1" />
}
