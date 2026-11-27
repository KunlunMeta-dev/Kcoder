//! Explicit private-value channel. Ordinary transfer IR contains no keys or encrypted payloads.
mod candidate_targets;
mod candidates;
mod cleanup;
mod control;
mod crypto;
mod input;
mod model;
mod recovery;
mod source;
mod source_observation;
pub use source_observation::observe_existing_source_private_credentials;
mod storage;
mod target;
mod watermark;
pub use cleanup::release_private_credential_offer_key;
pub use control::{
    PrivateCredentialControl, source_private_credential_control, target_private_credential_control,
};
pub use input::{CredentialSourceBinding, ReceivedCredentialInput};
pub use model::{
    PrivateCredentialConsent, PrivateCredentialContext, PrivateCredentialEnvelope,
    PrivateCredentialOffer, PrivateCredentialSelection,
};
pub use source::seal_private_credentials;
pub use target::{
    PrivateCredentialOfferInput, ReceivedPrivateCredentialBinding, ReceivedPrivateCredentialLease,
    accept_private_credential_envelope, prepare_private_credential_offer,
};
pub(crate) use target::{PublicationClaim, private_credential_bundle_digest};

pub use recovery::{
    PrivateCredentialObservation, read_source_private_credentials, read_target_private_credentials,
};

pub use watermark::{
    PrivateCredentialWatermark, PrivateCredentialWatermarkControl,
    source_private_credential_watermark, target_private_credential_watermark,
};

pub use candidates::{
    PrivateCredentialCandidate, PrivateCredentialCandidatePage, private_credential_candidates,
};

pub use candidate_targets::{
    PrivateCredentialCandidatePlan, PrivateCredentialCandidateTarget,
    private_credential_candidates_for_plan,
};

mod preparation;
pub use preparation::{
    PreparationConsent, PrivateCredentialPreparationPhase, PrivateCredentialPreparationStatus,
};
pub(crate) use preparation::{
    PreparationIntent, existing_intent as existing_preparation_intent,
    legacy_publication_exists as legacy_private_publication_exists,
};
