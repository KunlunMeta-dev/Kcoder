// Adapted from Octop StreamSetupGuide; MIT, third_party/octop/LICENSE.
import { Button } from 'antd'
import { BookOpen, Plus } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import styles from './empty.module.css'
import expertStyles from './experts.module.css'

export function EmptyGuide({
  team,
  onCreate,
  onLibrary,
  disabled = false,
}: {
  team: boolean
  onCreate: () => void
  onLibrary: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation('experts')
  return (
    <div className={expertStyles.emptyLayout}>
      <div className={`${styles.wrap} ${styles.wide} ${styles.plain} ${expertStyles.emptyGuide}`}>
        <div className={styles.card}>
          <h3 className={styles.title}>{t(team ? 'teams.emptyTitle' : 'empty')}</h3>
          <p className={styles.description}>
            {t(team ? 'teams.emptyDescription' : 'emptyDescription')}
          </p>
          <ol className={styles.steps}>
            {[1, 2, 3].map(step => (
              <li className={styles.step} key={step}>
                <span className={styles.stepIndex}>{step}</span>
                <div className={styles.stepBody}>
                  <div className={styles.stepLabel}>
                    {t(`${team ? 'teams.' : 'emptyGuide.'}step${step}`)}
                  </div>
                  <div className={styles.stepDetail}>
                    {t(`${team ? 'teams.' : 'emptyGuide.'}detail${step}`)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <div className={styles.actions}>
            <Button
              type={team ? 'default' : 'primary'}
              disabled={disabled}
              icon={<Plus size={14} />}
              onClick={onCreate}
            >
              {t(team ? 'teams.create' : 'create')}
            </Button>
            {!team && (
              <Button icon={<BookOpen size={14} />} onClick={onLibrary}>
                {t('goToLibrary')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
