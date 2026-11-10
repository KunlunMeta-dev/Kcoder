import * as C from '../../../../shared/generated/contracts';
import { BATCH_CONTROL_CAPABILITY, BATCH_CONTROL_METHODS } from '../../../../shared/migrationBatchControl';

export interface BatchControlCalls {
  batchControlRead: [C.MigrationBatchControlReadParams, C.MigrationBatchControlResult];
  batchControlCancel: [C.MigrationBatchControlCancelParams, C.MigrationBatchControlResult];
}
export const BATCH_CONTROL_CALLS = {
  batchControlRead: { method: BATCH_CONTROL_METHODS.read, caps: [BATCH_CONTROL_CAPABILITY], read: true,
    params: C.isMigrationBatchControlReadParams, result: C.isMigrationBatchControlResult },
  batchControlCancel: { method: BATCH_CONTROL_METHODS.cancel, caps: [BATCH_CONTROL_CAPABILITY], read: false, transient: true,
    params: C.isMigrationBatchControlCancelParams, result: C.isMigrationBatchControlResult },
};
