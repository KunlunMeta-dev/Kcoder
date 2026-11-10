//! Reconcile duplicate native calls without replaying a request whose result is unknown.
use crate::{ToolContext, ToolError};
use kcoder_state::{AppStateIdentity, AppStateLifecycleIdentity};
use kcoder_types::{TurnAttemptIdentity, web_search::WebSearchResponseV1};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

const MAX_IDENTITIES: usize = 4096;
const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone)]
enum Outcome {
    Running,
    Done(Result<WebSearchResponseV1, String>),
    Unknown,
    Unavailable,
}
pub(super) struct Slot {
    lifecycle: AppStateLifecycleIdentity,
    outcome: Mutex<Outcome>,
    changed: tokio::sync::Notify,
    budget: Arc<AtomicUsize>,
    bytes: AtomicUsize,
}
struct Entry {
    owner: AppStateIdentity,
    identity: TurnAttemptIdentity,
    call: String,
    shape: String,
    slot: Arc<Slot>,
}
#[derive(Default)]
pub(super) struct Receipts {
    entries: Mutex<Vec<Entry>>,
    retained: Arc<AtomicUsize>,
}
pub(super) enum Claim {
    Untracked,
    Owner(ReceiptOwner),
    Existing(Arc<Slot>),
}
pub(super) struct ReceiptOwner {
    slot: Arc<Slot>,
    settled: bool,
}

