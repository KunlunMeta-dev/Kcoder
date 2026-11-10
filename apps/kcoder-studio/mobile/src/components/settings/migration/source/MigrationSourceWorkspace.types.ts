import type { MobileMigrationClient, MigrationJobReadResult } from '@/runtime/migration-client';
export interface MigrationSourceWorkspaceProps { client: MobileMigrationClient; onJob(job: MigrationJobReadResult): void; }
