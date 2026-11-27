import { Spin } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import styles from '@/features/octop/experts.module.css'

export function ExpertLoading({ testId = 'expert-catalog-loading' }: { testId?: string }) {
  const { t } = useTranslation('experts')
  return (
    <div
      className={styles.loadingState}
      data-testid={testId}
      role="status"
      aria-label={t('loading')}
    >
      <Spin />
    </div>
  )
}
