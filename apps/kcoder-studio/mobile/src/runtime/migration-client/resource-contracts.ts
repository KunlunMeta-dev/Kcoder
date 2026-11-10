import { RESOURCE_ATTACHMENT_CAPABILITY, RESOURCE_ATTACHMENT_METHODS } from '../../../../shared/migrationResourceAttachment';
import { HISTORY_RESOURCE_CAPABILITY, HISTORY_RESOURCE_METHODS } from '../../../../shared/migrationHistoryResourceBudget';
import * as C from '../../../../shared/generated/contracts';
import { RESOURCE_BUDGET_CAPABILITY, RESOURCE_BUDGET_METHODS } from '../../../../shared/migrationResourceBudget';
export interface ResourceCalls {
  historyResourceAttachmentRead: [C.MigrationHistoryResourceAttachmentReadParams, C.MigrationHistoryResourceAttachmentResult];
  batchResourceAttachmentRead: [C.MigrationHistoryResourceAttachmentReadParams, C.MigrationHistoryResourceAttachmentResult];
  historyResourcesRead: [C.MigrationHistoryResourceReadParams, C.MigrationHistoryResourceResult];
  historyResourcesIncrease: [C.MigrationHistoryResourceIncreaseParams, C.MigrationResourceIncreaseReceipt];
  historyResourcesAttach: [C.MigrationHistoryResourceAttachParams, C.MigrationHistoryResourceResult];
  batchResourcesAttach: [C.MigrationHistoryParentResourceAttachParams, C.MigrationResourceBudgetView];
  resourcesRead: [C.MigrationResourceBudgetReadParams, C.MigrationResourceBudgetView];
  resourcesIncrease: [C.MigrationResourceIncreaseParams, C.MigrationResourceIncreaseReceipt];
}
export const RESOURCE_CALLS = {
  historyResourceAttachmentRead: { method: RESOURCE_ATTACHMENT_METHODS.history, caps: [RESOURCE_ATTACHMENT_CAPABILITY], read: true, params: C.isMigrationHistoryResourceAttachmentReadParams, result: C.isMigrationHistoryResourceAttachmentResult },
  batchResourceAttachmentRead: { method: RESOURCE_ATTACHMENT_METHODS.batch, caps: [RESOURCE_ATTACHMENT_CAPABILITY], read: true, params: C.isMigrationHistoryResourceAttachmentReadParams, result: C.isMigrationHistoryResourceAttachmentResult },
  historyResourcesRead: { method: HISTORY_RESOURCE_METHODS.read, caps: [HISTORY_RESOURCE_CAPABILITY], read: true, params: C.isMigrationHistoryResourceReadParams, result: C.isMigrationHistoryResourceResult },
  historyResourcesIncrease: { method: HISTORY_RESOURCE_METHODS.increase, caps: [HISTORY_RESOURCE_CAPABILITY], read: false, transient: true, params: C.isMigrationHistoryResourceIncreaseParams, result: C.isMigrationResourceIncreaseReceipt },
  historyResourcesAttach: { method: HISTORY_RESOURCE_METHODS.attach, caps: [HISTORY_RESOURCE_CAPABILITY], read: false, params: C.isMigrationHistoryResourceAttachParams, result: C.isMigrationHistoryResourceResult },
  batchResourcesAttach: { method: HISTORY_RESOURCE_METHODS.parentAttach, caps: [HISTORY_RESOURCE_CAPABILITY], read: false, params: C.isMigrationHistoryParentResourceAttachParams, result: C.isMigrationResourceBudgetView },
  resourcesRead: { method: RESOURCE_BUDGET_METHODS[0], caps: [RESOURCE_BUDGET_CAPABILITY], read: true, params: C.isMigrationResourceBudgetReadParams, result: C.isMigrationResourceBudgetView },
  // The budget coordinator owns the complete durable intent; do not create a second generic locator.
  resourcesIncrease: { method: RESOURCE_BUDGET_METHODS[1], caps: [RESOURCE_BUDGET_CAPABILITY], read: false, transient: true, params: C.isMigrationResourceIncreaseParams, result: C.isMigrationResourceIncreaseReceipt },
};
