import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { InstalledPlugin } from '../../src/types/api'
import { ComposerTextarea } from '../../src/components/chat/composer/ComposerTextarea'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

// Keyboard-only fixture: no Gateway, model calls, sessions or shared configuration.
const params = new URLSearchParams(window.location.search)
await i18n.changeLanguage(params.get('locale') || 'en')
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const factorySkill = {
  name: 'factory-build',
  description: 'Build a project',
  source: 'kcoder',
  path: String.raw`C:\Users\fixture\factory ((work))\skills\build\SKILL.md`,
}
const listPlugins = async (): Promise<InstalledPlugin[]> => [
  {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { namespace: 'local' },
    spec: {
      source: { type: 'local', providerKey: 'local', pluginKey: 'factory' },
      displayName: 'Factory',
      description: 'Factory project tools',
      enabled: params.get('disabled') !== 'true',
      installState: 'installed',
      manifest: {},
      components: {
        skills: [{ name: factorySkill.name, path: factorySkill.path }],
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
  },
]
const listSkills = async () => [
  factorySkill,
  {
    name: 'sample-skill',
    description: 'Fixture skill',
    path: '/fixture/SKILL.md',
    source: 'codex',
  },
]
export function ComposerSlashFixture() {
  const [value, setValue] = useState('')
  const [action, setAction] = useState('')
  const [submitted, setSubmitted] = useState('')
  const textareaRef = useRef<HTMLElement>(null)
  return (
    <main className="flex h-dvh flex-col bg-background p-4 text-text-primary">
      <output data-testid="fixture-action">{action}</output>
      <output data-testid="fixture-submitted">{submitted}</output>
      <div className="mt-auto">
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={setSubmitted}
          canSend
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          onSetPlanMode={() => setAction('plan')}
          onSetGoal={mode => setAction(mode === 'strict' ? 'goal-pro' : 'goal')}
          executionModes={{ canSelectOrchestrate: true, onSelect: setAction }}
          onCompactContext={() => setAction('compact')}
          models={[{ name: 'fixture-model', type: 'runtime' }]}
          onSelectModel={model => setAction(model.name)}
          onListLocalSkills={listSkills}
          onListLocalPlugins={listPlugins}
          onOpenSkillFile={path => setAction(path)}
        />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<ComposerSlashFixture />)
