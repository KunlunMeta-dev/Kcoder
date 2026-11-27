//! Publish the first control record together with its directory, under the history fence.
use super::*;

pub(super) fn publish_initial_record(
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &SourceRecord,
) -> Result<()> {
    publish_initial_record_with(directory, name, record, || Ok(()))
}

fn publish_initial_record_with(
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &SourceRecord,
    before_publish: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let control_name = source_directory_name(name)?;
    let staging_name = OsString::from(format!(".kcoder-history-init-{}", uuid::Uuid::new_v4()));
    let staging = directory.create_private_child(&staging_name)?;
    staging.atomic_replace(OsStr::new(SOURCE_RECORD_FILE), &serde_json::to_vec(record)?)?;
    // A crash before publication leaves only an unbound staging directory. Readers cannot
    // mistake it for managed authority; a new attempt never reuses its incarnation.
    drop(staging);
    before_publish()?;
    directory.rename_no_replace(&staging_name, &control_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> SourceRecord {
        SourceRecord {
            schema_version: 1,
            incarnation: uuid::Uuid::new_v4(),
            deleted: false,
            commit: None,
            deletion: None,
        }
    }

    #[test]
    fn failed_first_publication_keeps_legacy_body_readable_and_retryable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        fs::write(&path, b"retained history\n").unwrap();
        let source = HistorySource::bind(&path).unwrap();
        let (directory, name) = open_parent(&path).unwrap();
        let initial = record();
        let result = publish_initial_record_with(&directory, &name, &initial, || {
            // Even after source.json has been synced, no empty authoritative directory
            // may become visible to a concurrent reader or the next process.
            assert!(source_stamp(&path).unwrap().0.is_none());
            assert!(!path.with_extension("hctl").exists());
            anyhow::bail!("interrupted before publication")
        });
        assert!(result.is_err());
        source.check().unwrap();
        source.append(b"continued\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"retained history\ncontinued\n");
        assert_ne!(
            source_stamp(&path).unwrap().0.unwrap().incarnation,
            initial.incarnation
        );
    }

    #[test]
    fn successful_first_publication_contains_the_complete_record() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let (directory, name) = open_parent(&path).unwrap();
        let initial = record();
        publish_initial_record(&directory, &name, &initial).unwrap();
        assert_eq!(source_stamp(&path).unwrap().0, Some(initial));
        assert!(!path.exists());
    }

    #[test]
    fn publication_never_replaces_a_concurrent_control_directory() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let (directory, name) = open_parent(&path).unwrap();
        let winner = record();
        let result = publish_initial_record_with(&directory, &name, &record(), || {
            publish_initial_record(&directory, &name, &winner)
        });
        assert!(result.is_err());
        assert_eq!(source_stamp(&path).unwrap().0, Some(winner));
    }

    #[test]
    fn an_existing_empty_control_directory_is_not_reclaimed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        fs::write(&path, b"retained history\n").unwrap();
        fs::create_dir(path.with_extension("hctl")).unwrap();
        let (directory, name) = open_parent(&path).unwrap();
        assert!(publish_initial_record(&directory, &name, &record()).is_err());
        assert!(HistorySource::bind(&path).is_err());
        assert_eq!(fs::read(path).unwrap(), b"retained history\n");
    }
}
