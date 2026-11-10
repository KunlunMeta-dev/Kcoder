//! Trusted turn adapter over the existing receipt and Accepted-attempt journals.
//! It never advertises capability and never invents authority from public params.
use crate::thread_history::thread_history_path;
use crate::turn_artifacts::save_turn_outcome_with_continuation;
use crate::{turn_admissions, turn_attempts};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::TurnStartParams;
use kcoder_attachment_retention::{OwnerLease, RetentionFailure, RetentionService};
use kcoder_attachment_retention::{model::Scope, transfer::TransferRequest};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus, TurnRetainedInputV1};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Copy)]
pub struct Authority<'a> {
    pub service: &'a RetentionService,
    pub scope: &'a Scope,
}

pub struct Prepared<'a> {
    authority: Authority<'a>,
    request: TransferRequest,
    leases: Vec<OwnerLease>,
    parent: PrivateDirectory,
    pub input: TurnRetainedInputV1,
    pub prompt: String,
    pub model_message: kcoder_types::Message,
}

pub enum Preparation<'a> {
    Fresh(Box<Prepared<'a>>),
    Receipt(Value),
}

fn receipt(identity: &TurnAttemptIdentity, status: &str) -> Value {
    json!({"turn": {"id": identity.turn_id, "threadId": identity.thread_id,
        "attemptId": identity.attempt_id, "status": status}})
}

/// Call only while holding this resident's execution registration and SessionLease.
/// A failed durable terminal write is Unknown; it never authorizes dispatch.
pub fn interrupt_unstarted(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    reason: &str,
) -> Result<()> {
    // Attempt first: this is the authoritative acceptance/terminal record.
    turn_attempts::finish(
        engine,
        identity,
        "interrupted",
        Some(reason),
        None,
        &turn_attempts::PartialOutput::default(),
    )?;
    save_turn_outcome_with_continuation(
        engine,
        &identity.thread_id,
        &identity.turn_id,
        "interrupted",
        Some(reason),
        None,
        false,
    )?;
    Ok(())
}

/// A determinate rejection can settle the original Accepted attempt. An
/// uncertain handoff keeps the original identity recoverable.
pub fn reject_foreground_handoff(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    error: &anyhow::Error,
) -> &'static str {
    let determinate = matches!(
        error.downcast_ref::<RetentionFailure>(),
        Some(RetentionFailure::Conflict | RetentionFailure::ProofUnavailable)
    );
    if determinate
        && interrupt_unstarted(
            engine,
            identity,
            "retained handoff rejected before execution",
        )
        .is_ok()
    {
        "interrupted"
    } else {
        "unknown"
    }
}

/// Before background activation, the caller owns the newly acquired SessionLease
/// and has not constructed/spawned a ThreadRuntime. Receipt reads never call this.
///
/// No turn of this thread can still be running here. A retained input that
/// never started is interrupted. A started turn whose process exited keeps its
/// authoritative Accepted attempt, which reads back as `unknown`: its tool
/// side effects may or may not have happened, so no terminal is fabricated.
/// Returns those turns so the caller can tell the model once.
pub fn recover_unstarted_on_resume(engine: &QueryEngine) -> Result<Vec<String>> {
    let mut exited = Vec::new();
    for record in turn_attempts::records(engine, &engine.session_id())? {
        if record.status != TurnAttemptStatus::Accepted {
            continue;
        }
        if record.retained_input.is_some() {
            interrupt_unstarted(
                engine,
                &record.identity,
                "retained turn interrupted before resident execution was restored",
            )?;
        } else {
            exited.push(record.identity.turn_id.clone());
        }
    }
    Ok(exited)
}

