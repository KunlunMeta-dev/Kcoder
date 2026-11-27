use super::QueryEngine;
use super::tracked_history_list::HistoryHost;
use anyhow::Result;
#[cfg(test)]
use kcoder_app_protocol::ThreadHistoryRefreshStatus;
use kcoder_app_protocol::{ThreadHistoryRefreshParams, ThreadHistoryRefreshResult};

#[derive(Default)]
pub(super) struct HistoryRefreshProcessor(
    kcoder_cli_storage::history_refresh_processor::HistoryRefreshProcessor,
);

impl HistoryRefreshProcessor {
    pub(super) fn is_active(&self) -> bool {
        self.0.is_active()
    }

    pub(super) fn process(
        &mut self,
        engine: &QueryEngine,
        params: ThreadHistoryRefreshParams,
    ) -> Result<ThreadHistoryRefreshResult> {
        self.0.process(&HistoryHost(engine), params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_processor_requires_consent_and_rejects_foreign_cursor_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let engine = super::super::tests::catalog_list_test_engine(temp.path());
        let mut processor = HistoryRefreshProcessor::default();
        assert!(
            processor
                .process(&engine, ThreadHistoryRefreshParams::default())
                .is_err()
        );
        assert!(
            processor
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some("foreign".into()),
                        acknowledge_external_writers: true,
                        cancel: false,
                    }
                )
                .is_err()
        );
        assert!(!processor.is_active());
        assert!(
            !engine
                .client_storage_root()
                .join("history-list-index")
                .exists()
        );
    }

    #[test]
    fn refresh_processor_cursor_is_owned_one_shot_and_cancel_releases_builder() {
        let workspace = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let engine = super::super::tests::catalog_list_test_engine(workspace.path());
        engine.state.with_history_path(
            history
                .path()
                .join(format!("{}.jsonl", engine.session_id())),
        );
        engine
            .state
            .add_message(kcoder_types::Message::user_text("indexed prompt"));
        engine.state.save_history().unwrap();
        let start = || ThreadHistoryRefreshParams {
            acknowledge_external_writers: true,
            ..Default::default()
        };
        let mut owner = HistoryRefreshProcessor::default();
        let first = owner.process(&engine, start()).unwrap();
        assert_eq!(first.status, ThreadHistoryRefreshStatus::Building);
        let cursor = first.next_cursor.unwrap();
        let mut foreign = HistoryRefreshProcessor::default();
        assert!(
            foreign
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some(cursor.clone()),
                        ..Default::default()
                    }
                )
                .is_err()
        );
        assert!(
            owner
                .process(&engine, ThreadHistoryRefreshParams::default())
                .is_err()
        );
        let cancelled = owner
            .process(
                &engine,
                ThreadHistoryRefreshParams {
                    cursor: Some(cursor.clone()),
                    cancel: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cancelled.status, ThreadHistoryRefreshStatus::Cancelled);
        assert!(cancelled.next_cursor.is_none());
        assert!(
            owner
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some(cursor),
                        ..Default::default()
                    }
                )
                .is_err()
        );
        let mut response = owner.process(&engine, start()).unwrap();
        for _ in 0..32 {
            let Some(cursor) = response.next_cursor.clone() else {
                break;
            };
            response = owner
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some(cursor.clone()),
                        ..Default::default()
                    },
                )
                .unwrap();
            assert!(
                owner
                    .process(
                        &engine,
                        ThreadHistoryRefreshParams {
                            cursor: Some(cursor),
                            ..Default::default()
                        }
                    )
                    .is_err()
            );
        }
        assert_eq!(response.status, ThreadHistoryRefreshStatus::Ready);
        assert_eq!(response.indexed_sessions, 1);
        assert_eq!(response.issue_count, 0);
    }
}
