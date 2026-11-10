// These domain schemas are generated from the actual Rust serde contract.
// Reuse the standard evaluator instead of maintaining another shape validator.
import schemas from '../generated/schemas.integrations-remotes.json' with { type: 'json' };
import { matchesSchema } from '../generated/validator.mjs';
export const isRemoteOperationControlMethod = value => matchesSchema(schemas.RemoteOperationControlMethod, value);
export const isRemoteOperationControlParams = value => matchesSchema(schemas.RemoteOperationControlParams, value);
export const isRemoteOperationControlReply = value => matchesSchema(schemas.RemoteOperationControlReply, value);
export const isRemoteOperationListParams = value => Boolean(schemas.RemoteOperationListParams) && matchesSchema(schemas.RemoteOperationListParams, value);
export const isRemoteOperationListReply = value => Boolean(schemas.RemoteOperationListReply) && matchesSchema(schemas.RemoteOperationListReply, value);
