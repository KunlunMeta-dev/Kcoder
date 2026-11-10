import type { MigrationHistoryResourceAttachmentResult } from '../../../../../../shared/generated/contracts';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import type { AttachmentKind } from '../../../../../../shared/migrationResourceAttachment';
export type ResourceAttachmentProps = { client: MobileMigrationClient; identity: string; kind: AttachmentKind; jobId: string; disabled?: boolean; onObservation?(view: MigrationHistoryResourceAttachmentResult): void };
/** Native platform interaction remains outside this Web delivery. */
export function MigrationResourceAttachmentPanel(_props: ResourceAttachmentProps) { return null; }
