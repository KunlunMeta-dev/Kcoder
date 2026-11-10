//! Explicit static instruction sources and scope choices do not import execution authority.
pub use kcoder_types::migration_instructions::*;
pub const CAPABILITY_MIGRATION_INSTRUCTION_SOURCES_V1: &str = "migrationInstructionSourcesV1";
pub const CAPABILITY_MIGRATION_SOURCE_TRANSFER_INSTRUCTIONS_V1: &str =
    "migrationSourceTransferInstructionsV1";
