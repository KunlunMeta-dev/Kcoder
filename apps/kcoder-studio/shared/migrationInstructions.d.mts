export const INSTRUCTION_CAPABILITY: 'migrationInstructionSourcesV1';
export const INSTRUCTION_TRANSFER_CAPABILITY: 'migrationSourceTransferInstructionsV1';
export const INSTRUCTION_METHODS: Readonly<{capture: 'migration/instructions/capture'; page: 'migration/instructions/page'; body: 'migration/instructions/body'}>;
export function validInstructionCall(method: string, input: unknown, result?: unknown): boolean;
export function validInstructionSourceCall(method: string, input: unknown, result?: unknown): boolean;
