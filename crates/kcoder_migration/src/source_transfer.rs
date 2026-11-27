//! Versioned Native source snapshots and target-owned, resumable receipt transfer.
//!
//! This module does not discover homes, authenticate transports, install assets or run tools.
//! A host must supply authenticated opaque authorities and explicitly selected native grants.
//! Wire adapters must never log manifests or chunks: historical and asset content is private.
mod intent;
mod model;
pub mod private_credentials;
mod source;
mod storage;
mod target;
pub(crate) mod uploads;

pub use intent::{
    CaptureLease, CaptureObservation, ResolvedTransferSelection, SourceTransferIntents,
    TransferSelector, safe_transfer_error,
};
pub use model::*;
pub use source::{
    ExportSelection, InstructionExportBinding, InstructionExportSelection, SourceTransfers,
};
pub use target::{
    IncomingTransfers, ReceivedAdoptionControl, ReceivedAdoptionJob, ReceivedAdoptionLease,
    ReceivedAdoptionPhase, ReceivedAdoptionScope, ReceivedAdoptionSelection, ReceivedAdoptionState,
    ReceivedAdoptionWorkerState, ReceivedAssetBinding, ReceivedInstructionAdoptionMapping,
    ReceivedProjectMapping, ReceivedProjectTarget, ReceivedSourceClass, ReceivedSourcePage,
    ReceivedSourceSummary, RecoveredTargetTransfer, TransferAttemptKind, TransferAttemptLease,
    TransferAttemptRecord, TransferAttemptView, TransferTargetProgress, TransferTargetSummary,
    TransferredConfigurationBinding,
};
pub(crate) use target::{
    ReceivedHistoryBinding, ReceivedInstructionGraphBinding, ReceivedPluginArchive,
    ReceivedProjectInventoryBinding,
};

#[cfg(test)]
mod tests;
