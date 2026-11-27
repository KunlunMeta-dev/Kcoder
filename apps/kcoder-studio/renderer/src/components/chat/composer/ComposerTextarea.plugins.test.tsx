import { localSkillTestId } from './composerMentions'
import '@/i18n'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { expect, test, vi } from 'vitest'
import type { InstalledPlugin, LocalDeviceApp, LocalDeviceSkill } from '@/types/api'
import { RetainedPage } from '@/components/layout/retainedPages'
import { ComposerTextarea } from './ComposerTextarea'
import { useComposerDirectory } from './useComposerDirectory'
import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'
import { notifyToolsCatalogChanged } from '@/kcoder/toolsCatalogEvents'
import type { WorkspaceTarget } from '@/types/workspace-files'

const skill: LocalDeviceSkill = {
  name: 'factory-build',
  description: 'Build with Factory',
  source: 'kcoder',
  path: String.raw`C:\Users\test\plugins\factory\skills\build\SKILL.md`,
}
const factory: InstalledPlugin = {
  apiVersion: 'agent.wecode.io/v1',
  kind: 'InstalledPlugin',
  metadata: { namespace: 'local' },
  spec: {
    source: { type: 'local', providerKey: 'local', pluginKey: 'factory' },
    displayName: 'Factory',
    description: 'Factory tools',
    enabled: true,
    installState: 'installed',
    manifest: {},
    components: {
      skills: [{ name: skill.name, path: skill.path }],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
  },
  status: { state: 'enabled' },
}
const pluginTestId = localSkillTestId('[$Factory](plugin://factory@local)')
const pluginOption = `local-plugin-option-${pluginTestId}`
const pluginSkillsOption = `mention-plugin-skills-${pluginTestId}`
const plugins = vi.fn(async () => [factory])
const skills = async () => [skill]
const submit = vi.fn()

function Harness({
  source = plugins,
  skillSource = skills,
  appSource,
  target,
  initial = '',
  onGoal,
}: {
  source?: () => Promise<InstalledPlugin[]>
  skillSource?: () => Promise<LocalDeviceSkill[]>
  appSource?: () => Promise<LocalDeviceApp[]>
  target?: WorkspaceTarget
  initial?: string
  onGoal?: () => void
}) {
  const [value, setValue] = useState(initial)
  const textareaRef = useRef<HTMLElement>(null)
  return (
    <ComposerTextarea
      value={value}
      onChange={setValue}
      onSubmit={submit}
      canSend
      placeholder="Message"
      rows={1}
      textareaRef={textareaRef}
      className="min-h-12"
      onListLocalSkills={skillSource}
      onListLocalApps={appSource}
      onListLocalPlugins={source}
      workspaceTarget={target}
      onSetGoal={onGoal}
    />
  )
}
function open(value = '请用 $') {
  const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
  act(() => {
    editor.value = value
    editor.focus()
  })
  return editor
}

test('selects an installed plugin in the existing draft without sending or navigating', async () => {
  submit.mockClear()
  const original = window.location.href
  render(<Harness />)
  const editor = open()
  const row = await screen.findByTestId(pluginOption)
  fireEvent.click(row)
  await waitFor(() => expect(editor.value).toBe('请用 [$Factory](plugin://factory@local) '))
  expect(screen.getByTestId('local-skill-chip-Factory')).toHaveTextContent('Factory')
  expect(submit).not.toHaveBeenCalled()
  expect(window.location.href).toBe(original)
})

test('keeps plugin skills collapsed until opened and renders Windows skill chips', async () => {
  render(<Harness />)
  const editor = open('$')
  const group = await screen.findByTestId(pluginSkillsOption)
  expect(group).toHaveTextContent(/Factory 的技能|Factory skills/)
  expect(screen.queryByTestId('local-skill-option-factory-build')).not.toBeInTheDocument()
  fireEvent.click(group)
  fireEvent.click(await screen.findByTestId('local-skill-option-factory-build'))
  await waitFor(() => expect(editor.value).toBe(`[$factory-build](${skill.path}) `))
  expect(screen.getByTestId('local-skill-chip-factory-build')).toBeInTheDocument()
  expect(editor.textContent).not.toContain('C:\\Users')
})

test('supports keyboard selection without submitting the message', async () => {
  submit.mockClear()
  render(<Harness />)
  const editor = open('$Factory')
  await screen.findByTestId(pluginOption)
  fireEvent.keyDown(editor, { key: 'Tab' })
  await waitFor(() => expect(editor.value).toBe('[$Factory](plugin://factory@local) '))
  expect(submit).not.toHaveBeenCalled()
})

test.each(['@', '$'])('Shift+Enter inserts a newline with the %s menu open', async trigger => {
  submit.mockClear()
  render(<Harness />)
  const editor = open(`${trigger}Factory`)
  await screen.findByTestId(pluginOption)
  fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', shiftKey: true })
  await waitFor(() => expect(editor.value).toBe(`${trigger}Factory\n`))
  expect(screen.queryByTestId('local-skill-chip-Factory')).not.toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
})

test('entering plugin skills clears the plugin query and supports a new skill query', async () => {
  const compile = { ...skill, name: 'compile', description: 'Compile a project' }
  const skillSource = async () => [compile]
  render(<Harness skillSource={skillSource} />)
  const editor = open('$Factory')
  fireEvent.click(await screen.findByTestId(pluginSkillsOption))
  await waitFor(() => expect(editor.value).toBe('$'))
  expect(await screen.findByTestId('local-skill-option-compile')).toBeVisible()
  act(() => { editor.value = '$com' })
  expect(await screen.findByTestId('local-skill-option-compile')).toBeVisible()
  fireEvent.click(screen.getByTestId('mention-plugin-back-action'))
  await waitFor(() => expect(editor.value).toBe('$'))
  expect(await screen.findByTestId(pluginOption)).toBeVisible()
})

test('reopening the menu reuses the loaded plugin inventory until it changes', async () => {
  const source = vi.fn(async () => [factory])
  render(<Harness source={source} />)
  const editor = open('$')
  await screen.findByTestId(pluginOption)
  fireEvent.keyDown(editor, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByTestId('local-skill-autocomplete')).toBeNull())
  act(() => { editor.blur() })
  open('$')
  expect(await screen.findByTestId(pluginOption)).toBeEnabled()
  await act(async () => { await Promise.resolve() })
  expect(source).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(editor, { key: 'Escape' })
  act(() => { editor.blur() })
  source.mockResolvedValue([{ ...factory, spec: { ...factory.spec, enabled: false } }])
  act(() => { window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT)) })
  expect(source).toHaveBeenCalledTimes(1)
  open('$')
  await waitFor(() => expect(screen.getByTestId(pluginOption)).toBeDisabled())
  expect(source).toHaveBeenCalledTimes(2)
})

