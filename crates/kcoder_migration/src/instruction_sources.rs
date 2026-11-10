//! Explicit static instruction scopes; source policy and data never grant native execution authority.
#[path = "instruction_sources/authority.rs"]
mod authority;
mod catalog;
#[path = "instruction_sources/creation.rs"]
mod creation;
#[path = "instruction_sources/format.rs"]
mod format;
#[path = "instruction_sources/grant.rs"]
mod grant;
#[path = "instruction_sources/metadata.rs"]
mod metadata;
#[path = "instruction_sources/model.rs"]
mod model;
#[path = "instruction_sources/portable.rs"]
pub(crate) mod portable;
#[path = "instruction_sources/read.rs"]
mod read;
#[path = "instruction_sources/scan.rs"]
mod scan;
#[path = "instruction_sources/seed.rs"]
mod seed;
#[path = "instruction_sources/snapshot.rs"]
mod snapshot;
#[path = "instruction_sources/target.rs"]
mod target;
pub use catalog::{CapturedInstructions, InstructionCaptureRequest, InstructionSourceCatalog};
pub use grant::InstructionSourceGrant;
pub use model::{
    InstructionDisposition, InstructionRole, InstructionSourcePolicy, InstructionSourceSnapshot,
    InstructionSourceSummary, InstructionTrigger,
};
pub use seed::InstructionSourceSeed;
pub use target::{InstructionDestination, InstructionResolution, ScopedInstructionDestination};
