//! Complete durable preparation intent; ordinary job views are not preparation receipts.
use super::{PublicationClaim, ReceivedPrivateCredentialBinding, private_credential_bundle_digest};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreparationIntent {
    pub request_id: String,
    pub expected_sequence: u64,
    pub consent: PreparationConsent,
    pub job_id: String,
    pub original_plan_id: String,
    pub action_id: String,
    pub plan_id: String,
    pub bundle_sha256: String,
    pub members: Vec<ReceivedPrivateCredentialBinding>,
}
impl PreparationIntent {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.job_id.starts_with("mig-")
                && self.job_id.len() == 36
                && [&self.original_plan_id, &self.action_id, &self.plan_id]
                    .iter()
                    .all(|id| !id.is_empty()
                        && id.len() <= 256
                        && !id.chars().any(char::is_control)),
            "private_credentials_publication_binding_changed"
        );
        ensure!(
            !self.members.is_empty()
                && self.members.len() <= 16
                && self
                    .members
                    .windows(2)
                    .all(|pair| pair[0].offer_id() < pair[1].offer_id())
                && self
                    .members
                    .iter()
                    .map(|member| member.selections().len())
                    .sum::<usize>()
                    <= 64,
            "private_credentials_budget_exceeded"
        );
        ensure!(
            self.expected_sequence <= 9_007_199_254_740_991
                && self
                    .members
                    .iter()
                    .all(|member| member.context().request_id == self.request_id),
            "private_credentials_publication_binding_changed"
        );
        for member in &self.members {
            self.consent.native().require(member.selections())?;
        }
        let refs = self.members.iter().collect::<Vec<_>>();
        ensure!(
            self.bundle_sha256
                == private_credential_bundle_digest(
                    &self.job_id,
                    &self.original_plan_id,
                    &self.action_id,
                    &refs
                )?,
            "private_credentials_publication_binding_changed"
        );
        Ok(())
    }
    pub(crate) fn claim(&self) -> PublicationClaim {
        PublicationClaim {
            job_id: self.job_id.clone(),
            original_plan_id: self.original_plan_id.clone(),
            action_id: self.action_id.clone(),
            plan_id: self.plan_id.clone(),
            bundle_sha256: Some(self.bundle_sha256.clone()),
        }
    }
    pub(crate) fn offer_ids(&self) -> Vec<String> {
        self.members
            .iter()
            .map(|member| member.offer_id().to_owned())
            .collect()
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivateCredentialPreparationPhase {
    NotStarted,
    Pending,
    Prepared,
    Unknown,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparationConsent {
    pub api_keys: bool,
    pub mcp_private_fields: bool,
}
impl PreparationConsent {
    pub(crate) fn native(self) -> super::PrivateCredentialConsent {
        super::PrivateCredentialConsent {
            api_keys: self.api_keys,
            mcp_private_fields: self.mcp_private_fields,
        }
    }
}
impl From<super::PrivateCredentialConsent> for PreparationConsent {
    fn from(value: super::PrivateCredentialConsent) -> Self {
        Self {
            api_keys: value.api_keys,
            mcp_private_fields: value.mcp_private_fields,
        }
    }
}
/// This metadata says nothing about live secrets or publication. The native
/// target still validates every member and current policy before execution.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCredentialPreparationStatus {
    pub job_id: String,
    pub sequence: u64,
    pub phase: PrivateCredentialPreparationPhase,
    pub original_plan_id: Option<String>,
    pub plan_id: Option<String>,
    pub offer_ids: Option<Vec<String>>,
    pub expected_sequence: Option<u64>,
    pub consent: Option<PreparationConsent>,
}

pub(crate) fn existing_intent(
    profile: &std::path::Path,
    job: &str,
) -> Result<Option<PreparationIntent>> {
    let Some(store) = super::super::storage::Store::existing_private_credentials_if_born(profile)?
    else {
        return Ok(None);
    };
    super::storage::preparation_for_job(&store, job)
}
pub(crate) fn legacy_publication_exists(profile: &std::path::Path, job: &str) -> Result<bool> {
    let Some(store) = super::super::storage::Store::existing_private_credentials_if_born(profile)?
    else {
        return Ok(false);
    };
    super::storage::legacy_publication_for_job(&store, job)
}

impl super::ReceivedPrivateCredentialBinding {
    pub fn matches_authenticated_request(
        &self,
        request: &str,
        source: &super::super::TransferAuthority,
        target: &super::super::TransferAuthority,
    ) -> bool {
        let context = self.context();
        context.request_id == request
            && &context.source == source
            && &context.destination.authority == target
    }
}