test('an empty inventory is also cached across menu opens', async () => {
  const source = vi.fn(async (): Promise<InstalledPlugin[]> => [])
  const { result, rerender } = renderHook(
    ({ active }) => useComposerDirectory(source, active),
    { initialProps: { active: true } }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  rerender({ active: false })
  rerender({ active: true })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(source).toHaveBeenCalledTimes(1)
})

test('does not select disabled plugins or their skills', async () => {
  const source = async () => [{ ...factory, spec: { ...factory.spec, enabled: false } }]
  render(<Harness source={source} />)
  open('$')
  expect(await screen.findByTestId(pluginOption)).toBeDisabled()
  expect(screen.getByTestId(pluginSkillsOption)).toBeDisabled()
})

test('Tab activates the highlighted command from the bare slash menu', async () => {
  const onGoal = vi.fn()
  render(<Harness onGoal={onGoal} />)
  const editor = open('/')
  await screen.findByTestId('slash-command-option-goal')
  fireEvent.keyDown(editor, { key: 'ArrowDown' })
  fireEvent.keyDown(editor, { key: 'Tab' })
  expect(onGoal).toHaveBeenCalledOnce()
  expect(editor.value).toBe('')
})

test.each(['Tab', 'Enter'])('disabled file actions preserve the draft on %s', async key => {
  const source = async () => []
  render(<Harness source={source} skillSource={source} />)
  const editor = open('@')
  expect(await screen.findByTestId('mention-files-action')).toBeDisabled()
  fireEvent.keyDown(editor, { key })
  expect(editor.value).toBe('@')
})

test.each(['Tab', 'Enter'])('disabled plugin choices never submit the draft on %s', async key => {
  submit.mockClear()
  const source = async () => [{ ...factory, spec: { ...factory.spec, enabled: false } }]
  render(<Harness source={source} />)
  const editor = open('$Factory')
  expect(await screen.findByTestId(pluginOption)).toBeDisabled()
  fireEvent.keyDown(editor, { key: 'ArrowDown' })
  fireEvent.keyDown(editor, { key })
  expect(editor.value).toBe('$Factory')
  expect(submit).not.toHaveBeenCalled()
  expect(screen.queryByTestId('mention-plugin-back-action')).toBeNull()
})

test('arrow navigation skips disabled plugin choices', async () => {
  const disabled = { ...factory, spec: { ...factory.spec, enabled: false } }
  const source = async () => [disabled, { ...factory, spec: { ...factory.spec, displayName: 'Other', source: { ...factory.spec.source, pluginKey: 'other' } } }]
  render(<Harness source={source} />)
  const editor = open('$')
  const other = await screen.findByTestId(`local-plugin-option-${localSkillTestId('[$Other](plugin://other@local)')}`)
  expect(other).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(editor, { key: 'ArrowUp' })
  fireEvent.keyDown(editor, { key: 'Tab' })
  expect(editor.value).toBe('[$Other](plugin://other@local) ')
})

test('plugin changes refresh skills and discard the previous in-flight skill result', async () => {
  let resolveOld!: (value: LocalDeviceSkill[]) => void
  const skillSource = vi.fn<() => Promise<LocalDeviceSkill[]>>()
    .mockImplementationOnce(() => new Promise(done => { resolveOld = done }))
    .mockResolvedValueOnce([{ ...skill, name: 'new-build' }])
  render(<Harness skillSource={skillSource} />)
  open('$new')
  await waitFor(() => expect(skillSource).toHaveBeenCalledOnce())
  act(() => { window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT)) })
  expect(await screen.findByTestId('local-skill-option-new-build')).toBeVisible()
  await act(async () => { resolveOld([skill]) })
  expect(screen.getByTestId('local-skill-option-new-build')).toBeVisible()
  expect(skillSource).toHaveBeenCalledTimes(2)
})

