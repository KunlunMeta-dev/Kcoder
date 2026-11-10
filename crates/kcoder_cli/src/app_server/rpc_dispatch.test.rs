//! Same-module regressions for connection-owned background task reporting.
use super::*;

#[test]
fn an_idle_connection_reports_no_owned_background_tasks() {
    assert!(!background_tasks_active(&ConnectionState::default()));
}

#[tokio::test]
async fn an_in_flight_continuous_work_task_keeps_the_connection_busy() {
    let mut state = ConnectionState::default();
    state.continuous_work_mutation_tasks.spawn(async {});
    assert!(background_tasks_active(&state));
    state
        .continuous_work_mutation_tasks
        .spawn(async { std::future::pending::<()>().await });
    assert!(background_tasks_active(&state));
}
