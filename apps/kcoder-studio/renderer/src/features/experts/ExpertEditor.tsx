// Adapted from Octop CreateFromExpertDrawer/EditAgentDrawer; MIT, third_party/octop/LICENSE.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Collapse, ColorPicker, Form, Input, Select, Switch } from 'antd'
import { Bot, ImagePlus, Pencil } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { OfficeAssistantDefinition } from '../../../../shared/generated/contracts'
import {
  expertPresentation,
  withPresentation,
  annotations,
  updateAnnotations,
  expertAvatar,
} from './presentation'
import styles from '@/features/octop/experts.module.css'

const colors = [
  '#e85d75',
  '#4b74fa',
  '#6366f1',
  '#0d9488',
  '#7c3aed',
  '#10b981',
  '#f59e0b',
  '#64748b',
]
export function ExpertEditor({
  definition,
  isNew,
  onChange,
  onEditFile,
  files,
  versions,
  members,
  showDetails,
}: {
  definition: OfficeAssistantDefinition
  isNew: boolean
  onChange: (value: OfficeAssistantDefinition) => void
  onEditFile: () => void
  files: React.ReactNode
  versions: React.ReactNode
  members?: React.ReactNode
  showDetails: boolean
}) {
  const { t } = useTranslation('experts')
  const imageInput = useRef<HTMLInputElement>(null)
  const imageOwner = useRef(0)
  const latestDefinition = useRef(definition)
  useLayoutEffect(() => {
    latestDefinition.current = definition
  }, [definition])
  useEffect(() => {
    const epoch = ++imageOwner.current
    return () => {
      imageOwner.current = epoch + 1
    }
  }, [definition.id])
  const [avatarError, setAvatarError] = useState('')
  const meta = annotations(definition)
  const patch = (patch: Record<string, unknown>) => onChange(updateAnnotations(definition, patch))
  const set = (patch: Partial<OfficeAssistantDefinition>) => onChange({ ...definition, ...patch })
  const avatar = expertAvatar(definition)
  const upload = async (file: File) => {
    setAvatarError('')
    if (
      file.size > 5 * 1024 * 1024 ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
    ) {
      setAvatarError(t('avatarInvalid'))
      return
    }
    const epoch = imageOwner.current
    const identity = definition.id
    const bitmap = await createImageBitmap(file, {
      resizeWidth: 96,
      resizeHeight: 96,
      resizeQuality: 'high',
    })
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 96
      canvas.height = 96
      const context = canvas.getContext('2d')
      if (!context) throw new Error('IMAGE_CONTEXT_UNAVAILABLE')
      const scale = Math.min(96 / bitmap.width, 96 / bitmap.height)
      const width = bitmap.width * scale,
        height = bitmap.height * scale
      context.drawImage(bitmap, (96 - width) / 2, (96 - height) / 2, width, height)
      let data = canvas.toDataURL('image/webp', 0.7)
      if (data.length > 8192) data = canvas.toDataURL('image/webp', 0.35)
      if (!data.startsWith('data:image/webp;base64,') || data.length > 8192) {
        setAvatarError(t('avatarInvalid'))
        return
      }
      if (imageOwner.current === epoch && latestDefinition.current.id === identity)
        onChange(updateAnnotations(latestDefinition.current, { avatar: data }))
    } finally {
      bitmap.close()
    }
  }
  return (
    <Form layout="vertical" className="octop-expert-form">
      <Alert type="warning" showIcon className="octop-notice" message={t('inert')} />
      {!isNew && (
        <Form.Item label={t('expertId')}>
          <Input aria-label={t('expertId')} value={definition.id} readOnly />
        </Form.Item>
      )}
      <Form.Item label={t('name')} required>
        <Input
          aria-label={t('name')}
          value={definition.title}
          maxLength={200}
          onChange={e => set({ title: e.target.value })}
        />
      </Form.Item>
      {isNew && (
        <Form.Item label={t('customId')} extra={t('customIdHint')}>
          <Input
            aria-label={t('customId')}
            placeholder={t('customIdPlaceholder')}
            value={typeof meta.customId === 'string' ? meta.customId : ''}
            onChange={e => {
              const customId = e.target.value.trim()
              onChange(
                updateAnnotations(
                  {
                    ...definition,
                    ...(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}[a-zA-Z0-9]$/.test(customId)
                      ? { id: `personal.${customId}` }
                      : {}),
                  },
                  { customId }
                )
              )
            }}
          />
        </Form.Item>
      )}
      <Form.Item label={t('summary')}>
        <Input.TextArea
          aria-label={t('summary')}
          rows={2}
          value={definition.description}
          onChange={e => set({ description: e.target.value })}
        />
      </Form.Item>
      <Form.Item label={t('welcome')} extra={t('welcomeHint')}>
        <Input.TextArea
          aria-label={t('welcome')}
          rows={2}
          value={typeof meta.welcome === 'string' ? meta.welcome : ''}
          onChange={e => patch({ welcome: e.target.value.slice(0, 1000) })}
        />
      </Form.Item>
      <Collapse
        ghost
        items={[
          {
            key: 'page',
            label: t('pageConfig'),
            children: (
              <Form.Item label={t('quickPrompts')}>
                <Input.TextArea
                  aria-label={t('quickPrompts')}
                  rows={3}
                  value={typeof meta.quickPrompts === 'string' ? meta.quickPrompts : ''}
                  onChange={e => patch({ quickPrompts: e.target.value.slice(0, 1500) })}
                />
              </Form.Item>
            ),
          },
        ]}
      />
      <Form.Item label={t('avatar')}>
        <div className={styles.avatarPicker}>
          <button
            type="button"
            className={styles.avatarPickerPreviewBtn}
            aria-label={t('avatar')}
            onClick={() => imageInput.current?.click()}
          >
            {avatar ? (
              <img src={avatar} alt="" width={56} height={56} className="rounded-full" />
            ) : (
              <div
                className="octop-avatar-preview"
                style={{
                  color: expertPresentation(definition).color,
                  background: `${expertPresentation(definition).color}1a`,
                }}
              >
                <Bot size={28} />
              </div>
            )}
          </button>
          <div className={styles.avatarPickerActions}>
            <Button
              size="small"
              icon={<ImagePlus size={14} />}
              onClick={() => imageInput.current?.click()}
            >
              {t(avatar ? 'avatarChange' : 'avatarUpload')}
            </Button>
            {typeof meta.avatar === 'string' && (
              <Button size="small" onClick={() => patch({ avatar: null, avatarPreset: null })}>
                {t('avatarRemove')}
              </Button>
            )}
            <span className={styles.avatarPickerHint}>{t('avatarHint')}</span>
          </div>
        </div>
        <input
          ref={imageInput}
          hidden
          style={{ display: 'none' }}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={e => {
            const file = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            if (file) void upload(file).catch(() => setAvatarError(t('avatarInvalid')))
          }}
        />
        {avatarError && <p role="alert">{avatarError}</p>}
      </Form.Item>
      <Form.Item label={t('color')} extra={t('colorHint')}>
        <div className="octop-color-picker" role="group" aria-label={t('color')}>
          {colors.map(color => (
            <button
              key={color}
              type="button"
              aria-label={`${t('color')} ${color}`}
              aria-pressed={expertPresentation(definition).color === color}
              onClick={() => onChange(withPresentation(definition, { color }))}
            >
              <span style={{ background: color }} />
            </button>
          ))}
          <ColorPicker
            value={expertPresentation(definition).color}
            disabledAlpha
            onChangeComplete={color =>
              onChange(withPresentation(definition, { color: color.toHexString() }))
            }
          >
            <button
              type="button"
              aria-label={t('customColor')}
              aria-pressed={!colors.includes(expertPresentation(definition).color)}
            >
              <span
                className="octop-custom-swatch"
                style={
                  !colors.includes(expertPresentation(definition).color)
                    ? { background: expertPresentation(definition).color }
                    : undefined
                }
              />
            </button>
          </ColorPicker>
          {!colors.includes(expertPresentation(definition).color) && (
            <span className="octop-custom-hex">
              {expertPresentation(definition).color.toUpperCase()}
            </span>
          )}
        </div>
      </Form.Item>
      {members}
      <Form.Item label={t('defaultMode')} extra={t('defaultModeHint')}>
        <Select
          aria-label={t('defaultMode')}
          disabled
          value={typeof meta.mode === 'string' ? meta.mode : 'craft'}
          options={['ask', 'plan', 'craft'].map(value => ({ value, label: t(`modes.${value}`) }))}
        />
      </Form.Item>
      <Form.Item label={t('defaultModel')} extra={t('defaultModelHint')}>
        <Select
          value={definition.modelSelection.kind}
          onChange={kind => {
            if (kind === 'inherit_current') {
              set({ modelSelection: { kind: 'inherit_current' } })
            } else if (kind === 'explicit') {
              set({ modelSelection: {
                kind: 'explicit',
                provider: definition.modelSelection.kind === 'explicit' ? definition.modelSelection.provider : '',
                model: definition.modelSelection.kind === 'explicit' ? definition.modelSelection.model : '',
              } })
            }
          }}
          options={[
            { value: 'inherit_current', label: t('inheritModel') },
            { value: 'explicit', label: t('explicitModel') },
            ...(definition.modelSelection.kind === 'auto_policy'
              ? [{ value: 'auto_policy', label: t('autoPolicyUnsupported'), disabled: true }]
              : []),
          ]}
          aria-label={t('defaultModel')}
        />
        {definition.modelSelection.kind === 'explicit' && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Input
              aria-label={t('modelProvider')}
              placeholder={t('modelProvider')}
              value={definition.modelSelection.provider}
              onChange={event => set({ modelSelection: {
                kind: 'explicit',
                provider: event.target.value,
                model: definition.modelSelection.kind === 'explicit' ? definition.modelSelection.model : '',
              } })}
            />
            <Input
              aria-label={t('modelId')}
              placeholder={t('modelId')}
              value={definition.modelSelection.model}
              onChange={event => set({ modelSelection: {
                kind: 'explicit',
                provider: definition.modelSelection.kind === 'explicit' ? definition.modelSelection.provider : '',
                model: event.target.value,
              } })}
            />
          </div>
        )}
        {definition.modelSelection.kind === 'auto_policy' && (
          <p className="mt-2 text-sm text-text-secondary">{t('autoPolicyUnsupported')}</p>
        )}
      </Form.Item>
      <Form.Item label={t('toolAccess')} extra={t('toolAccessHint')}>
        <Select
          aria-label={t('toolAccess')}
          value={Array.isArray(definition.allowedTools) ? 'restricted' : 'inherit'}
          onChange={mode =>
            set({ allowedTools: mode === 'inherit' ? null : (definition.allowedTools ?? []) })
          }
          options={[
            { value: 'inherit', label: t('inheritTaskTools') },
            { value: 'restricted', label: t('restrictedTools') },
          ]}
        />
      </Form.Item>
      {Array.isArray(definition.allowedTools) && (
        <Form.Item label={t('toolNames')} extra={t('toolNamesHint')}>
          <Select
            mode="tags"
            aria-label={t('toolNames')}
            value={definition.allowedTools}
            onChange={tools => set({ allowedTools: [...new Set(tools)].slice(0, 256) })}
          />
        </Form.Item>
      )}
      <Form.Item label={t('storageBackend')}>
        <Select
          value="app-server"
          options={[{ value: 'app-server', label: t('targetStorage') }]}
          aria-label={t('storageBackend')}
        />
      </Form.Item>
      <Form.Item label={t('storageRoot')} extra={t('storageRootHint')}>
        <Input aria-label={t('storageRoot')} readOnly value={t('targetStorage')} />
      </Form.Item>
      <Form.Item label={t('trajectory')}>
        <Switch
          aria-label={t('trajectory')}
          checked={meta.trajectory !== false}
          onChange={trajectory => patch({ trajectory })}
        />
      </Form.Item>
      <Form.Item label={t('optionalSkills')}>
        <Select
          mode="tags"
          aria-label={t('optionalSkills')}
          value={
            Array.isArray(meta.skills)
              ? meta.skills.filter((x): x is string => typeof x === 'string')
              : []
          }
          onChange={skills => patch({ skills: skills.slice(0, 32) })}
          placeholder={t('optionalSkills')}
        />
      </Form.Item>
      <Form.Item label={t('optionalKnowledge')}>
        <Select
          mode="tags"
          aria-label={t('optionalKnowledge')}
          value={
            Array.isArray(meta.knowledge)
              ? meta.knowledge.filter((x): x is string => typeof x === 'string')
              : []
          }
          onChange={knowledge => patch({ knowledge: knowledge.slice(0, 32) })}
          placeholder={t('optionalKnowledge')}
        />
      </Form.Item>
      <Form.Item label={t('optionalConnectors')}>
        <Select
          mode="tags"
          aria-label={t('optionalConnectors')}
          value={
            Array.isArray(meta.connectors)
              ? meta.connectors.filter((x): x is string => typeof x === 'string')
              : []
          }
          onChange={connectors => patch({ connectors: connectors.slice(0, 32) })}
          placeholder={t('optionalConnectors')}
        />
      </Form.Item>
      <Collapse
        ghost
        items={[{ key: 'advanced', label: t('advanced'), children: <p>{t('inert')}</p> }]}
      />
      <Collapse
        key={String(showDetails)}
        defaultActiveKey={showDetails ? ['prompt', 'skills', 'versions'] : ['prompt', 'skills']}
        items={[
          {
            key: 'prompt',
            label: t('promptFiles'),
            children: (
              <div className="octop-file-row">
                <span>SOUL.md · {t('soulLabel')}</span>
                <Button type="link" icon={<Pencil size={12} />} onClick={onEditFile}>
                  {t('editFile')}
                </Button>
              </div>
            ),
          },
          { key: 'skills', label: t('includedSkills'), children: files },
          { key: 'versions', label: t('versions'), children: versions },
        ]}
      />
    </Form>
  )
}
