//! Deliver one original committed user input to its owning host turn.
use kcoder_state::CommittedUserInput;
use kcoder_types::{MessagesRequest, TurnAttemptIdentity};
use std::{
    cell::{Cell, RefCell},
    future::Future,
};
use tokio::sync::oneshot;

/// Which committed input this turn owns.
enum Target {
    /// A foreground host turn knows the exact attempt it created.
    Exact(TurnAttemptIdentity),
    /// An automatic turn receives the attempt from the engine, so the observer
    /// matches the first committed input of that thread instead.
    Thread(String),
}

struct Handoff {
    target: Target,
    sender: RefCell<Option<oneshot::Sender<CommittedUserInput>>>,
    original: RefCell<Option<CommittedUserInput>>,
    request_includes_original: Cell<bool>,
}

tokio::task_local! {
    static CURRENT: Handoff;
}

/// Scope the handoff to the original host turn; child tasks do not inherit it.
pub async fn scope<F: Future>(
    expected: TurnAttemptIdentity,
    sender: oneshot::Sender<CommittedUserInput>,
    future: F,
) -> F::Output {
    CURRENT
        .scope(
            Handoff {
                target: Target::Exact(expected),
                sender: RefCell::new(Some(sender)),
                original: RefCell::new(None),
                request_includes_original: Cell::new(false),
            },
            future,
        )
        .await
}

/// Observe the first committed input of one thread. The caller still has to
/// confirm that the provider request really contained it before treating the
/// input as applied.
pub async fn scope_thread<F: Future>(
    thread_id: impl Into<String>,
    sender: oneshot::Sender<CommittedUserInput>,
    future: F,
) -> F::Output {
    CURRENT
        .scope(
            Handoff {
                target: Target::Thread(thread_id.into()),
                sender: RefCell::new(Some(sender)),
                original: RefCell::new(None),
                request_includes_original: Cell::new(false),
            },
            future,
        )
        .await
}

/// Missing, closed or mismatched observers do not change ordinary input flow.
pub(crate) fn publish(input: &CommittedUserInput) {
    let _ = CURRENT.try_with(|handoff| {
        let matched = match &handoff.target {
            Target::Exact(expected) => input.attempt() == Some(expected),
            // An automatic turn may commit its input without an attempt identity.
            // This scope is only active inside that one turn's stream, so such an
            // input still belongs to the observing turn; a stamped attempt must
            // additionally name the same thread.
            Target::Thread(thread_id) => match input.attempt() {
                Some(attempt) => attempt.thread_id == *thread_id,
                None => true,
            },
        };
        if matched && let Some(sender) = handoff.sender.borrow_mut().take() {
            if sender.is_closed() {
                return;
            }
            *handoff.original.borrow_mut() = Some(input.clone());
            let _ = sender.send(input.clone());
        }
    });
}

/// Observe the exact shared input in the request handed to the provider. A
/// later tool result from that request can establish that this input was used.
pub(crate) fn observe_provider_request(request: &MessagesRequest) {
    let _ = CURRENT.try_with(|handoff| {
        let matches = handoff
            .original
            .borrow()
            .as_ref()
            .is_some_and(|input| input.is_shared_in(&request.messages));
        handoff.request_includes_original.set(matches);
    });
}

/// This observation is process-local and scoped to the owning foreground turn.
/// It is not a dispatch grant or evidence that a task has completed.
pub fn current_provider_request_includes(input: &CommittedUserInput) -> bool {
    CURRENT
        .try_with(|handoff| {
            handoff.request_includes_original.get()
                && handoff.original.borrow().as_ref().is_some_and(|original| {
                    original.uuid() == input.uuid() && original.attempt() == input.attempt()
                })
        })
        .unwrap_or(false)
}

/// Check on a worker before Work admission whether request repair can retain
/// the exact committed input identity. An unavailable observation grants nothing.
pub fn can_observe_unrepaired_input(
    engine: &crate::QueryEngine,
    input: &CommittedUserInput,
) -> bool {
    let (messages, _, _) = engine.state.shared_messages_with_lifecycle();
    input.is_shared_in(&messages)
        && crate::message_repair::shared_request_is_canonical(&messages)
        && input.try_is_current().is_ok_and(|current| current)
}
