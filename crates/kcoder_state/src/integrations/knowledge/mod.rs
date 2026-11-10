//! Durable business automation state; the authenticated host owns authorization.
mod automation_store;
pub use automation_store::{
    ApprovedAutomationArtifactClaim, ApprovedAutomationConsent, AutomationInboxEventDisposition,
    AutomationStore, VerifiedAutomationSourceStart,
};
