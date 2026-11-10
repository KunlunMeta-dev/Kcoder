import type { MobileMigrationClient, MigrationJobReadResult } from '@/runtime/migration-client';
/** Native mobile credential transport is outside the current Web acceptance scope. */
export function MigrationPrivateCredentials(_props: { client: MobileMigrationClient; job: MigrationJobReadResult; onPrepared(): void }) { return null; }
