import { Text, View } from 'react-native'
import { Button } from '@/components/ui'
import { t } from '@/i18n'
import { useThemedStyles } from '@/theme'
import { makeStyles } from '../migration-result-ui'
import type { useMigrationHistoryView } from './useMigrationHistoryView'
export function MigrationHistoryViewStatus({model}:{model:ReturnType<typeof useMigrationHistoryView>}) {
  const styles=useThemedStyles(makeStyles)
  if(model.state==='idle')return null
  return <View style={styles.stack} testID="migration-history-view-status">
    <Text style={styles.note}>{t(model.state==='confirmed'&&model.lease?.legacyArchives?'migration_history.lifecycle.view_legacy':`migration_history.lifecycle.view_${model.state}`)}</Text>
    {['unconfirmed','expired','released'].includes(model.state)?<Button variant="ghost" testID="migration-history-view-open" onPress={model.open}>{t('migration_history.lifecycle.protect_again')}</Button>:null}
  </View>
}
