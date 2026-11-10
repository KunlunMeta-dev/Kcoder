//! Bounded history observations cannot consume the mutation/cancellation control lane.
use kcoder_app_protocol::method;
pub(super) const ACTIVE_HISTORY_OBSERVATIONS: usize =
    kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY;
pub const MAX_HISTORY_OBSERVATIONS: usize =
    2 * kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY;

/// Observe a checkpoint again after exact SQLite contention, without replaying a mutation.
pub(super) fn read_catalog<T>(mut observe: impl FnMut() -> anyhow::Result<T>) -> anyhow::Result<T> {
    for attempt in 0..10 {
        match observe() {
            Err(error)
                if attempt < 9
                    && kcoder_state::history_index::HistoryCatalogBusy::from_error(&error)
                        .is_some() =>
            {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            result => return result,
        }
    }
    unreachable!("the final observation attempt always returns")
}

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_BATCH_CONTROL_READ
            | method::MIGRATION_DEFINITIONS_DISCOVER
            | method::MIGRATION_INSTRUCTION_PAGE
            | method::MIGRATION_INSTRUCTION_BODY
            | method::MIGRATION_DEFINITION_REPORT
            | method::MIGRATION_DEFINITION_BODY
            | method::MIGRATION_AGENT_PREVIEW
            | method::MIGRATION_SOURCE_PRODUCT_READ
            | method::MIGRATION_SOURCE_UPLOAD_READ
            | method::MIGRATION_SOURCE_UPLOAD_FILES
            | method::MIGRATION_PROJECTS_DISCOVER
            | method::MIGRATION_PROJECTS_SOURCES
            | method::MIGRATION_PROJECTS_SOURCE_ROOTS
            | method::MIGRATION_PROJECTS_TARGETS
            | method::MIGRATION_PROJECTS_TARGET_ROOTS
            | method::MIGRATION_PROJECTS_REPORT
            | method::MIGRATION_MEMORY_DISCOVER
            | method::MIGRATION_MEMORY_SOURCES
            | method::MIGRATION_MEMORY_LIST
            | method::MIGRATION_MEMORY_READ
            | method::MIGRATION_MEMORY_CONTROL_READ
            | method::MIGRATION_SOURCE_BINDINGS
            | method::MIGRATION_ARCHIVE_RETIREMENT_PREVIEW
            | method::MIGRATION_ARCHIVE_RETIREMENT_READ
            | method::MIGRATION_ARCHIVE_RETIREMENT_LIST
            | method::MIGRATION_CODEX_LAYERS_SELECT
            | method::MIGRATION_CODEX_LAYERS_READ
            | method::MIGRATION_CONFIGURATION_LAYERS
            | method::MIGRATION_PLUGIN_DISCOVER
            | method::MIGRATION_PLUGIN_READ
            | method::MIGRATION_PLUGIN_LIST
            | method::MIGRATION_BATCH_RESOURCES_READ
            | method::MIGRATION_BATCH_READ
            | method::MIGRATION_BATCH_CREDENTIAL_SOURCES
            | method::MIGRATION_READ
            | method::MIGRATION_ITEMS
            | method::MIGRATION_UPLOAD_COLLECTION_READ
            | method::MIGRATION_UPLOAD_COLLECTION_ATTACHMENT
            | method::MIGRATION_UPLOAD_COLLECTION_LIST
            | method::MIGRATION_LOCAL_ATTACHMENT_READ
            | method::MIGRATION_LOCAL_ATTACHMENT_LIST
            | method::MIGRATION_LOCAL_ATTACHMENT_CHUNK
            | method::MIGRATION_HISTORY_REINTERPRET_PREVIEW
            | method::MIGRATION_HISTORY_UNDO_PREVIEW
            | method::MIGRATION_HISTORY_SEARCH
            | method::MIGRATION_CONTINUATION_SOURCE
            | method::MIGRATION_CONTINUATION_READ
            | method::MIGRATION_HISTORY_READ
            | method::MIGRATION_HISTORY_JOBS
            | method::MIGRATION_HISTORY_SOURCES
            | method::MIGRATION_HISTORY_FAMILIES_DISCOVER
            | method::MIGRATION_BRANCH_READ
            | method::MIGRATION_BRANCH_PAGE
            | method::MIGRATION_BRANCH_BLOCKS
            | method::MIGRATION_BRANCH_TEXT
            | method::MIGRATION_BRANCH_TOOLS_READ
            | method::MIGRATION_BRANCH_TOOLS_PAGE
            | method::MIGRATION_HISTORY_TRANSCRIPT
            | method::MIGRATION_HISTORY_BLOCKS
            | method::MIGRATION_HISTORY_TEXT
            | method::MIGRATION_HISTORY_ATTACHMENT_READ
            | method::MIGRATION_HISTORY_ATTACHMENT_CHUNK
            | method::MIGRATION_TOOL_ATTACHMENTS_READ
            | method::MIGRATION_TOOL_ATTACHMENTS_ITEMS
            | method::MIGRATION_TOOL_ATTACHMENTS_CHUNK
    )
}

#[cfg(test)]
mod tests {
    use super::read_catalog;

    #[test]
    fn a_busy_observation_rechecks_the_checkpoint_within_its_bound() {
        let mut calls = 0;
        let checkpoint = read_catalog(|| {
            calls += 1;
            if calls < 3 {
                anyhow::bail!(kcoder_state::history_index::HistoryCatalogBusy);
            }
            Ok(41)
        })
        .unwrap();
        assert_eq!(checkpoint, 41);
        assert_eq!(calls, 3);
    }

    #[test]
    fn persistent_contention_remains_an_error_and_never_fabricates_a_checkpoint() {
        let mut calls = 0;
        let result: anyhow::Result<()> = read_catalog(|| {
            calls += 1;
            Err(
                anyhow::Error::new(kcoder_state::history_index::HistoryCatalogBusy)
                    .context("checkpoint observation"),
            )
        });
        assert!(result.is_err());
        assert_eq!(calls, 10);
    }

    #[test]
    fn text_lookalikes_and_permission_errors_are_not_retried() {
        for permission in [false, true] {
            let mut calls = 0;
            let result: anyhow::Result<()> = read_catalog(|| {
                calls += 1;
                if permission {
                    return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied).into());
                }
                anyhow::bail!("history_catalog_busy");
            });
            assert!(result.is_err());
            assert_eq!(calls, 1);
        }
    }
}
