//! Failed imports may clean up only objects proven to be unpublished.
use crate::KnowledgeCatalog;
use anyhow::Error;

impl KnowledgeCatalog {
    pub(crate) fn failed_archive_publication(&self, library: &str, error: Error) -> Error {
        // A failed COMMIT can have an uncertain outcome. Never remove object
        // files on the strength of an error return alone.
        if !self.connection.is_autocommit() {
            return error.context("archive transaction outcome is not settled; objects retained; reopen the catalog before retrying");
        }
        match self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1)",
            [library],
            |row| row.get::<_, bool>(0),
        ) {
            Ok(true) => return error.context("archive publication may already be committed; referenced objects retained; retry with the same request key"),
            Err(lookup) => return error.context(format!("archive publication could not be confirmed; objects retained; reopen before retrying: {lookup}")),
            Ok(false) => {}
        }
        // The generated UUID belongs only to this import. No legitimate
        // concurrent publisher can claim it after this settled rollback.
        match self.objects.remove_library_unpublished(library) {
            Ok(()) => error,
            Err(cleanup) => error.context(format!("unpublished archive cleanup failed: {cleanup}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KnowledgeScope;

    #[test]
    fn failed_confirmation_keeps_objects_already_referenced_by_sqlite() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let path = root.path().join("catalog.sqlite");
        let mut store = KnowledgeCatalog::open(&path)?;
        let scope = KnowledgeScope::from_authenticated_host("owned", "local")?;
        let library = store.create(&scope, "source", "Wiki", "")?;
        let source = store.import_text(
            &scope,
            &library.id,
            "source",
            "Original",
            "real committed evidence",
        )?;
        let error = store.failed_archive_publication(
            &library.id,
            anyhow::anyhow!("injected unconfirmed commit return"),
        );
        assert!(format!("{error:#}").contains("injected unconfirmed commit return"));
        drop(store);
        let reopened = KnowledgeCatalog::open(&path)?;
        assert_eq!(
            reopened.source_chunks(
                &scope,
                &library.id,
                &source.source_id,
                &source.revision_id,
                0,
                10
            )?[0]
                .text,
            "real committed evidence"
        );
        assert!(
            reopened
                .inspect_library(&scope, &library.id, None, 50)?
                .issues
                .is_empty()
        );
        Ok(())
    }

    #[test]
    fn failed_authority_lookup_does_not_guess_that_objects_are_unpublished() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&root.path().join("catalog.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owned", "local")?;
        let library = store.create(&scope, "source", "Wiki", "")?;
        let source = store.import_text(
            &scope,
            &library.id,
            "source",
            "Original",
            "preserve on read failure",
        )?;
        store.connection.execute_batch(
            "ALTER TABLE libraries RENAME TO owned_temporarily_unavailable_authority",
        )?;
        let _error = store
            .failed_archive_publication(&library.id, anyhow::anyhow!("owned confirmation failure"));
        store.connection.execute_batch(
            "ALTER TABLE owned_temporarily_unavailable_authority RENAME TO libraries",
        )?;
        assert!(
            store
                .inspect_library(&scope, &library.id, None, 50)?
                .issues
                .is_empty()
        );
        assert_eq!(
            store.source_chunks(
                &scope,
                &library.id,
                &source.source_id,
                &source.revision_id,
                0,
                10
            )?[0]
                .text,
            "preserve on read failure"
        );
        Ok(())
    }

    #[test]
    fn definitely_unpublished_import_objects_are_removed_after_rollback() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let store = KnowledgeCatalog::open(&root.path().join("catalog.sqlite"))?;
        let library = uuid::Uuid::new_v4().to_string();
        let hash = store.objects.put(&library, "owned unpublished bytes")?;
        let _error =
            store.failed_archive_publication(&library, anyhow::anyhow!("rolled back import"));
        assert!(store.objects.read(&library, &hash).is_err());
        Ok(())
    }

    #[test]
    fn unsettled_transaction_retains_objects_until_catalog_recovery() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let store = KnowledgeCatalog::open(&root.path().join("catalog.sqlite"))?;
        let library = uuid::Uuid::new_v4().to_string();
        let hash = store.objects.put(&library, "unsettled imported object")?;
        store.connection.execute_batch("BEGIN IMMEDIATE")?;
        let error = store
            .failed_archive_publication(&library, anyhow::anyhow!("transaction did not settle"));
        assert!(format!("{error:#}").contains("objects retained"));
        assert_eq!(
            store.objects.read(&library, &hash)?,
            "unsettled imported object"
        );
        store.connection.execute_batch("ROLLBACK")?;
        let _error =
            store.failed_archive_publication(&library, anyhow::anyhow!("confirmed rollback"));
        assert!(store.objects.read(&library, &hash).is_err());
        Ok(())
    }
}
