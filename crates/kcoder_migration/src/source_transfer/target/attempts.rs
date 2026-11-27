//! Durable admission is not proof that a Gateway invocation executed or completed.
use super::*;
use kcoder_config::{PortableLeaseIdentity, PrivateLeaseMode, VerifiedPrivateLease};

const MAX_ATTEMPTS: usize = 256;
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct AttemptBirth {
    id: String,
    writer: PortableLeaseIdentity,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferAttemptKind {
    Run,
    Finish,
    TargetResume,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferAttemptRecord {
    pub attempt_id: String,
    pub kind: TransferAttemptKind,
    pub call_digest: String,
    pub selection_digest: Option<String>,
}
impl TransferAttemptRecord {
    fn validate(&self) -> Result<()> {
        valid_uuid(&self.attempt_id)?;
        ensure!(
            valid_sha(&self.call_digest)
                && self.selection_digest.as_ref().is_none_or(|v| valid_sha(v))
                && (self.kind == TransferAttemptKind::Run) == self.selection_digest.is_some(),
            "source_transfer_invalid_attempt"
        );
        Ok(())
    }
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    birth: String,
    request_id: String,
    binding_digest: String,
    selection_digest: Option<String>,
    attempts: Vec<TransferAttemptRecord>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferAttemptView {
    pub tracked: bool,
    pub binding_digest: String,
    pub selection_digest: Option<String>,
    pub attempt: Option<TransferAttemptRecord>,
    /// The actual cross-process execution lease, not a persisted running flag.
    pub running: bool,
}
pub struct TransferAttemptLease {
    guard: VerifiedPrivateLease,
    directory: PrivateDirectory,
}
impl TransferAttemptLease {
    pub fn verify(&self) -> Result<()> {
        ensure!(
            self.directory
                .portable_regular_handle_identity(self.guard.file())?
                == *self.guard.identity()
                && self
                    .directory
                    .portable_regular_identity(OsStr::new("attempt.lock"))?
                    == *self.guard.identity(),
            "source_transfer_attempt_owner_changed"
        );
        Ok(())
    }
}

impl IncomingTransfers {
    fn attempt_binding(&self, grant: &DestinationGrant) -> Result<String> {
        digest(&(
            "source-transfer.attempt-scope/1",
            &self.store.identity,
            &grant.destination,
            &grant.source,
        ))
    }
    fn attempt_journal(
        &self,
        request: &str,
        source: &TransferAuthority,
    ) -> Result<(PrivateDirectory, DestinationGrant, Option<Journal>)> {
        let (root, _, grant) = self.grant(request)?;
        ensure!(grant.source == *source, "source_transfer_authority_changed");
        let directory = self
            .admission_directory(&root, &grant)?
            .context("source_transfer_recovery_required")?;
        let journal = load::<Journal>(&directory, "attempts.json")?;
        if !grant.attempts_required {
            ensure!(
                grant.attempts.is_none() && journal.is_none(),
                "source_transfer_recovery_required"
            );
            match directory.open_single_link_regular_file(OsStr::new("attempt.lock")) {
                Err(error) if missing(&error) => {}
                _ => anyhow::bail!("source_transfer_recovery_required"),
            }
            return Ok((directory, grant, None));
        }
        let birth = grant
            .attempts
            .as_ref()
            .context("source_transfer_recovery_required")?;
        valid_uuid(&birth.id)?;
        let journal = journal.context("source_transfer_recovery_required")?;
        ensure!(
            journal.version == 1
                && journal.birth == birth.id
                && journal.request_id == request
                && journal.binding_digest == self.attempt_binding(&grant)?
                && journal
                    .selection_digest
                    .as_ref()
                    .is_none_or(|v| valid_sha(v))
                && journal.attempts.len() <= MAX_ATTEMPTS,
            "source_transfer_attempt_changed"
        );
        let mut ids = std::collections::BTreeSet::new();
        for entry in &journal.attempts {
            entry.validate()?;
            ensure!(
                ids.insert(&entry.attempt_id)
                    && (entry.kind != TransferAttemptKind::Run
                        || entry.selection_digest == journal.selection_digest),
                "source_transfer_attempt_changed"
            );
        }
        drop(directory.try_existing_portable_lock(
            OsStr::new("attempt.lock"),
            &birth.writer,
            PrivateLeaseMode::Exclusive,
        )?);
        Ok((directory, grant, Some(journal)))
    }
    pub fn read_attempt(
        &self,
        request: &str,
        source: &TransferAuthority,
        attempt_id: Option<&str>,
    ) -> Result<TransferAttemptView> {
        if let Some(id) = attempt_id {
            valid_uuid(id)?;
        }
        let (_, _, grant) = self.grant(request)?;
        ensure!(grant.source == *source, "source_transfer_authority_changed");
        if !grant.admission_required {
            ensure!(
                !grant.attempts_required && grant.attempts.is_none(),
                "source_transfer_recovery_required"
            );
            self.admission_state(request)?;
            return Ok(TransferAttemptView {
                tracked: false,
                binding_digest: self.attempt_binding(&grant)?,
                selection_digest: None,
                attempt: None,
                running: false,
            });
        }
        let (directory, grant, journal) = self.attempt_journal(request, source)?;
        let running = if let Some(birth) = &grant.attempts {
            directory
                .try_existing_portable_lock(
                    OsStr::new("attempt.lock"),
                    &birth.writer,
                    PrivateLeaseMode::Exclusive,
                )?
                .is_none()
        } else {
            false
        };
        Ok(TransferAttemptView {
            tracked: journal.is_some(),
            binding_digest: self.attempt_binding(&grant)?,
            selection_digest: journal.as_ref().and_then(|j| j.selection_digest.clone()),
            attempt: journal.and_then(|j| {
                j.attempts
                    .into_iter()
                    .find(|a| Some(a.attempt_id.as_str()) == attempt_id)
            }),
            running,
        })
    }
    /// None means this exact attempt was already durably accepted. It must never
    /// grant execution a second time, including after every original process died.
    pub fn claim_attempt(
        &self,
        request: &str,
        source: &TransferAuthority,
        entry: &TransferAttemptRecord,
    ) -> Result<Option<TransferAttemptLease>> {
        entry.validate()?;
        let (root, name, _) = self.grant(request)?;
        let _catalog = lease(&root, "grants.lock")?;
        let (_, _, mut grant) = self.grant(request)?;
        ensure!(grant.source == *source, "source_transfer_authority_changed");
        self.ensure_admission(&root, &name, &mut grant)?;
        let directory = self
            .admission_directory(&root, &grant)?
            .context("source_transfer_recovery_required")?;
        let _controller = operation_lease(&directory, "control.lock")?;
        if !grant.attempts_required {
            self.attempt_journal(request, source)?;
            // Mark required before any new ledger/lock birth. Lost birth is unknown,
            // never permission for a second initialization/admission.
            grant.attempts_required = true;
            save(&root, &name, &grant)?;
            let writer = lease(&directory, "attempt.lock")?;
            let birth = AttemptBirth {
                id: uuid::Uuid::new_v4().to_string(),
                writer: directory.portable_regular_identity(OsStr::new("attempt.lock"))?,
            };
            let journal = Journal {
                version: 1,
                birth: birth.id.clone(),
                request_id: request.into(),
                binding_digest: self.attempt_binding(&grant)?,
                selection_digest: None,
                attempts: Vec::new(),
            };
            exact(&directory, "attempts.json", &journal)?;
            grant.attempts = Some(birth);
            save(&root, &name, &grant)?;
            drop(writer);
        }
        let (_, grant, journal) = self.attempt_journal(request, source)?;
        let mut journal = journal.context("source_transfer_recovery_required")?;
        if let Some(old) = journal
            .attempts
            .iter()
            .find(|old| old.attempt_id == entry.attempt_id)
        {
            ensure!(old == entry, "source_transfer_attempt_conflict");
            return Ok(None);
        }
        if entry.kind == TransferAttemptKind::Run {
            if let Some(old) = &journal.selection_digest {
                ensure!(
                    Some(old) == entry.selection_digest.as_ref(),
                    "source_transfer_request_changed"
                );
            } else {
                journal.selection_digest = entry.selection_digest.clone();
            }
        }
        ensure!(
            journal.attempts.len() < MAX_ATTEMPTS,
            "source_transfer_attempt_limit"
        );
        let birth = grant
            .attempts
            .as_ref()
            .context("source_transfer_recovery_required")?;
        let writer = directory
            .try_existing_portable_lock(
                OsStr::new("attempt.lock"),
                &birth.writer,
                PrivateLeaseMode::Exclusive,
            )?
            .context("source_transfer_attempt_busy")?;
        journal.attempts.push(entry.clone());
        save(&directory, "attempts.json", &journal)?;
        Ok(Some(TransferAttemptLease {
            guard: writer,
            directory,
        }))
    }
}