test('a successful skill cache refreshes after a plugin change while the menu is closed', async () => {
  const skillSource = vi.fn(async () => [skill])
  render(<Harness skillSource={skillSource} />)
  const editor = open('$factory-build')
  await screen.findByTestId('local-skill-option-factory-build')
  fireEvent.keyDown(editor, { key: 'Escape' })
  act(() => { editor.blur() })
  skillSource.mockResolvedValue([{ ...skill, name: 'new-build' }])
  act(() => { window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT)) })
  expect(skillSource).toHaveBeenCalledOnce()
  open('$new-build')
  expect(await screen.findByTestId('local-skill-option-new-build')).toBeVisible()
  expect(skillSource).toHaveBeenCalledTimes(2)
})

test('ignores a plugin response owned by the previous target', async () => {
  let resolve!: (value: InstalledPlugin[]) => void
  const old = () =>
    new Promise<InstalledPlugin[]>(done => {
      resolve = done
    })
  const replacement = async () => []
  const view = render(<Harness source={old} />)
  open('$')
  await waitFor(() => expect(resolve).toBeDefined())
  view.rerender(<Harness source={replacement} />)
  await act(async () => {
    resolve([factory])
  })
  expect(screen.queryByTestId(pluginOption)).not.toBeInTheDocument()
})

test('keeps other choices available and offers retry when the plugin inventory fails', async () => {
  const source = vi
    .fn<() => Promise<InstalledPlugin[]>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([factory])
  render(<Harness source={source} />)
  open('$')
  fireEvent.click(await screen.findByTestId('composer-mention-partial-retry'))
  expect(await screen.findByTestId(pluginOption)).toBeEnabled()
})