/// Tell the model once what a process exit interrupted, so the next turn
/// (a goal continuation or a user turn) checks before redoing anything.
///
/// Background tasks that session restore marked as interrupted are claimed
/// through their notification marker, so each appears in exactly one notice
/// and never also wakes the thread as an ordinary failed result.
pub async fn append_recovery_notice(
    engine: &QueryEngine,
    interrupted_turns: &[String],
) -> Result<bool> {
    let noticed: Vec<String> = engine
        .state
        .messages()
        .iter()
        .filter_map(|message| match message {
            kcoder_types::Message::User {
                content,
                origin: kcoder_types::MessageOrigin::Runtime,
            } => Some(content),
            _ => None,
        })
        .flat_map(|content| content.iter())
        .filter_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } if text.starts_with(RECOVERY_NOTICE_OPEN) => {
                Some(text.clone())
            }
            _ => None,
        })
        .collect();
    let interrupted_turns: Vec<&String> = interrupted_turns
        .iter()
        .filter(|turn| {
            let mention = format!("Interrupted turn {turn} ");
            !noticed.iter().any(|text| text.contains(&mention))
        })
        .collect();
    let mut tasks: Vec<(String, String)> = engine
        .state
        .tasks()
        .into_values()
        .filter(|task| {
            task.managed
                && task.status == kcoder_state::TaskStatus::Failed
                && task.output.as_deref() == Some(kcoder_state::PROCESS_EXIT_TASK_INTERRUPTION)
        })
        .map(|task| (task.id, task.description))
        .collect();
    tasks.sort();
    // History is the durable record of what the model was told; the claim
    // also keeps a task from waking the thread as an ordinary failed result.
    tasks.retain(|(id, _)| {
        let mention = format!("Interrupted background task {id}:");
        let claimed = engine.state.claim_task_notification_injected(id);
        claimed && !noticed.iter().any(|text| text.contains(&mention))
    });
    if interrupted_turns.is_empty() && tasks.is_empty() {
        return Ok(false);
    }
    engine
        .state
        .add_message(kcoder_types::Message::runtime_text(recovery_notice(
            &interrupted_turns,
            &tasks,
        )));
    engine.state.flush_history().await?;
    Ok(true)
}

const RECOVERY_NOTICE_OPEN: &str = "<recovery_notice reason=\"process_exit\">";

fn recovery_notice(turns: &[&String], tasks: &[(String, String)]) -> String {
    let mut text =
        format!("{RECOVERY_NOTICE_OPEN}\nThe KCoder process exited while work was in progress.");
    for turn in turns {
        text.push_str(&format!(
            "\nInterrupted turn {turn} (outcome unknown; its last tool call may or may not have run)."
        ));
    }
    for (id, description) in tasks {
        let description: String = description.chars().take(200).collect();
        text.push_str(&format!(
            "\nInterrupted background task {id}: {}",
            description.replace(['\n', '\r'], " ")
        ));
    }
    text.push_str(
        "\nTheir outcome is unknown: they neither succeeded nor failed, and nothing was replayed. \
Before continuing, inspect the working directory, git status and any remote state. \
Do not repeat an external action (push, publish, send, deploy) that may already have happened; \
re-run only what is still needed.\n</recovery_notice>",
    );
    text
}

fn references_match(input: &TurnRetainedInputV1, params: &TurnStartParams) -> Result<()> {
    let retained = params
        .retention
        .as_ref()
        .context("retained references missing")?;
    retained.validate().map_err(anyhow::Error::msg)?;
    let expected: BTreeSet<_> = retained
        .references
        .iter()
        .flat_map(|r| {
            r.entry_ids
                .iter()
                .map(move |id| (r.retention_id.as_str(), r.expected_revision, id.as_str()))
        })
        .collect();
    let actual: BTreeSet<_> = input
        .artifacts
        .iter()
        .map(|a| {
            (
                a.retention_id.as_str(),
                a.expected_receipt_revision,
                a.entry_id.as_str(),
            )
        })
        .collect();
    ensure!(
        actual == expected && actual.len() == input.artifacts.len(),
        RetentionFailure::Conflict
    );
    Ok(())
}

