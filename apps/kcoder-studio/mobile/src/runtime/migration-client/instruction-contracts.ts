import * as C from '../../../../shared/generated/contracts';
import { INSTRUCTION_CAPABILITY, INSTRUCTION_METHODS, validInstructionCall } from '../../../../shared/migrationInstructions.mjs';
export interface InstructionCalls {
  instructionPage: [C.MigrationInstructionPageParams, C.MigrationInstructionPageResult];
  instructionBody: [C.MigrationInstructionBodyParams, C.MigrationInstructionBodyResult];
}
export const INSTRUCTION_CALLS = {
  instructionPage: { method: INSTRUCTION_METHODS.page, caps: [INSTRUCTION_CAPABILITY], read: true, params: (input: unknown) => validInstructionCall(INSTRUCTION_METHODS.page, input), result: C.isMigrationInstructionPageResult },
  instructionBody: { method: INSTRUCTION_METHODS.body, caps: [INSTRUCTION_CAPABILITY], read: true, params: (input: unknown) => validInstructionCall(INSTRUCTION_METHODS.body, input), result: C.isMigrationInstructionBodyResult },
};