test.each(['retained', 'browser'] as const)('%s hiding defers dirty menu catalogs until the composer is visible', async mode => {
  const skillSource = vi.fn(async () => [skill])
  const source = vi.fn(async () => [factory])
  const appSource = vi.fn(async () => [])
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const content = (open: boolean) => <RetainedPage open={open}>
    <Harness source={source} skillSource={skillSource} appSource={appSource} />
  </RetainedPage>
  const view = render(content(true))
  try {
    open('$')
    await screen.findByTestId(pluginOption)
    await waitFor(() => expect(appSource).toHaveBeenCalledOnce())
    if (mode === 'retained') view.rerender(content(false))
    else act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT)) })
    expect(source).toHaveBeenCalledOnce()
    expect(skillSource).toHaveBeenCalledOnce()
    expect(appSource).toHaveBeenCalledOnce()
    if (mode === 'retained') view.rerender(content(true))
    else act(() => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => {
      expect(source).toHaveBeenCalledTimes(2)
      expect(skillSource).toHaveBeenCalledTimes(2)
      expect(appSource).toHaveBeenCalledTimes(2)
    })
  } finally { view.unmount(); visibility.mockRestore() }
})

test.each(['success', 'error'] as const)('replacement skill and app sources retire a pending old %s without editor input', async outcome => {
  let oldSkills!: (value: LocalDeviceSkill[]) => void
  let oldApps!: (value: LocalDeviceApp[]) => void
  let failSkills!: (reason: Error) => void
  let failApps!: (reason: Error) => void
  const skillSource = () => new Promise<LocalDeviceSkill[]>((resolve, reject) => { oldSkills = resolve; failSkills = reject })
  const appSource = () => new Promise<LocalDeviceApp[]>((resolve, reject) => { oldApps = resolve; failApps = reject })
  const nextSkills = vi.fn(async () => [{ ...skill, name: 'current-skill' }])
  const nextApps = vi.fn(async () => [{ id: 'current-app', name: 'Current app' }])
  const source = async () => []
  const view = render(<Harness source={source} skillSource={skillSource} appSource={appSource} />)
  try {
    open('@')
    await waitFor(() => { expect(oldSkills).toBeDefined(); expect(oldApps).toBeDefined() })
    view.rerender(<Harness source={source} skillSource={nextSkills} appSource={nextApps} />)
    await waitFor(() => { expect(nextSkills).toHaveBeenCalledOnce(); expect(nextApps).toHaveBeenCalledOnce() })
    await act(async () => {
      if (outcome === 'success') { oldSkills([skill]); oldApps([{ id: 'old-app', name: 'Old app' }]) }
      else { failSkills(new Error('old skill failure')); failApps(new Error('old app failure')) }
    })
    expect(await screen.findByTestId('local-skill-option-current-skill')).toBeVisible()
    expect(screen.getByText('Current app')).toBeVisible()
    expect(screen.queryByText('Old app')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-skill-option-factory-build')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-mention-partial-retry')).not.toBeInTheDocument()
  } finally { view.unmount() }
})

test.each(['success', 'error'] as const)('a closed dirty menu rejects its late %s after reopening', async outcome => {
  let finish!: (items: string[]) => void
  let fail!: (reason: Error) => void
  const source = vi.fn<() => Promise<string[]>>()
    .mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    .mockResolvedValue(['current'])
  const view = renderHook(({ active }) => useComposerDirectory(source, active), { initialProps: { active: true } })
  try {
    await waitFor(() => expect(source).toHaveBeenCalledOnce())
    view.rerender({ active: false })
    act(() => { window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT)) })
    expect(source).toHaveBeenCalledOnce()
    view.rerender({ active: true })
    await waitFor(() => expect(view.result.current.items).toEqual(['current']))
    await act(async () => { if (outcome === 'success') finish(['old']); else fail(new Error('old failure')) })
    expect(view.result.current.items).toEqual(['current'])
    expect(view.result.current.error).toBe(false)
    expect(source).toHaveBeenCalledTimes(2)
  } finally { view.unmount() }
})

test('a synchronous directory failure waits for explicit retry and does not loop', async () => {
  const source = vi.fn<() => Promise<string[]>>()
    .mockImplementationOnce(() => { throw new Error('offline') })
    .mockResolvedValue(['current'])
  const view = renderHook(() => useComposerDirectory(source, true))
  try {
    await waitFor(() => expect(view.result.current.error).toBe(true))
    view.rerender()
    expect(source).toHaveBeenCalledOnce()
    act(() => view.result.current.retry())
    await waitFor(() => expect(view.result.current.items).toEqual(['current']))
    expect(source).toHaveBeenCalledTimes(2)
  } finally { view.unmount() }
})

