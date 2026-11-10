//! Target-owned continuous work records.
//!
//! This module is a storage building block only. A caller must establish the
//! actual profile, workspace, session and source authority before using it.
mod host_scope;
mod namespace;
mod pending_inputs;
mod store;

pub use host_scope::HostWorkScope;
pub use pending_inputs::{
    PENDING_INPUT_PAGE_SIZE, PendingInputEntry, PendingInputPage, WorkInputEntry, WorkInputPage,
};
pub use store::{
    AcceptedInput, AppliedInputReference, ClaimOutcome, ClaimReceipt, ClaimSettlement,
    ClaimTrigger, ContinuousWorkStore, InitialAdmission, InputAdmission, InputAuthority,
    InputPublicationStatus, NativeForegroundWorkApplication, NativeInitialWorkAdmission,
    NativeInitialWorkCapacity, NativeInitialWorkOwner, NativeInitialWorkReceipt,
    NativeInitialWorkRequest, StoredBindingLookup, StoredBindingObservation, WorkInputSource,
    WorkIsolationReport, WorkRecordPage, native_work_input_payload, observe_stored_work_binding,
    observe_stored_work_bindings,
};

#[cfg(test)]
mod isolated_observation_tests;
#[cfg(test)]
mod tests;
