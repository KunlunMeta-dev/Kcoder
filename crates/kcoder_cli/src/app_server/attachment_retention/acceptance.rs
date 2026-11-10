//! Verify accepted turn receipts from the original ledger and artifact files.
use super::{model::Scope, storage::digest, transfer};
use anyhow::{Context, Result, ensure};
use kcoder_state::turn_attempt_store::TurnAttemptStore;
use kcoder_types::{TurnAttemptIdentity, TurnRetainedInputV1};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TurnClientMessageArtifact {
    pub version: u8,
    pub thread_id: String,
    pub turn_id: String,
    pub client_message_id: String,
}

/// A proof capability minted from the existing attempt ledger and actual files.
/// Its fields are private so a caller cannot turn an RPC boolean into a proof.
pub struct VerifiedAcceptedTurnProof {
    scope: Scope,
    identity: TurnAttemptIdentity,
    fingerprint: String,
    request_digest: String,
    materialization_digest: String,
    input: TurnRetainedInputV1,
}

impl super::AcceptedTurnProof for VerifiedAcceptedTurnProof {
    fn is_exactly_accepted(&self, query: &transfer::AcceptedTurnQuery) -> Result<bool> {
        query.input.validate().map_err(anyhow::Error::msg)?;
        let ids: std::collections::BTreeSet<_> = query
            .input
            .artifacts
            .iter()
            .map(|a| a.retention_id.as_str())
            .collect();
        ensure!(
            ids.len() == 1,
            "proof query must cover exactly one complete receipt"
        );
        let id = ids.first().context("empty acceptance proof query")?;
        let expected: Vec<_> = self
            .input
            .artifacts
            .iter()
            .filter(|a| &a.retention_id.as_str() == id)
            .cloned()
            .collect();
        Ok(self.scope == query.scope
            && self.identity == query.identity
            && self.fingerprint == query.request_fingerprint
            && self.request_digest == query.request_digest
            && self.materialization_digest == query.materialization_digest
            && self.input.client_message_id == query.input.client_message_id
            && self.input.scope_id == query.input.scope_id
            && expected == query.input.artifacts)
    }
}

pub fn verified_retained_acceptance_in(
    session: &std::path::Path,
    scope: &Scope,
    identity: &TurnAttemptIdentity,
    client_message_id: &str,
    fingerprint: &str,
    parent: &kcoder_config::PrivateDirectory,
) -> Result<VerifiedAcceptedTurnProof> {
    let store = TurnAttemptStore::open_existing(session, &identity.thread_id)?
        .context("accepted attempt store missing")?;
    let record = store
        .find_retained_acceptance(&scope.hash, client_message_id)?
        .context("retained acceptance is unavailable")?;
    record.validate()?;
    ensure!(
        record.identity == *identity
            && record.status.is_known()
            && record.request_fingerprint.as_deref() == Some(fingerprint),
        "accepted attempt tuple differs"
    );
    let input = record
        .retained_input
        .context("legacy attempt cannot prove retained acceptance")?;
    input.validate().map_err(anyhow::Error::msg)?;
    verify_retained_client_mapping(session, identity, client_message_id)?;
    for artifact in &input.artifacts {
        transfer::verify_artifact(parent, artifact)?;
    }
    Ok(VerifiedAcceptedTurnProof {
        scope: scope.clone(),
        identity: identity.clone(),
        fingerprint: fingerprint.into(),
        request_digest: transfer::request_digest(scope, identity, fingerprint, &input)?,
        materialization_digest: transfer::materialization_digest(
            scope,
            identity,
            fingerprint,
            &input,
        )?,
        input,
    })
}

fn verify_retained_client_mapping(
    session: &std::path::Path,
    identity: &TurnAttemptIdentity,
    client_message_id: &str,
) -> Result<()> {
    ensure!(
        strict_client_message_turn(session, &identity.thread_id, client_message_id)?
            == Some(identity.turn_id.clone()),
        "client message maps to a missing or ambiguous turn"
    );
    Ok(())
}

pub fn strict_client_message_turn(
    session: &std::path::Path,
    thread_id: &str,
    client_message_id: &str,
) -> Result<Option<String>> {
    use std::io::Read;
    let directory =
        match kcoder_config::PrivateDirectory::open_existing(&session.join("turn-client-messages"))
        {
            Ok(directory) => directory,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
    let mut count = 0usize;
    let mut bytes = 0u64;
    let mut matching = Vec::new();
    // This is the existing durable map, not its lossy UI projection. Unknown,
    // unreadable, duplicate or truncated records cannot prove absence.
    directory.visit_regular_files(
        |_| true,
        |name, file| {
            count += 1;
            ensure!(count <= 10_000, "client message map exceeds record bound");
            ensure!(
                file.metadata()?.len() <= 65_536,
                "oversized client message map"
            );
            let mut raw = Vec::new();
            file.take(65_537).read_to_end(&mut raw)?;
            bytes += raw.len() as u64;
            ensure!(
                raw.len() <= 65_536 && bytes <= 64 * 1024 * 1024,
                "client message map exceeds byte bound"
            );
            let artifact: TurnClientMessageArtifact = serde_json::from_slice(&raw)?;
            ensure!(
                artifact.version == 1
                    && artifact.thread_id == thread_id
                    && !artifact.turn_id.trim().is_empty()
                    && !artifact.client_message_id.trim().is_empty()
                    && name
                        == std::ffi::OsStr::new(&format!(
                            "{}.json",
                            digest(artifact.turn_id.as_bytes())
                        )),
                "invalid client message map identity"
            );
            if artifact.client_message_id == client_message_id {
                matching.push(artifact.turn_id);
            }
            Ok(())
        },
    )?;
    ensure!(
        matching.len() <= 1,
        "client message maps to ambiguous turns"
    );
    Ok(matching.pop())
}
