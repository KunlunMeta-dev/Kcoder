//! Durable, session-owned asynchronous user questions and their answer outbox.

use crate::{AppState, AppStateLifecycleIdentity, CommittedUserInput};
use anyhow::{Context, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::{Message, async_user_questions::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::MutexGuard;

const LEDGER_FILE: &str = "async-user-questions.json";
const LOCK_FILE: &str = "async-user-questions.lock";
const LEDGER_SCHEMA_VERSION: u32 = 1;
// Keep every full-list response comfortably below the app-server frame limit.
// Writes are rejected before atomic_replace when this durable session budget is
// exhausted, so a failed registration or answer leaves the prior ledger intact.
const MAX_LEDGER_BYTES: usize = 1024 * 1024;
const MAX_DELIVERY_ERROR_BYTES: usize = 2 * 1024;
// Keep enough headroom for a maximum answer, its receipt/outbox metadata, and a
// later delivery transition before acknowledging a new question. An answer's
// JSON payload is capped at 16 KiB; 64 KiB covers that payload, worst-case JSON
// escaping for bounded identifiers, outbox metadata, and its 34 KiB claim reserve.
const PENDING_QUESTION_RESERVE_BYTES: usize = 64 * 1024;
// Each error copy is capped at 2 KiB after JSON encoding; claimId is at most
// 256 bytes (under 1.6 KiB after worst-case escaping); status, a 20-digit
// revision, and JSON structure add under 1 KiB. 32 KiB leaves a wide margin.
const UNFINISHED_OUTBOX_RESERVE_BYTES: usize = 32 * 1024;
// A Ready outbox still needs room to persist its maximally escaped claimId
// before it can use the unfinished-outbox reserve.
const READY_OUTBOX_RESERVE_BYTES: usize = UNFINISHED_OUTBOX_RESERVE_BYTES + 2 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuestionLedger {
    schema_version: u32,
    thread_id: String,
    records: Vec<StoredQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredQuestion {
    source_key: String,
    request_digest: String,
    record: AsyncQuestionRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outbox: Option<StoredOutbox>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredOutbox {
    submission_id: String,
    answer_digest: String,
    message_id: String,
    state: OutboxState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum OutboxState {
    Ready,
    Claimed { claim_id: String },
    Applied { claim_id: String },
    Failed { claim_id: String, error: String },
    Unknown { claim_id: String, error: String },
    Cancelled,
    Stale,
}

impl AppState {
    /// Persist a tool question before acknowledging it. The session and tool-call
    /// identity, rather than question text, define idempotent registration.
    pub fn register_async_question(
        &self,
        owner: &AppStateLifecycleIdentity,
        request: AsyncQuestionRequest,
    ) -> anyhow::Result<AsyncQuestionAccepted> {
        request.validate().map_err(anyhow::Error::msg)?;
        let request_bytes = serde_json::to_vec(&request)?;
        ensure!(
            request_bytes.len() <= ASYNC_QUESTION_MAX_REQUEST_BYTES,
            "async question request exceeds its serialized size limit"
        );
        let request_digest = digest_hex(&request_bytes);
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;

        let source_key = stable_id(
            "async-question-source-v1",
            &[&thread_id, &request.source_turn_id, &request.tool_call_id],
        )?;
        if let Some(existing) = ledger
            .records
            .iter()
            .find(|record| record.source_key == source_key)
        {
            ensure!(
                existing.request_digest == request_digest,
                "async question tool-call identity was reused with different content"
            );
            return Ok(AsyncQuestionAccepted {
                accepted: true,
                question: existing.record.clone(),
            });
        }
        ensure!(
            ledger.records.len() < ASYNC_QUESTION_MAX_RECORDS,
            "session async question limit reached"
        );

        let request_id = stable_id(
            "async-question-request-v1",
            &[&thread_id, &request.source_turn_id, &request.tool_call_id],
        )?;
        let question_id = stable_id("async-question-v1", &[&request_id])?;
        let questions = request
            .questions
            .iter()
            .enumerate()
            .map(|(item_index, draft)| {
                let id = stable_id(
                    "async-question-item-v1",
                    &[&question_id, &item_index.to_string()],
                )?;
                let options = draft
                    .options
                    .iter()
                    .enumerate()
                    .map(|(option_index, option)| {
                        Ok(AsyncQuestionOption {
                            id: stable_id(
                                "async-question-option-v1",
                                &[
                                    &question_id,
                                    &item_index.to_string(),
                                    &option_index.to_string(),
                                ],
                            )?,
                            label: option.label.clone(),
                            description: option.description.clone(),
                        })
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?;
                Ok(AsyncQuestionItem {
                    id,
                    header: draft.header.clone(),
                    question: draft.question.clone(),
                    options,
                    multi_select: draft.multi_select,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let record = AsyncQuestionRecord {
            question_id,
            request_id,
            thread_id: thread_id.clone(),
            source_turn_id: request.source_turn_id,
            tool_call_id: request.tool_call_id,
            revision: 1,
            created_at_ms: crate::now_millis(),
            status: AsyncQuestionStatus::Pending,
            questions,
            answer: None,
            delivery_error: None,
        };
        ledger.records.push(StoredQuestion {
            source_key,
            request_digest,
            record: record.clone(),
            outbox: None,
        });
        write_ledger(&directory, &ledger)?;
        Ok(AsyncQuestionAccepted {
            accepted: true,
            question: record,
        })
    }

    /// Read durable questions from this exact live session owner.
    pub fn list_async_questions(
        &self,
        owner: &AppStateLifecycleIdentity,
        include_terminal: bool,
    ) -> anyhow::Result<Vec<AsyncQuestionRecord>> {
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let ledger = read_ledger(&directory, &thread_id)?;
        Ok(ledger
            .records
            .into_iter()
            .map(|stored| stored.record)
            .filter(|record| include_terminal || !is_terminal(record.status))
            .collect())
    }

    /// Save the first valid answer and its outbox atomically. Exact submission
    /// retries return the authoritative first receipt; a competing valid answer
    /// receives that same authority without replacing it.
    pub fn answer_async_question(
        &self,
        owner: &AppStateLifecycleIdentity,
        question_id: &str,
        expected_revision: u64,
        submission_id: &str,
        answers: BTreeMap<String, AsyncQuestionAnswerValue>,
    ) -> anyhow::Result<AsyncQuestionAnswerReceipt> {
        ensure_identifier(submission_id, "submissionId")?;
        ensure!(expected_revision > 0, "expected revision must be positive");
        let answer = AsyncQuestionAnswerRecord {
            submission_id: submission_id.to_owned(),
            answers,
            accepted_at_ms: crate::now_millis(),
        };
        validate_answer(&answer)?;
        let answer_digest = digest_hex(&serde_json::to_vec(&answer.answers)?);

        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;
        let stored = find_question_mut(&mut ledger, question_id)?;

        if let Some(winner) = stored.record.answer.as_ref() {
            let exact_retry = winner.submission_id == submission_id
                && stored
                    .outbox
                    .as_ref()
                    .is_some_and(|outbox| outbox.answer_digest == answer_digest);
            return Ok(AsyncQuestionAnswerReceipt {
                accepted: exact_retry,
                duplicate: exact_retry,
                question: stored.record.clone(),
            });
        }
        ensure!(
            !matches!(
                stored.record.status,
                AsyncQuestionStatus::Cancelled | AsyncQuestionStatus::Stale
            ),
            "async question is no longer answerable"
        );
        ensure!(
            stored.record.status == AsyncQuestionStatus::Pending,
            "async question cannot accept an answer in its current state"
        );
        ensure!(
            expected_revision == stored.record.revision,
            "async question revision changed; reload before answering"
        );
        ensure_answer_matches_items(&stored.record, &answer)?;

        let message_id = stable_uuid(
            "async-question-answer-message-v1",
            &[&thread_id, question_id, submission_id],
        )?;
        stored.record.answer = Some(answer);
        stored.record.status = AsyncQuestionStatus::Queued;
        advance_revision(&mut stored.record)?;
        stored.record.delivery_error = None;
        stored.outbox = Some(StoredOutbox {
            submission_id: submission_id.to_owned(),
            answer_digest,
            message_id,
            state: OutboxState::Ready,
        });
        let record = stored.record.clone();
        write_ledger(&directory, &ledger)?;
        Ok(AsyncQuestionAnswerReceipt {
            accepted: true,
            duplicate: false,
            question: record,
        })
    }

    /// Withdraw a pending question or an unclaimed queued answer. Claimed and
    /// uncertain deliveries cannot be withdrawn because a history commit may
    /// already be in progress.
    pub fn cancel_async_question(
        &self,
        owner: &AppStateLifecycleIdentity,
        question_id: &str,
        expected_revision: u64,
    ) -> anyhow::Result<AsyncQuestionRecord> {
        ensure!(expected_revision > 0, "expected revision must be positive");
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;
        let stored = find_question_mut(&mut ledger, question_id)?;
        if stored.record.status == AsyncQuestionStatus::Cancelled {
            return Ok(stored.record.clone());
        }
        ensure!(
            matches!(
                stored.record.status,
                AsyncQuestionStatus::Pending | AsyncQuestionStatus::Queued
            ),
            "async question delivery is in-flight or terminal and cannot be withdrawn"
        );
        if let Some(outbox) = stored.outbox.as_ref() {
            ensure!(
                matches!(outbox.state, OutboxState::Ready),
                "async question delivery is in-flight or has an unknown result"
            );
        }
        ensure!(
            stored.record.revision == expected_revision,
            "async question revision changed; reload before cancelling"
        );
        stored.record.status = AsyncQuestionStatus::Cancelled;
        advance_revision(&mut stored.record)?;
        stored.record.delivery_error = None;
        if let Some(outbox) = stored.outbox.as_mut() {
            outbox.state = OutboxState::Cancelled;
        }
        let record = stored.record.clone();
        write_ledger(&directory, &ledger)?;
        Ok(record)
    }

    /// Mark outstanding questions from a stopped source turn stale so a late
    /// answer or queued delivery cannot automatically resume it.
    pub fn mark_async_questions_stale_for_turn(
        &self,
        owner: &AppStateLifecycleIdentity,
        source_turn_id: &str,
    ) -> anyhow::Result<Vec<AsyncQuestionRecord>> {
        ensure_identifier(source_turn_id, "sourceTurnId")?;
        self.mark_async_questions_stale_matching(owner, |record| {
            record.source_turn_id == source_turn_id
        })
    }

    /// Mark all unconsumed questions in this persistent task stale after an
    /// explicit user interrupt, including questions from earlier source turns.
    pub fn mark_async_questions_stale_for_task(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> anyhow::Result<Vec<AsyncQuestionRecord>> {
        self.mark_async_questions_stale_matching(owner, |_| true)
    }

    fn mark_async_questions_stale_matching<F>(
        &self,
        owner: &AppStateLifecycleIdentity,
        mut matches_record: F,
    ) -> anyhow::Result<Vec<AsyncQuestionRecord>>
    where
        F: FnMut(&AsyncQuestionRecord) -> bool,
    {
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;
        let mut changed = Vec::new();
        for stored in &mut ledger.records {
            if !matches_record(&stored.record)
                || matches!(
                    stored.record.status,
                    AsyncQuestionStatus::Cancelled
                        | AsyncQuestionStatus::Stale
                        | AsyncQuestionStatus::ContextApplied
                )
            {
                continue;
            }
            stored.record.status = AsyncQuestionStatus::Stale;
            advance_revision(&mut stored.record)?;
            stored.record.delivery_error = None;
            if let Some(outbox) = stored.outbox.as_mut() {
                outbox.state = OutboxState::Stale;
            }
            changed.push(stored.record.clone());
        }
        if !changed.is_empty() {
            write_ledger(&directory, &ledger)?;
        }
        Ok(changed)
    }

    /// Atomically reserve a single queued answer for delivery. Repeated claims,
    /// including the same claim ID, return None; use the recovery query to inspect
    /// a persisted claim before reconciling its stable transcript UUID.
    pub fn claim_async_question_delivery(
        &self,
        owner: &AppStateLifecycleIdentity,
        question_id: &str,
        claim_id: &str,
    ) -> anyhow::Result<Option<AsyncQuestionDeliveryClaim>> {
        ensure_identifier(claim_id, "claimId")?;
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;
        let (claim, claimed_now) = {
            let stored = find_question_mut(&mut ledger, question_id)?;
            if stored.record.status != AsyncQuestionStatus::Queued {
                return Ok(None);
            }
            let Some(outbox) = stored.outbox.as_mut() else {
                anyhow::bail!("queued async question has no durable outbox entry");
            };
            let claimed_now = match &outbox.state {
                OutboxState::Ready => {
                    outbox.state = OutboxState::Claimed {
                        claim_id: claim_id.to_owned(),
                    };
                    true
                }
                OutboxState::Claimed { .. }
                | OutboxState::Applied { .. }
                | OutboxState::Failed { .. }
                | OutboxState::Unknown { .. }
                | OutboxState::Cancelled
                | OutboxState::Stale => return Ok(None),
            };
            let outbox = stored
                .outbox
                .as_ref()
                .context("async question outbox disappeared")?;
            let answer = stored
                .record
                .answer
                .as_ref()
                .context("queued async question answer disappeared")?;
            (
                AsyncQuestionDeliveryClaim {
                    question_id: stored.record.question_id.clone(),
                    submission_id: outbox.submission_id.clone(),
                    claim_id: claim_id.to_owned(),
                    message_id: outbox.message_id.clone(),
                    revision: stored.record.revision,
                    message: answer_message(&stored.record, answer)?,
                },
                claimed_now,
            )
        };
        if claimed_now {
            write_ledger(&directory, &ledger)?;
        }
        Ok(Some(claim))
    }

    /// Admit only the exact, still-claimed answer while holding the original
    /// ledger locks. An error means this call admitted no input. The caller must
    /// reconcile any earlier identified input before attempting this operation.
    pub fn try_begin_async_question_delivery(
        &self,
        owner: &AppStateLifecycleIdentity,
        claim: &AsyncQuestionDeliveryClaim,
    ) -> anyhow::Result<crate::UserInputStart> {
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let ledger = read_ledger(&directory, &thread_id)?;
        let stored = find_question(&ledger, &claim.question_id)?;
        let message = expected_claim_message(stored, claim)?;
        ensure!(
            stored.record.status == AsyncQuestionStatus::Queued
                && stored.record.revision == claim.revision
                && stored.outbox.as_ref().is_some_and(|outbox| matches!(
                    &outbox.state,
                    OutboxState::Claimed { claim_id } if claim_id == &claim.claim_id
                )),
            "async question delivery claim is no longer current"
        );
        Ok(self.try_begin_user_input_identified(owner, message, &claim.message_id))
    }

    /// Recover an already persisted claim after a process restart so the
    /// caller can reconcile its stable transcript UUID before retrying anything.
    pub fn get_async_question_delivery_claim(
        &self,
        owner: &AppStateLifecycleIdentity,
        question_id: &str,
    ) -> anyhow::Result<Option<AsyncQuestionDeliveryClaim>> {
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let ledger = read_ledger(&directory, &thread_id)?;
        let stored = find_question(&ledger, question_id)?;
        let Some(outbox) = stored.outbox.as_ref() else {
            return Ok(None);
        };
        let claim_id = match &outbox.state {
            OutboxState::Claimed { claim_id } | OutboxState::Unknown { claim_id, .. } => claim_id,
            _ => return Ok(None),
        };
        let answer = stored
            .record
            .answer
            .as_ref()
            .context("claimed async question answer is missing")?;
        Ok(Some(AsyncQuestionDeliveryClaim {
            question_id: stored.record.question_id.clone(),
            submission_id: outbox.submission_id.clone(),
            claim_id: claim_id.clone(),
            message_id: outbox.message_id.clone(),
            revision: stored.record.revision,
            message: answer_message(&stored.record, answer)?,
        }))
    }

    /// Persist a confirmed transcript delivery only when the original input
    /// writer returned a current durable receipt for this exact stable UUID.
    pub fn mark_async_question_context_applied(
        &self,
        owner: &AppStateLifecycleIdentity,
        claim: &AsyncQuestionDeliveryClaim,
        committed: &CommittedUserInput,
    ) -> anyhow::Result<AsyncQuestionRecord> {
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;
        let (expected_message, previous_revision) = {
            let stored = find_question(&ledger, &claim.question_id)?;
            (
                expected_claim_message(stored, claim)?,
                stored.record.revision,
            )
        };
        ensure!(
            committed.try_is_current_for(self, owner, &claim.message_id, &expected_message)?,
            "async question history receipt is not the current committed outbox input"
        );
        let record =
            finish_delivery_in_ledger(&mut ledger, &thread_id, claim, DeliveryFinish::Applied)?;
        if record.revision != previous_revision {
            write_ledger(&directory, &ledger)?;
        }
        Ok(record)
    }

    /// Record an uncertain handoff. Unknown delivery is never automatically
    /// re-claimed; the stable transcript UUID must be reconciled first.
    pub fn mark_async_question_delivery_unknown(
        &self,
        owner: &AppStateLifecycleIdentity,
        claim: &AsyncQuestionDeliveryClaim,
        error: &str,
    ) -> anyhow::Result<AsyncQuestionRecord> {
        self.finish_delivery(owner, claim, DeliveryFinish::Unknown(bounded_error(error)))
    }

    /// Record a failure only when the caller can prove that no history input
    /// was committed or admitted.
    pub fn mark_async_question_delivery_failed(
        &self,
        owner: &AppStateLifecycleIdentity,
        claim: &AsyncQuestionDeliveryClaim,
        error: &str,
    ) -> anyhow::Result<AsyncQuestionRecord> {
        self.finish_delivery(owner, claim, DeliveryFinish::Failed(bounded_error(error)))
    }

    /// Reconcile an unknown handoff after the identified-history bridge found
    /// the stable message in the transcript and returned its durable witness.
    pub fn reconcile_async_question_context_applied(
        &self,
        owner: &AppStateLifecycleIdentity,
        question_id: &str,
        submission_id: &str,
        committed: &CommittedUserInput,
    ) -> anyhow::Result<AsyncQuestionRecord> {
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;
        let claim = {
            let stored = find_question(&ledger, question_id)?;
            let outbox = stored
                .outbox
                .as_ref()
                .context("async question outbox is missing")?;
            ensure!(
                outbox.submission_id == submission_id,
                "async question submission changed"
            );
            let claim_id = match &outbox.state {
                OutboxState::Claimed { claim_id }
                | OutboxState::Unknown { claim_id, .. }
                | OutboxState::Applied { claim_id } => claim_id.clone(),
                _ => anyhow::bail!("async question outbox is not eligible for reconciliation"),
            };
            AsyncQuestionDeliveryClaim {
                question_id: stored.record.question_id.clone(),
                submission_id: outbox.submission_id.clone(),
                claim_id,
                message_id: outbox.message_id.clone(),
                revision: stored.record.revision,
                message: answer_message(
                    &stored.record,
                    stored
                        .record
                        .answer
                        .as_ref()
                        .context("outbox answer is missing")?,
                )?,
            }
        };
        let expected_message =
            expected_claim_message(find_question(&ledger, question_id)?, &claim)?;
        ensure!(
            committed.try_is_current_for(self, owner, &claim.message_id, &expected_message)?,
            "async question history receipt does not match the durable outbox input"
        );
        let previous_revision = claim.revision;
        let record = finish_delivery_in_ledger(
            &mut ledger,
            &thread_id,
            &claim,
            DeliveryFinish::ReconciledApplied,
        )?;
        if record.revision != previous_revision {
            write_ledger(&directory, &ledger)?;
        }
        Ok(record)
    }

    fn finish_delivery(
        &self,
        owner: &AppStateLifecycleIdentity,
        claim: &AsyncQuestionDeliveryClaim,
        finish: DeliveryFinish,
    ) -> anyhow::Result<AsyncQuestionRecord> {
        let (directory, thread_id, _state_lock, _process_lock) =
            self.open_question_ledger(owner)?;
        let mut ledger = read_ledger(&directory, &thread_id)?;
        let previous = find_question(&ledger, &claim.question_id)?.record.revision;
        let record = finish_delivery_in_ledger(&mut ledger, &thread_id, claim, finish)?;
        // Idempotent reconciliation is a read, not another durable mutation.
        if record.revision != previous {
            write_ledger(&directory, &ledger)?;
        }
        Ok(record)
    }

    fn open_question_ledger(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> anyhow::Result<(PrivateDirectory, String, MutexGuard<'_, ()>, File)> {
        let state_lock = self.lock_session_state_persistence();
        let (state_path, thread_id) = self.capture_question_owner(owner)?;
        let parent = state_path
            .parent()
            .context("session state path has no parent directory")?;
        let directory = PrivateDirectory::open_existing(parent)
            .context("cannot safely open the session question directory")?;
        let process_lock = directory
            .try_exclusive_lock(OsStr::new(LOCK_FILE))?
            .context("async question ledger is busy in another process")?;
        let (current_path, current_thread_id) = self.capture_question_owner(owner)?;
        ensure!(
            current_path == state_path && current_thread_id == thread_id,
            "async question session changed while opening its ledger"
        );
        Ok((directory, thread_id, state_lock, process_lock))
    }

    fn capture_question_owner(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> anyhow::Result<(PathBuf, String)> {
        let inner = match self.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => anyhow::bail!("session state is busy"),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("session state is unavailable")
            }
        };
        ensure!(
            owner.matches_locked(self, &inner),
            "async question owner lifecycle changed"
        );
        let path = inner
            .session_state_path
            .clone()
            .context("async questions require a persistent session state path")?;
        ensure!(path.is_absolute(), "session state path must be absolute");
        Ok((path, inner.session_id.clone()))
    }
}

enum DeliveryFinish {
    Applied,
    ReconciledApplied,
    Failed(String),
    Unknown(String),
}

fn finish_delivery_in_ledger(
    ledger: &mut QuestionLedger,
    thread_id: &str,
    claim: &AsyncQuestionDeliveryClaim,
    finish: DeliveryFinish,
) -> anyhow::Result<AsyncQuestionRecord> {
    let stored = find_question_mut(ledger, &claim.question_id)?;
    ensure!(
        stored.record.thread_id == thread_id,
        "async question session owner changed"
    );
    let outbox = stored
        .outbox
        .as_mut()
        .context("async question outbox is missing")?;
    ensure!(
        outbox.submission_id == claim.submission_id && outbox.message_id == claim.message_id,
        "async question outbox identity changed"
    );

    let already_finished = match (&finish, &outbox.state, stored.record.status) {
        (
            DeliveryFinish::Applied,
            OutboxState::Applied { claim_id },
            AsyncQuestionStatus::ContextApplied,
        )
        | (
            DeliveryFinish::ReconciledApplied,
            OutboxState::Applied { claim_id },
            AsyncQuestionStatus::ContextApplied,
        ) if claim_id == &claim.claim_id => true,
        (
            DeliveryFinish::Failed(_),
            OutboxState::Failed { claim_id, .. },
            AsyncQuestionStatus::DeliveryFailed,
        )
        | (
            DeliveryFinish::Unknown(_),
            OutboxState::Unknown { claim_id, .. },
            AsyncQuestionStatus::DeliveryUnknown,
        ) if claim_id == &claim.claim_id => true,
        _ => false,
    };
    if already_finished {
        return Ok(stored.record.clone());
    }
    let reconciled_unknown = matches!(&finish, DeliveryFinish::ReconciledApplied)
        && stored.record.status == AsyncQuestionStatus::DeliveryUnknown;
    ensure!(
        stored.record.status == AsyncQuestionStatus::Queued || reconciled_unknown,
        "async question is no longer eligible for delivery"
    );
    ensure!(
        stored.record.revision == claim.revision,
        "async question claim revision changed"
    );
    let current_claim_matches = matches!(
        &outbox.state,
        OutboxState::Claimed { claim_id } if claim_id == &claim.claim_id
    );
    let unknown_reconciliation_matches = matches!(
        (&outbox.state, &finish),
        (OutboxState::Unknown { claim_id, .. }, DeliveryFinish::ReconciledApplied)
            if claim_id == &claim.claim_id
    );
    ensure!(
        current_claim_matches || unknown_reconciliation_matches,
        "async question claim is no longer current"
    );

    match finish {
        DeliveryFinish::Applied | DeliveryFinish::ReconciledApplied => {
            outbox.state = OutboxState::Applied {
                claim_id: claim.claim_id.clone(),
            };
            stored.record.status = AsyncQuestionStatus::ContextApplied;
            stored.record.delivery_error = None;
        }
        DeliveryFinish::Failed(error) => {
            outbox.state = OutboxState::Failed {
                claim_id: claim.claim_id.clone(),
                error: error.clone(),
            };
            stored.record.status = AsyncQuestionStatus::DeliveryFailed;
            stored.record.delivery_error = Some(error);
        }
        DeliveryFinish::Unknown(error) => {
            outbox.state = OutboxState::Unknown {
                claim_id: claim.claim_id.clone(),
                error: error.clone(),
            };
            stored.record.status = AsyncQuestionStatus::DeliveryUnknown;
            stored.record.delivery_error = Some(error);
        }
    }
    advance_revision(&mut stored.record)?;
    Ok(stored.record.clone())
}

fn expected_claim_message(
    stored: &StoredQuestion,
    claim: &AsyncQuestionDeliveryClaim,
) -> anyhow::Result<Message> {
    ensure!(
        stored.record.question_id == claim.question_id,
        "async question claim owner mismatch"
    );
    let outbox = stored
        .outbox
        .as_ref()
        .context("async question outbox is missing")?;
    ensure!(
        outbox.submission_id == claim.submission_id && outbox.message_id == claim.message_id,
        "async question claim identity changed"
    );
    let message = answer_message(
        &stored.record,
        stored
            .record
            .answer
            .as_ref()
            .context("async question answer is missing")?,
    )?;
    ensure!(
        claim.message == message,
        "async question claim message was modified"
    );
    Ok(message)
}

fn read_ledger(directory: &PrivateDirectory, thread_id: &str) -> anyhow::Result<QuestionLedger> {
    let file = match directory.open_single_link_regular_file(OsStr::new(LEDGER_FILE)) {
        Ok(file) => file,
        Err(error) if error_is_not_found(&error) => {
            return Ok(QuestionLedger {
                schema_version: LEDGER_SCHEMA_VERSION,
                thread_id: thread_id.to_owned(),
                records: Vec::new(),
            });
        }
        Err(error) => return Err(error).context("cannot safely read async question ledger"),
    };
    let length = file.metadata()?.len();
    ensure!(
        length <= MAX_LEDGER_BYTES as u64,
        "async question ledger exceeds its size limit"
    );
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_LEDGER_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_LEDGER_BYTES,
        "async question ledger exceeds its size limit"
    );
    let ledger: QuestionLedger =
        serde_json::from_slice(&bytes).context("async question ledger is invalid")?;
    ensure!(
        ledger.schema_version == LEDGER_SCHEMA_VERSION,
        "unsupported async question ledger schema"
    );
    ensure!(
        ledger.thread_id == thread_id,
        "async question ledger belongs to a different session"
    );
    ensure!(
        ledger.records.len() <= ASYNC_QUESTION_MAX_RECORDS,
        "async question ledger record count exceeds its limit"
    );
    let mut question_ids = BTreeSet::new();
    let mut source_keys = BTreeSet::new();
    for stored in &ledger.records {
        ensure!(
            stored.record.thread_id == thread_id,
            "async question record session owner mismatch"
        );
        ensure!(
            question_ids.insert(stored.record.question_id.as_str()),
            "async question ledger contains a duplicate question id"
        );
        ensure!(
            source_keys.insert(stored.source_key.as_str()),
            "async question ledger contains a duplicate tool-call identity"
        );
        validate_stored_question(thread_id, stored)?;
    }
    ensure_ledger_budget(&ledger, bytes.len())?;
    Ok(ledger)
}

fn validate_stored_question(thread_id: &str, stored: &StoredQuestion) -> anyhow::Result<()> {
    let record = &stored.record;
    ensure!(record.revision > 0, "async question revision is invalid");
    let source_key = stable_id(
        "async-question-source-v1",
        &[thread_id, &record.source_turn_id, &record.tool_call_id],
    )?;
    ensure!(
        stored.source_key == source_key,
        "async question source identity is invalid"
    );
    ensure!(
        record.request_id
            == stable_id(
                "async-question-request-v1",
                &[thread_id, &record.source_turn_id, &record.tool_call_id],
            )?,
        "async question request identity is invalid"
    );
    ensure!(
        record.question_id == stable_id("async-question-v1", &[&record.request_id])?,
        "async question id is invalid"
    );
    ensure!(
        !record.questions.is_empty() && record.questions.len() <= ASYNC_QUESTION_MAX_ITEMS,
        "async question item count is invalid"
    );
    for (item_index, item) in record.questions.iter().enumerate() {
        ensure!(
            item.id
                == stable_id(
                    "async-question-item-v1",
                    &[&record.question_id, &item_index.to_string()],
                )?,
            "async question item id is invalid"
        );
        ensure!(
            item.options.len() <= ASYNC_QUESTION_MAX_OPTIONS,
            "async question option count exceeds its limit"
        );
        for (option_index, option) in item.options.iter().enumerate() {
            ensure!(
                option.id
                    == stable_id(
                        "async-question-option-v1",
                        &[
                            &record.question_id,
                            &item_index.to_string(),
                            &option_index.to_string(),
                        ],
                    )?,
                "async question option id is invalid"
            );
        }
    }

    let reconstructed_request = AsyncQuestionRequest {
        source_turn_id: record.source_turn_id.clone(),
        tool_call_id: record.tool_call_id.clone(),
        questions: record
            .questions
            .iter()
            .map(|item| AsyncQuestionItemDraft {
                header: item.header.clone(),
                question: item.question.clone(),
                options: item
                    .options
                    .iter()
                    .map(|option| AsyncQuestionOptionDraft {
                        label: option.label.clone(),
                        description: option.description.clone(),
                    })
                    .collect(),
                multi_select: item.multi_select,
            })
            .collect(),
    };
    reconstructed_request
        .validate()
        .map_err(anyhow::Error::msg)?;
    let request_bytes = serde_json::to_vec(&reconstructed_request)?;
    ensure!(
        request_bytes.len() <= ASYNC_QUESTION_MAX_REQUEST_BYTES,
        "async question request exceeds its serialized size limit"
    );
    let request_digest = digest_hex(&request_bytes);
    ensure!(
        stored.request_digest == request_digest,
        "async question request content digest is invalid"
    );

    let Some(answer) = record.answer.as_ref() else {
        ensure!(
            stored.outbox.is_none(),
            "async question without an answer has an outbox entry"
        );
        ensure!(
            record.delivery_error.is_none(),
            "unanswered async question has a delivery error"
        );
        ensure!(
            matches!(
                record.status,
                AsyncQuestionStatus::Pending
                    | AsyncQuestionStatus::Cancelled
                    | AsyncQuestionStatus::Stale
            ),
            "async question status requires a durable answer"
        );
        return Ok(());
    };
    validate_answer(answer)?;
    ensure_answer_matches_items(record, answer)?;
    let outbox = stored
        .outbox
        .as_ref()
        .context("answered async question has no durable outbox entry")?;
    ensure!(
        outbox.submission_id == answer.submission_id,
        "async question outbox submission identity is invalid"
    );
    ensure!(
        outbox.answer_digest == digest_hex(&serde_json::to_vec(&answer.answers)?),
        "async question answer digest is invalid"
    );
    ensure!(
        outbox.message_id
            == stable_uuid(
                "async-question-answer-message-v1",
                &[thread_id, &record.question_id, &answer.submission_id],
            )?,
        "async question outbox message identity is invalid"
    );
    let state_matches_status = matches!(
        (&record.status, &outbox.state),
        (
            AsyncQuestionStatus::Queued,
            OutboxState::Ready | OutboxState::Claimed { .. }
        ) | (
            AsyncQuestionStatus::ContextApplied,
            OutboxState::Applied { .. }
        ) | (
            AsyncQuestionStatus::DeliveryFailed,
            OutboxState::Failed { .. }
        ) | (
            AsyncQuestionStatus::DeliveryUnknown,
            OutboxState::Unknown { .. }
        ) | (AsyncQuestionStatus::Cancelled, OutboxState::Cancelled)
            | (AsyncQuestionStatus::Stale, OutboxState::Stale)
    );
    ensure!(
        state_matches_status,
        "async question status and outbox state disagree"
    );
    match (&record.status, &outbox.state) {
        (AsyncQuestionStatus::DeliveryFailed, OutboxState::Failed { claim_id, error })
        | (AsyncQuestionStatus::DeliveryUnknown, OutboxState::Unknown { claim_id, error }) => {
            ensure_identifier(claim_id, "claimId")?;
            validate_delivery_error(error)?;
            ensure!(
                record.delivery_error.as_deref() == Some(error),
                "async question delivery error receipt disagrees with its outbox"
            );
        }
        (AsyncQuestionStatus::Queued, OutboxState::Claimed { claim_id })
        | (AsyncQuestionStatus::ContextApplied, OutboxState::Applied { claim_id }) => {
            ensure_identifier(claim_id, "claimId")?;
            ensure!(
                record.delivery_error.is_none(),
                "async question has an unexpected delivery error"
            );
        }
        (_, OutboxState::Failed { claim_id, error }) => {
            ensure_identifier(claim_id, "claimId")?;
            validate_delivery_error(error)?;
            ensure!(
                record.delivery_error.is_none(),
                "async question has an unexpected delivery error"
            );
        }
        (_, OutboxState::Unknown { claim_id, error }) => {
            ensure_identifier(claim_id, "claimId")?;
            validate_delivery_error(error)?;
            ensure!(
                record.delivery_error.is_none(),
                "async question has an unexpected delivery error"
            );
        }
        (_, OutboxState::Applied { claim_id }) | (_, OutboxState::Claimed { claim_id }) => {
            ensure_identifier(claim_id, "claimId")?;
            ensure!(
                record.delivery_error.is_none(),
                "async question has an unexpected delivery error"
            );
        }
        _ => ensure!(
            record.delivery_error.is_none(),
            "async question has an unexpected delivery error"
        ),
    }
    Ok(())
}

fn write_ledger(directory: &PrivateDirectory, ledger: &QuestionLedger) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec(ledger)?;
    ensure_ledger_budget(ledger, bytes.len())?;
    directory.atomic_replace(OsStr::new(LEDGER_FILE), &bytes)?;
    Ok(())
}

fn ensure_ledger_budget(ledger: &QuestionLedger, serialized_bytes: usize) -> anyhow::Result<()> {
    let reserved_bytes = ledger_transition_reserve(ledger)?;
    let committed_and_reserved = serialized_bytes
        .checked_add(reserved_bytes)
        .context("async question ledger budget overflow")?;
    ensure!(
        committed_and_reserved <= MAX_LEDGER_BYTES,
        "async question ledger size plus reserved answer/delivery capacity exceeds its limit"
    );
    Ok(())
}

fn ledger_transition_reserve(ledger: &QuestionLedger) -> anyhow::Result<usize> {
    ledger.records.iter().try_fold(0usize, |reserved, stored| {
        let additional = match (&stored.record.status, stored.outbox.as_ref()) {
            (AsyncQuestionStatus::Pending, None) => PENDING_QUESTION_RESERVE_BYTES,
            (
                AsyncQuestionStatus::Queued,
                Some(StoredOutbox {
                    state: OutboxState::Ready,
                    ..
                }),
            ) => READY_OUTBOX_RESERVE_BYTES,
            (
                AsyncQuestionStatus::Queued,
                Some(StoredOutbox {
                    state: OutboxState::Claimed { .. },
                    ..
                }),
            ) => UNFINISHED_OUTBOX_RESERVE_BYTES,
            // Unknown/failed contain the bounded error receipt and can only
            // reconcile to an Applied state that removes those error fields.
            _ => 0,
        };
        reserved
            .checked_add(additional)
            .context("async question transition reserve overflow")
    })
}

fn find_question_mut<'a>(
    ledger: &'a mut QuestionLedger,
    question_id: &str,
) -> anyhow::Result<&'a mut StoredQuestion> {
    ledger
        .records
        .iter_mut()
        .find(|stored| stored.record.question_id == question_id)
        .context("async question was not found in this session")
}

fn find_question<'a>(
    ledger: &'a QuestionLedger,
    question_id: &str,
) -> anyhow::Result<&'a StoredQuestion> {
    ledger
        .records
        .iter()
        .find(|stored| stored.record.question_id == question_id)
        .context("async question was not found in this session")
}

fn validate_answer(answer: &AsyncQuestionAnswerRecord) -> anyhow::Result<()> {
    ensure_identifier(&answer.submission_id, "submissionId")?;
    ensure!(
        !answer.answers.is_empty() && answer.answers.len() <= ASYNC_QUESTION_MAX_ITEMS,
        "async answer item count is invalid"
    );
    let serialized = serde_json::to_vec(&answer.answers)?;
    ensure!(
        serialized.len() <= ASYNC_QUESTION_MAX_ANSWER_BYTES,
        "async answer exceeds its size limit"
    );
    for (item_id, value) in &answer.answers {
        ensure_identifier(item_id, "itemId")?;
        ensure!(
            value.selected_option_ids.len() <= ASYNC_QUESTION_MAX_OPTIONS,
            "too many selected options"
        );
        let mut selected = std::collections::BTreeSet::new();
        for option_id in &value.selected_option_ids {
            ensure_identifier(option_id, "optionId")?;
            ensure!(selected.insert(option_id), "duplicate selected option id");
        }
        if let Some(text) = value.text.as_deref() {
            ensure!(
                text.len() <= ASYNC_QUESTION_MAX_ANSWER_BYTES,
                "answer text exceeds its size limit"
            );
        }
    }
    Ok(())
}

fn ensure_answer_matches_items(
    record: &AsyncQuestionRecord,
    answer: &AsyncQuestionAnswerRecord,
) -> anyhow::Result<()> {
    ensure!(
        answer.answers.len() == record.questions.len(),
        "answer must include every question item exactly once"
    );
    for item in &record.questions {
        let value = answer
            .answers
            .get(&item.id)
            .context("answer contains a missing question item")?;
        ensure!(
            value.selected_option_ids.len() <= item.options.len(),
            "answer has too many selected options"
        );
        ensure!(
            item.multi_select || value.selected_option_ids.len() <= 1,
            "single-select question accepts at most one option"
        );
        for option_id in &value.selected_option_ids {
            ensure!(
                item.options.iter().any(|option| option.id == *option_id),
                "answer contains an unknown option id"
            );
        }
        let has_text = value
            .text
            .as_ref()
            .is_some_and(|text| !text.trim().is_empty());
        ensure!(
            !value.selected_option_ids.is_empty() || has_text,
            "each answer must select an option or include text"
        );
    }
    Ok(())
}

fn answer_message(
    record: &AsyncQuestionRecord,
    answer: &AsyncQuestionAnswerRecord,
) -> anyhow::Result<Message> {
    let mut text = String::from("Answers to your questions:\n");
    for item in &record.questions {
        let value = answer
            .answers
            .get(&item.id)
            .context("durable answer item is missing")?;
        text.push('\n');
        text.push_str(&item.header);
        text.push_str(": ");
        text.push_str(&item.question);
        text.push_str("\nAnswer: ");
        let mut first = true;
        for option_id in &value.selected_option_ids {
            let option = item
                .options
                .iter()
                .find(|option| option.id == *option_id)
                .context("durable answer references an unknown option")?;
            if !first {
                text.push_str(", ");
            }
            text.push_str(&option.label);
            first = false;
        }
        if let Some(free_text) = value.text.as_deref().filter(|text| !text.trim().is_empty()) {
            if !first {
                text.push_str("; ");
            }
            text.push_str(free_text);
        }
        text.push('\n');
    }
    Ok(Message::user_text(text))
}

fn is_terminal(status: AsyncQuestionStatus) -> bool {
    matches!(
        status,
        AsyncQuestionStatus::ContextApplied
            | AsyncQuestionStatus::DeliveryFailed
            | AsyncQuestionStatus::Cancelled
            | AsyncQuestionStatus::Stale
    )
}

fn ensure_identifier(value: &str, name: &str) -> anyhow::Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= 256,
        "{name} is invalid"
    );
    Ok(())
}

fn bounded_error(value: &str) -> String {
    let mut bounded = String::new();
    for character in value.chars() {
        bounded.push(character);
        if serde_json::to_vec(&bounded)
            .is_ok_and(|serialized| serialized.len() <= MAX_DELIVERY_ERROR_BYTES)
        {
            continue;
        }
        bounded.pop();
        break;
    }
    bounded
}

fn validate_delivery_error(value: &str) -> anyhow::Result<()> {
    ensure!(
        serde_json::to_vec(value)?.len() <= MAX_DELIVERY_ERROR_BYTES,
        "async question delivery error exceeds its serialized size limit"
    );
    Ok(())
}

fn advance_revision(record: &mut AsyncQuestionRecord) -> anyhow::Result<()> {
    record.revision = record
        .revision
        .checked_add(1)
        .context("async question revision exhausted")?;
    Ok(())
}

fn stable_id(domain: &str, parts: &[&str]) -> anyhow::Result<String> {
    let encoded = serde_json::to_vec(&(domain, parts))?;
    Ok(format!("aq_{}", digest_hex(&encoded)))
}

fn stable_uuid(domain: &str, parts: &[&str]) -> anyhow::Result<String> {
    let encoded = serde_json::to_vec(&(domain, parts))?;
    let digest = Sha256::digest(&encoded);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn error_is_not_found(error: &anyhow::Error) -> bool {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

#[cfg(test)]
#[path = "async_user_questions/tests.rs"]
mod tests;
