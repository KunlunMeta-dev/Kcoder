import { Form, Input, InputNumber, Select, Switch } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import { channelPlatforms, type ChannelPlatform } from '@/kcoder/channelPlatforms'

/** Platform declarations select fields; all connection editors use the same controls. */
export function ChannelFeatureSettings({ platform, value, disabled, onChange }: {
  platform: ChannelPlatform; value: Record<string, unknown>; disabled: boolean
  onChange: (value: Record<string, unknown>) => void
}) {
  const { t } = useTranslation('connectivity')
  const fields = channelPlatforms[platform].featureFields
  return <details className="my-4 rounded-lg border border-border p-3" data-testid="channel-feature-settings">
    <summary className="cursor-pointer text-sm font-medium">{t('channelFeatures.title')}</summary>
    <div className="mt-3 space-y-3">
      {Object.entries(fields).map(([name, field]) => {
        const selected = value[name] ?? field.default
        const label = t(`channelFeatures.fields.${name}`)
        const update = (next: unknown) => onChange({ ...value, [name]: next })
        return <Form.Item key={name} label={label}>
          {field.type === 'enum' ? field.options?.length === 1
            ? <p className="text-sm text-text-secondary">{t(`channelFeatures.values.${String(selected)}`)}</p>
            : <Select aria-label={label} value={String(selected)} disabled={disabled}
              getPopupContainer={trigger => trigger.parentElement ?? trigger}
              options={field.options?.map(option => ({ value: option, label: t(`channelFeatures.values.${option}`) }))} onChange={update} />
            : field.type === 'boolean' ? <Switch aria-label={label} checked={selected === true} disabled={disabled} onChange={update} />
              : field.type === 'integer' ? <InputNumber aria-label={label} value={Number(selected)} min={field.minimum}
                max={field.maximum} precision={0} disabled={disabled} onChange={next => { if (next !== null) update(next) }} />
                : <Input aria-label={label} value={String(selected)} maxLength={field.maxLength} disabled={disabled} onChange={event => update(event.target.value)} />}
        </Form.Item>
      })}
      <p className="text-sm text-text-secondary">{t('channelFeatures.help')}</p>
    </div>
  </details>
}