impl Receipts {
    pub fn claim(&self, ctx: &ToolContext, shape: String) -> Result<Claim, ToolError> {
        let lifecycle = super::lifecycle::owner(ctx)?;
        let Some(identity) = super::lifecycle::identity(ctx)? else {
            return Ok(Claim::Untracked);
        };
        let Some(call) = ctx.tool_call_id.as_deref() else {
            return Ok(Claim::Untracked);
        };
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|entry| entry.owner.is_alive());
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.identity == identity && entry.call == call)
        {
            if !entry.slot.lifecycle.matches(&ctx.state) {
                return Err(lifecycle_conflict());
            }
            if entry.shape != shape {
                return Err(ToolError::Execution(
                    "Search request identity is already bound to different inputs".into(),
                ));
            }
            return Ok(Claim::Existing(entry.slot.clone()));
        }
        if entries.len() >= MAX_IDENTITIES {
            return Err(ToolError::Execution(
                "Search receipt capacity is exhausted; no additional request was dispatched".into(),
            ));
        }
        let slot = Arc::new(Slot {
            lifecycle,
            outcome: Mutex::new(Outcome::Running),
            changed: tokio::sync::Notify::new(),
            budget: self.retained.clone(),
            bytes: AtomicUsize::new(0),
        });
        entries.push(Entry {
            owner: ctx.state.inspection_identity(),
            identity,
            call: call.into(),
            shape,
            slot: slot.clone(),
        });
        Ok(Claim::Owner(ReceiptOwner {
            slot,
            settled: false,
        }))
    }
}
impl ReceiptOwner {
    pub fn complete(mut self, result: &Result<WebSearchResponseV1, ToolError>) {
        let stored: Result<WebSearchResponseV1, String> = match result {
            Ok(response) => Ok(response.clone()),
            Err(error) => Err(match error {
                ToolError::Execution(message) | ToolError::InvalidInput(message) => {
                    message.chars().take(1024).collect::<String>()
                }
                _ => "Search request did not complete".into(),
            }),
        };
        let bytes = match &stored {
            Ok(response) => serde_json::to_vec(response).unwrap().len(),
            Err(error) => error.len(),
        };
        let outcome = if self
            .slot
            .budget
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes)
                    .filter(|total| *total <= MAX_RETAINED_BYTES)
            })
            .is_ok()
        {
            self.slot.bytes.store(bytes, Ordering::Release);
            Outcome::Done(stored)
        } else {
            Outcome::Unavailable
        };
        *self
            .slot
            .outcome
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = outcome;
        self.settled = true;
        self.slot.changed.notify_waiters();
    }
}
impl Drop for ReceiptOwner {
    fn drop(&mut self) {
        if !self.settled {
            *self
                .slot
                .outcome
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Outcome::Unknown;
            self.slot.changed.notify_waiters();
        }
    }
}
fn lifecycle_conflict() -> ToolError {
    ToolError::Execution(
        "Search receipt belongs to an earlier session lifecycle; this request was not replayed"
            .into(),
    )
}
impl Slot {
    pub async fn read(
        &self,
        ctx: &ToolContext,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<WebSearchResponseV1, ToolError> {
        loop {
            if cancel.is_cancelled() {
                return Err(ToolError::Aborted);
            }
            super::lifecycle::owner(ctx)?;
            if !self.lifecycle.matches(&ctx.state) {
                return Err(lifecycle_conflict());
            }
            let changed = self.changed.notified();
            let outcome = self
                .outcome
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            match outcome {
                Outcome::Done(result)=>return result.map_err(ToolError::Execution),
                Outcome::Unknown=>return Err(ToolError::Execution("The previous search result could not be confirmed; this request was not replayed".into())),
                Outcome::Unavailable=>return Err(ToolError::Execution("The previous search completed, but its in-memory result is no longer available; inspect the original tool result. This request was not replayed".into())),
                Outcome::Running=>tokio::select!{biased;()=cancel.cancelled()=>return Err(ToolError::Aborted),()=changed=>{},()=tokio::time::sleep(std::time::Duration::from_millis(25))=>{}},
            }
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.budget
            .fetch_sub(self.bytes.load(Ordering::Acquire), Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context() -> ToolContext {
        let state = kcoder_state::AppState::new(std::env::temp_dir());
        let identity = TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: "actual-fixture-turn".into(),
            attempt_id: "actual-fixture-attempt".into(),
        };
        ToolContext::new(state)
            .with_tool_call_id("native-call")
            .with_native_web_source_identity(Some(identity))
    }
    #[tokio::test]
    async fn a_dropped_owner_is_unknown_and_the_same_identity_cannot_dispatch_again() {
        let receipts = Receipts::default();
        let ctx = context();
        let Claim::Owner(owner) = receipts.claim(&ctx, "shape".into()).unwrap() else {
            panic!("owner required")
        };
        drop(owner);
        let Claim::Existing(slot) = receipts.claim(&ctx, "shape".into()).unwrap() else {
            panic!("must not replay")
        };
        assert!(
            slot.read(&ctx, &tokio_util::sync::CancellationToken::new())
                .await
                .unwrap_err()
                .to_string()
                .contains("not replayed")
        );
        assert!(receipts.claim(&ctx, "changed-shape".into()).is_err());
    }
    #[tokio::test]
    async fn cancelling_a_reader_does_not_cancel_the_original_owner_receipt() {
        let receipts = Receipts::default();
        let ctx = context();
        let Claim::Owner(owner) = receipts.claim(&ctx, "shape".into()).unwrap() else {
            panic!()
        };
        let Claim::Existing(slot) = receipts.claim(&ctx, "shape".into()).unwrap() else {
            panic!()
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            slot.read(&ctx, &cancel).await,
            Err(ToolError::Aborted)
        ));
        owner.complete(&Err(ToolError::Execution("known fixture failure".into())));
        assert!(
            slot.read(&ctx, &tokio_util::sync::CancellationToken::new())
                .await
                .unwrap_err()
                .to_string()
                .contains("known fixture failure")
        );
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[tokio::test]
    async fn a_waiting_reader_loses_authority_on_same_id_restore_without_cancelling_the_owner() {
        let root = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(root.path());
        let path = root.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(kcoder_types::Message::user_text(
            "Owned receipt lifecycle fixture",
        ));
        state.save_history().unwrap();
        let identity = TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: "owned-turn".into(),
            attempt_id: "owned-attempt".into(),
        };
        let ctx = ToolContext::new(state.clone())
            .with_tool_call_id("same-call")
            .with_native_web_source_identity(Some(identity.clone()));
        let receipts = Receipts::default();
        let Claim::Owner(owner) = receipts.claim(&ctx, "shape".into()).unwrap() else {
            panic!("owner required")
        };
        let Claim::Existing(slot) = receipts.claim(&ctx, "shape".into()).unwrap() else {
            panic!("existing required")
        };
        let wait = tokio::spawn({
            let slot = slot.clone();
            let ctx = ctx.clone();
            async move {
                slot.read(&ctx, &tokio_util::sync::CancellationToken::new())
                    .await
            }
        });
        tokio::task::yield_now().await;
        state.resume_from_history(&path).unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_secs(1), wait)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("owner") || error.to_string().contains("lifecycle"));
        owner.complete(&Err(ToolError::Execution(
            "private previous-life result".into(),
        )));
        let fresh = ToolContext::new(state.clone())
            .with_tool_call_id("same-call")
            .with_native_web_source_identity(Some(identity.clone()));
        let error = slot
            .read(&fresh, &tokio_util::sync::CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("earlier session lifecycle"));
        assert!(!error.to_string().contains("private previous-life result"));
        assert!(receipts.claim(&fresh, "shape".into()).is_err());
        let new_call = fresh.with_tool_call_id("new-call");
        assert!(matches!(
            receipts.claim(&new_call, "new shape".into()).unwrap(),
            Claim::Owner(_)
        ));
    }
}
