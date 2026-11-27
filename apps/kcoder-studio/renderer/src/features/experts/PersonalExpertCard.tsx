// Adapted from Octop AgentCard; MIT, renderer/third_party/octop/LICENSE.
import { useState } from 'react'
import {
  Bot,
  Copy,
  FolderOpen,
  Pencil,
  MessageSquare,
  RefreshCw,
  Trash2,
  Users,
  History,
  Sparkles,
} from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { OfficeAssistantItem } from '@/features/office-integration/controller'
import { expertPresentation, expertAvatar } from './presentation'
import styles from '@/features/octop/experts.module.css'

export function PersonalExpertCard({
  item,
  busy,
  pending,
  onEdit,
  onRefresh,
  onRemove,
  onToggle,
  onCopy,
  onUse,
  onPersonalize,
}: {
  item: OfficeAssistantItem
  busy: boolean
  pending: boolean
  onEdit: (item: OfficeAssistantItem, files?: boolean) => void
  onRefresh: () => void
  onRemove: (item: OfficeAssistantItem) => void
  onToggle: (item: OfficeAssistantItem, enabled: boolean) => void
  onCopy: (item: OfficeAssistantItem) => void
  onPersonalize: (item: OfficeAssistantItem) => void
  onUse: (item: OfficeAssistantItem) => void
}) {
  const { t } = useTranslation('experts')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const def = item.definition
  const meta = expertPresentation(def)
  const avatarUrl = expertAvatar(def)
  const unavailable = busy || pending
  return (
    <article className={styles.agentCard2} data-testid="expert-card" data-expert-id={def.id}>
      <div className={styles.agentCard2Header}>
        <div className={styles.agentCard2Icon}>
          {avatarUrl ? (
            <img src={avatarUrl} width={42} height={42} alt="" />
          ) : meta.kind === 'team' ? (
            <Users size={22} />
          ) : (
            <Bot size={22} />
          )}
        </div>
        <div className={styles.agentCard2TitleBlock}>
          <h2 className={styles.agentCard2Name}>{def.title}</h2>
          <p className="mt-1 text-xs text-text-secondary">
            {t(meta.enabled ? 'draft' : 'disabled')}
          </p>
        </div>
        <SettingsSwitch
          title={t('templateToggleHint')}
          aria-label={t('templateToggle')}
          checked={meta.enabled}
          disabled={unavailable}
          onCheckedChange={enabled => onToggle(item, enabled)}
        />
      </div>
      <p className={styles.agentCard2Desc}>{def.description || '\u00a0'}</p>
      <div className={styles.agentCard2Footer}>
        <ActionMenu
          ariaLabel={t('more')}
          testId={'expert-more-' + def.id}
          placement="bottom-end"
          disabled={unavailable}
          items={[
            {
              label: t('files'),
              icon: FolderOpen,
              testId: 'expert-files-' + def.id,
              onSelect: () => onEdit(item, true),
            },
            {
              label: t('personalization.title'),
              icon: Sparkles,
              testId: 'expert-personalize-' + def.id,
              onSelect: () => onPersonalize(item),
            },
            {
              label: t('versions'),
              icon: History,
              testId: 'expert-versions-' + def.id,
              onSelect: () => onEdit(item, true),
            },
            {
              label: t('refresh'),
              icon: RefreshCw,
              testId: 'expert-refresh-' + def.id,
              onSelect: onRefresh,
            },
            {
              label: t('copy'),
              icon: Copy,
              testId: 'expert-copy-' + def.id,
              onSelect: () => onCopy(item),
            },
            {
              label: t('delete'),
              icon: Trash2,
              danger: true,
              testId: 'expert-delete-' + def.id,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={unavailable}
          onClick={() => onEdit(item)}
        >
          <Pencil aria-hidden="true" />
          {t('edit')}
        </Button>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={unavailable || !meta.enabled || meta.kind === 'team'}
          onClick={() => onUse(item)}
        >
          <MessageSquare aria-hidden="true" />
          {t('conversation.open')}
        </Button>
      </div>
      {confirmDelete && (
        <ModalDialog
          title={t('delete')}
          testId="expert-delete-confirm"
          pending={unavailable}
          closeLabel={t('cancel')}
          onClose={() => setConfirmDelete(false)}
        >
          <p className="my-4 text-sm text-text-secondary">{t('deleteConfirm')}</p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={unavailable}
              onClick={() => setConfirmDelete(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={unavailable}
              onClick={() => {
                onRemove(item)
                setConfirmDelete(false)
              }}
            >
              {t('delete')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </article>
  )
}