test('retiring before the queued directory invocation does not start a request', async () => {
  const source = vi.fn(async () => ['unused'])
  const view = renderHook(() => useComposerDirectory(source, true))
  view.unmount()
  await act(async () => {})
  expect(source).not.toHaveBeenCalled()
})

const nativeTarget: WorkspaceTarget = { deviceId: 'native-owner', path: '/owned', source: 'runtime' }

test.each(['current', 'unscoped', 'unknown-owner'] as const)('%s Native tools notices refresh only Native menu sources', async kind => {
  const skillSource = vi.fn(async () => [skill])
  const source = vi.fn(async () => [factory])
  const appSource = vi.fn(async () => [])
  render(<Harness source={source} skillSource={skillSource} appSource={appSource}
    target={kind === 'unknown-owner' ? undefined : nativeTarget} />)
  open('$')
  await screen.findByTestId(pluginOption)
  await waitFor(() => expect(appSource).toHaveBeenCalledOnce())
  const changed = kind === 'unscoped' ? undefined : nativeTarget.deviceId
  act(() => { notifyToolsCatalogChanged(changed); notifyToolsCatalogChanged(changed) })
  await waitFor(() => { expect(source).toHaveBeenCalledTimes(2); expect(skillSource).toHaveBeenCalledTimes(2) })
  expect(appSource).toHaveBeenCalledOnce()
})

test('a peer Native notice preserves the current menu without reading or clearing it', async () => {
  const skillSource = vi.fn(async () => [skill]), source = vi.fn(async () => [factory])
  render(<Harness source={source} skillSource={skillSource} target={nativeTarget} />)
  open('$')
  await screen.findByTestId(pluginOption)
  await act(async () => { notifyToolsCatalogChanged('peer-owner') })
  expect(screen.getByTestId(pluginOption)).toBeVisible()
  expect(source).toHaveBeenCalledOnce()
  expect(skillSource).toHaveBeenCalledOnce()
})

test('a closed menu defers its Native notice and preserves the cloud app inventory on reopen', async () => {
  const skillSource = vi.fn(async () => [skill]), source = vi.fn(async () => [factory]), appSource = vi.fn(async () => [])
  render(<Harness source={source} skillSource={skillSource} appSource={appSource} target={nativeTarget} />)
  const editor = open('$')
  await screen.findByTestId(pluginOption)
  fireEvent.keyDown(editor, { key: 'Escape' })
  act(() => { editor.blur() })
  source.mockResolvedValue([{ ...factory, spec: { ...factory.spec, enabled: false } }])
  await act(async () => { notifyToolsCatalogChanged(nativeTarget.deviceId) })
  expect(source).toHaveBeenCalledOnce()
  expect(skillSource).toHaveBeenCalledOnce()
  open('$')
  await waitFor(() => expect(screen.getByTestId(pluginOption)).toBeDisabled())
  expect(source).toHaveBeenCalledTimes(2)
  expect(skillSource).toHaveBeenCalledTimes(2)
  expect(appSource).toHaveBeenCalledOnce()
})

test.each(['retained', 'browser'] as const)('%s hidden Native invalidation waits for visibility without refreshing cloud apps', async mode => {
  const skillSource = vi.fn(async () => [skill]), source = vi.fn(async () => [factory]), appSource = vi.fn(async () => [])
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const content = (open: boolean) => <RetainedPage open={open}>
    <Harness source={source} skillSource={skillSource} appSource={appSource} target={nativeTarget} />
  </RetainedPage>
  const view = render(content(true))
  try {
    open('$')
    await screen.findByTestId(pluginOption)
    if (mode === 'retained') view.rerender(content(false))
    else act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { notifyToolsCatalogChanged(nativeTarget.deviceId) })
    expect(source).toHaveBeenCalledOnce()
    expect(skillSource).toHaveBeenCalledOnce()
    if (mode === 'retained') view.rerender(content(true))
    else act(() => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => { expect(source).toHaveBeenCalledTimes(2); expect(skillSource).toHaveBeenCalledTimes(2) })
    expect(appSource).toHaveBeenCalledOnce()
  } finally { view.unmount(); visibility.mockRestore() }
})
