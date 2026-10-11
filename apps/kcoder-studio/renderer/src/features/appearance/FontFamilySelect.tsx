import { Code2, Type } from 'lucide-react'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { defaultAppearance } from './presets'

const uiFamilies = [
  'Segoe UI',
  'Arial',
  'Helvetica Neue',
  'Microsoft YaHei',
  'PingFang SC',
  'Noto Sans SC',
]
const codeFamilies = [
  'Cascadia Code',
  'Consolas',
  'JetBrains Mono',
  'Fira Code',
  'SFMono-Regular',
  'Menlo',
  'Monaco',
  'Liberation Mono',
]

export function FontFamilySelect({
  kind,
  value,
  onChange,
}: {
  kind: 'ui' | 'code'
  value: string
  onChange: (font: string) => void
}) {
  const { t } = useTranslation('common')
  const code = kind === 'code'
  const system = code ? defaultAppearance.codeFont : defaultAppearance.uiFont
  const choices = (code ? codeFamilies : uiFamilies).map(name => ({
    name,
    value: `'${name}', ${system}`,
  }))
  const custom = value !== system && !choices.some(choice => choice.value === value)
  return (
    <div className="w-[min(24rem,52vw)] max-sm:w-full">
      <SettingsSelect
        icon={code ? <Code2 /> : <Type />}
        data-testid={`appearance-${kind}-font-input`}
        aria-label={t(code ? 'workbench.appearance_code_font' : 'workbench.appearance_ui_font')}
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        <option value={system}>{t('workbench.appearance_font_system')}</option>
        {custom && (
          <option value={value}>{t('workbench.appearance_font_custom', { font: value })}</option>
        )}
        {choices.map(choice => (
          <option key={choice.name} value={choice.value}>
            {choice.name}
          </option>
        ))}
      </SettingsSelect>
      <p
        aria-hidden="true"
        className="mt-2 truncate px-1 text-sm text-text-secondary"
        style={{ fontFamily: value }}
      >
        {code ? 'const value = 012345; // Aa' : t('workbench.appearance_font_sample')}
      </p>
    </div>
  )
}
