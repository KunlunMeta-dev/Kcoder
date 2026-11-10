//! Same-module regressions for connection-owned task cleanup.
use super::*;

#[tokio::test]
async fn closing_owned_tasks_aborts_and_drains_every_task() {
    let mut tasks: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    tasks.spawn(async {});
    tasks.spawn(async { std::future::pending::<()>().await });
    assert_eq!(tasks.len(), 2);
    close_owned_tasks(&mut tasks).await;
    assert!(tasks.is_empty());
}