pub fn require_live_retained_thread(engine: &QueryEngine, thread: &str) -> Result<()> {
    let history = thread_history_path(engine, thread)?;
    ensure!(
        std::fs::symlink_metadata(&history)?.file_type().is_file(),
        "retained thread source is not a regular file"
    );
    ensure!(
        kcoder_state::read_session_history_deletion(&history, &engine.cwd)?.is_none(),
        "retained thread source is deleted"
    );
    let persisted = kcoder_state::history_persisted_base_cwd(&history)?
        .context("retained thread source has no workspace")?;
    ensure!(
        dunce::canonicalize(persisted)? == dunce::canonicalize(&engine.cwd)?,
        "retained thread source belongs to another workspace"
    );
    Ok(())
}

/// All authoritative lookups precede new identity allocation/materialization.
/// Missing retained lookup alone cannot distinguish a legacy or foreign record.
pub fn prepare<'a>(
    authority: Authority<'a>,
    engine: &QueryEngine,
    params: &TurnStartParams,
    proposed: &TurnAttemptIdentity,
    prompt: &str,
) -> Result<Preparation<'a>> {
    {
        // The runtime already holds its SessionLease/execution registration.
        // Share the deletion gate only for source validation, before owner or
        // namespace locks; never retain it over materialization or async work.
        let _lifecycle = kcoder_thread_metadata::acquire_thread_lifecycle_locks_at_root(
            &engine.client_storage_root(),
            &[&params.thread_id],
        )?;
        require_live_retained_thread(engine, &params.thread_id)?;
    }
    ensure!(
        engine.session_id() == params.thread_id && proposed.thread_id == params.thread_id,
        RetentionFailure::Conflict
    );
    let retained = params.retention.as_ref().context("retained input absent")?;
    retained.validate().map_err(anyhow::Error::msg)?;
    let client = params
        .client_message_id
        .as_deref()
        .context("retained client ID absent")?;
    let fingerprint = turn_attempts::request_fingerprint(params)?;
    let session = engine.session_storage_dir_for(&params.thread_id);
    let mapped = turn_attempts::strict_client_message_turn(&session, &params.thread_id, client)?;
    let records = turn_attempts::records(engine, &params.thread_id)?;
    let matches: Vec<_> = records
        .iter()
        .filter(|record| {
            record
                .retained_input
                .as_ref()
                .is_some_and(|input| input.client_message_id == client)
                || mapped.as_deref() == Some(record.identity.turn_id.as_str())
        })
        .collect();
    ensure!(matches.len() <= 1, RetentionFailure::CompletionUnknown);
    if let Some(record) = matches.first() {
        let input = record
            .retained_input
            .as_ref()
            .context("legacy acceptance cannot become retained")?;
        ensure!(
            input.scope_id == authority.scope.hash
                && input.client_message_id == client
                && record.request_fingerprint.as_deref() == Some(&fingerprint)
                && mapped.as_deref() == Some(record.identity.turn_id.as_str())
                && record.status.is_known(),
            RetentionFailure::Conflict
        );
        references_match(input, params)?;
        // We own the execution gate with no active task; replay never dispatches.
        let mut status = record.status.as_str();
        if record.status == TurnAttemptStatus::Accepted {
            if interrupt_unstarted(
                engine,
                &record.identity,
                "retained acceptance recovered without an active task",
            )
            .is_err()
            {
                return Ok(Preparation::Receipt(receipt(&record.identity, "unknown")));
            }
            status = "interrupted";
        }
        let parent = PrivateDirectory::open_existing(&session.join("attachments"))?;
        let proof = turn_attempts::verified_retained_acceptance(
            engine,
            authority.scope,
            &record.identity,
            client,
            &fingerprint,
            &parent,
        )?;
        let mut unfinished = Vec::new();
        for reference in &retained.references {
            let result = authority.service.read(
                authority.scope,
                &kcoder_app_protocol::RetentionReceiptSelectorV1::RetentionId {
                    retention_id: reference.retention_id.clone(),
                },
            )?;
            match result.receipt.as_ref().map(|r| &r.state) {
                Some(kcoder_app_protocol::RetentionReceiptStateV1::Materializing) => {
                    unfinished.push(reference.clone())
                }
                Some(
                    kcoder_app_protocol::RetentionReceiptStateV1::Transferred
                    | kcoder_app_protocol::RetentionReceiptStateV1::Consumed,
                ) => {}
                _ if result.epoch_retired.is_some() => {}
                _ => anyhow::bail!(RetentionFailure::CompletionUnknown),
            }
        }
        let leases = if unfinished.is_empty() {
            Vec::new()
        } else {
            let (_, owners) = authority.service.retained_transfer_owner_ids(
                authority.scope,
                &params.thread_id,
                client,
                &fingerprint,
                &unfinished,
            )?;
            authority
                .service
                .retained_owner_leases(authority.scope, &owners)?
        };
        for reference in &unfinished {
            if authority
                .service
                .finish_retained_transfer(
                    authority.scope,
                    &leases.iter().collect::<Vec<_>>(),
                    &reference.retention_id,
                    &parent,
                    &proof,
                )
                .is_err()
            {
                return Ok(Preparation::Receipt(receipt(&record.identity, "unknown")));
            }
        }
        return Ok(Preparation::Receipt(receipt(&record.identity, status)));
    }
    let (pending, owners) = authority.service.retained_transfer_owner_ids(
        authority.scope,
        &params.thread_id,
        client,
        &fingerprint,
        &retained.references,
    )?;
    ensure!(
        mapped.is_none()
            || pending
                .as_ref()
                .is_some_and(|id| mapped.as_deref() == Some(id.turn_id.as_str())),
        RetentionFailure::CompletionUnknown
    );
    let identity = pending.clone().unwrap_or_else(|| proposed.clone());
    // A pending receipt is not permission to overwrite an unrelated attempt.
    ensure!(
        !records
            .iter()
            .any(|r| r.identity.turn_id == identity.turn_id),
        RetentionFailure::Conflict
    );
    let request = TransferRequest {
        identity,
        client_message_id: client.into(),
        request_fingerprint: fingerprint,
        references: retained.references.clone(),
    };
    let leases = authority
        .service
        .retained_owner_leases(authority.scope, &owners)?;
    let root = session.join("attachments");
    let parent = PrivateDirectory::open_or_create(&root)?;
    if pending.is_none() {
        let number = request
            .identity
            .turn_id
            .strip_prefix("turn-")
            .and_then(|value| value.parse::<usize>().ok())
            .context("invalid server turn sequence")?;
        // This journal stores only the sequence high-water mark. It does not
        // create Accepted, bind a user message, or publish transcript content.
        // Reserve before any durable receipt intent can claim this identity.
        turn_admissions::accept(engine, &params.thread_id, number)?;
    }
    let input = authority.service.prepare_retained_transfer(
        authority.scope,
        &leases.iter().collect::<Vec<_>>(),
        &request,
        &parent,
    )?;
    let (prompt, model_message) = kcoder_attachments::model_message_from_retained_input(
        prompt, retained, &input, &parent, &root,
    )?;
    Ok(Preparation::Fresh(Box::new(Prepared {
        authority,
        request,
        leases,
        parent,
        input,
        prompt,
        model_message,
    })))
}

impl Prepared<'_> {
    pub fn identity(&self) -> &TurnAttemptIdentity {
        &self.request.identity
    }

    /// Accepted is already durable. No Provider is invoked from this method.
    pub fn handoff(&self, engine: &QueryEngine) -> Result<()> {
        let proof = turn_attempts::verified_retained_acceptance(
            engine,
            self.authority.scope,
            &self.request.identity,
            &self.request.client_message_id,
            &self.request.request_fingerprint,
            &self.parent,
        )?;
        for reference in &self.request.references {
            self.authority.service.finish_retained_transfer(
                self.authority.scope,
                &self.leases.iter().collect::<Vec<_>>(),
                &reference.retention_id,
                &self.parent,
                &proof,
            )?;
        }
        Ok(())
    }
}
