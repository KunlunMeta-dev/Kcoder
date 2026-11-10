import { Text } from 'react-native';
import { t } from '@/i18n';
import type { MigrationSourceWorkspaceProps } from './MigrationSourceWorkspace.types';
/** Native file/transport acceptance is deferred; Metro selects the independent Web implementation. */
export function MigrationSourceWorkspace(_props: MigrationSourceWorkspaceProps) { return <Text>{t('migration_source.web_only')}</Text>; }
