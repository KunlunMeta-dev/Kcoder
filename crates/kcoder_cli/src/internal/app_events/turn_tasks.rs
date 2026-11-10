//! App Server task-local scopes share one compiled future type per turn kind.

use futures::future::BoxFuture;
use kcoder_engine::continuous_work::input_handoff;
use kcoder_state::{CommittedUserInput, HistoryAppendScope};
use kcoder_types::TurnAttemptIdentity;
use tokio::{sync::oneshot, task::JoinHandle};

#[track_caller]
pub fn spawn_foreground(
    attempt: TurnAttemptIdentity,
    input: oneshot::Sender<CommittedUserInput>,
    history: HistoryAppendScope,
    turn: BoxFuture<'static, ()>,
) -> JoinHandle<()> {
    tokio::spawn(input_handoff::scope(attempt, input, history.run(turn)))
}

#[track_caller]
pub fn spawn_followup(
    thread_id: String,
    input: oneshot::Sender<CommittedUserInput>,
    turn: BoxFuture<'static, ()>,
) -> JoinHandle<()> {
    tokio::spawn(input_handoff::scope_thread(thread_id, input, turn))
}
