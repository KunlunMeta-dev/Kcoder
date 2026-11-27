//! Per-work isolation when one stored entry cannot be parsed.
use super::*;

/// One bounded observation that separates the entries it could parse from the
/// entries it could not. An unreadable key is not proof that the work never
/// existed, and a readable record is still only an observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkIsolationReport {
    /// Records that parsed and whose identity matches the requested scope.
    pub readable: Vec<WorkRecord>,
    /// Opaque stored keys of entries that could not be parsed. They are not
    /// proof that the work never existed.
    pub unreadable: Vec<String>,
}

impl ContinuousWorkStore {
    /// Observe every parseable record in `actual_scope` without creating,
    /// repairing, rewriting, or deleting stored data.
    ///
    /// The ordinary read path validates the whole namespace at once, so one
    /// damaged entry hides every other record. This read inspects the raw
    /// envelope and isolates each `works` entry instead. An envelope that
    /// cannot be attributed at all stays an error, and neither result variant
    /// can prove that an unreadable work is absent.
    pub fn list_for_scope_isolated(&self, actual_scope: &WorkScope) -> Result<WorkIsolationReport> {
        actual_scope.validate_shape().map_err(anyhow::Error::msg)?;
        self.namespace.read(|bytes| {
            let envelope: Value =
                serde_json::from_slice(bytes).context("CONTINUOUS_WORK_DATA_INVALID")?;
            ensure!(
                envelope.get("version").and_then(Value::as_u64) == Some(1),
                "CONTINUOUS_WORK_DATA_INVALID"
            );
            let works = envelope
                .get("works")
                .and_then(Value::as_object)
                .context("CONTINUOUS_WORK_DATA_INVALID")?;
            ensure!(works.len() <= MAX_WORKS, "CONTINUOUS_WORK_DATA_INVALID");
            // Report in stored key order, independent of the JSON map type.
            let mut keys = works.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut report = WorkIsolationReport {
                readable: Vec::new(),
                unreadable: Vec::new(),
            };
            for key in keys {
                let parsed = serde_json::from_value::<StoredWork>(works[key].clone())
                    .ok()
                    .and_then(|stored| record(&stored).ok());
                match parsed {
                    // The key stays opaque: it identifies the stored entry
                    // without asserting anything about the damaged record.
                    None => report.unreadable.push(key.clone()),
                    Some(work) if work.identity.matches_scope(actual_scope) => {
                        report.readable.push(work);
                    }
                    Some(_) => {}
                }
            }
            Ok(report)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::TurnAttemptIdentity;
    use serde_json::json;
    use std::fs;

    const STATE: &str = "continuous-work.v1/state.json";

    fn scope(account: &str) -> WorkScope {
        WorkScope {
            account_id: account.into(),
            target_id: "owned-target".into(),
            workspace_id: "owned-workspace".into(),
        }
    }

    fn source() -> WorkInputSource {
        WorkInputSource {
            kind: "foreground".into(),
            instance_id: "owned-instance".into(),
            conversation_id: "owned-conversation".into(),
        }
    }

    fn work(scope: &WorkScope, id: &str, thread: &str) -> WorkRecord {
        let attempt = TurnAttemptIdentity {
            thread_id: thread.into(),
            turn_id: format!("turn-{thread}"),
            attempt_id: format!("attempt-{thread}"),
        };
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "identity": {"scope": scope, "workId": id},
            "origin": {"kind": "foreground", "initialAttempt": attempt},
            "linkedThreadIds": [thread],
            "phase": "pending",
            "revision": {"revision": 1, "requirementsRevision": 1, "controlEpoch": 0,
                "ownerEpoch": 0, "acceptedInputSequence": 1, "requiredInputSequence": 1,
                "appliedInputSequence": 0}
        }))
        .unwrap()
    }

    /// Two works in the requested scope and one owned by another account, all
    /// in the same namespace.
    fn admit_works(profile: &Path) -> Result<WorkScope> {
        let actual = scope("owned-account");
        let foreign = scope("other-account");
        let store = ContinuousWorkStore::open_or_create(profile)?;
        for (owner, id, thread) in [
            (&actual, "work-a", "thread-a"),
            (&actual, "work-b", "thread-b"),
            (&foreign, "work-c", "thread-c"),
        ] {
            store.admit(
                owner,
                work(owner, id, thread),
                &source(),
                id,
                json!({"text":id}),
                vec![],
            )?;
        }
        Ok(actual)
    }

    /// The ordinary opening path validates every record, so a damaged namespace
    /// cannot be opened that way; bind the handle to the existing namespace
    /// instead and neither create nor repair anything.
    fn open_damaged(profile: &Path) -> Result<ContinuousWorkStore> {
        let namespace = Namespace::open_existing(profile)?.context("namespace is absent")?;
        Ok(ContinuousWorkStore { namespace })
    }

    /// Damage only the JSON of one record, leaving the remaining bytes intact.
    fn corrupt_record(profile: &Path, work_id: &str) -> Result<()> {
        let path = profile.join(STATE);
        let mut state: Value = serde_json::from_slice(&fs::read(&path)?)?;
        let broken = state["works"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .find(|entry| entry["record"]["identity"]["workId"] == work_id)
            .expect("the damaged work is stored");
        broken["record"]["revision"]["revision"] = json!(0);
        fs::write(&path, serde_json::to_vec(&state)?)?;
        Ok(())
    }

    fn readable_ids(report: &WorkIsolationReport) -> Vec<&str> {
        report
            .readable
            .iter()
            .map(|work| work.identity.work_id.as_str())
            .collect()
    }

    #[test]
    fn readable_records_are_reported_without_loss() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-isolation")?;
        let actual = admit_works(temp.path())?;
        let store = ContinuousWorkStore::open_existing(temp.path())?.expect("namespace exists");
        let report = store.list_for_scope_isolated(&actual)?;
        assert_eq!(readable_ids(&report), ["work-a", "work-b"]);
        assert!(report.unreadable.is_empty());
        // A stored record of another scope is neither readable nor unreadable.
        assert!(
            report
                .readable
                .iter()
                .all(|work| work.identity.scope == actual)
        );
        Ok(())
    }

    #[test]
    fn one_damaged_record_never_hides_the_remaining_works() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-isolation-damaged")?;
        let actual = admit_works(temp.path())?;
        corrupt_record(temp.path(), "work-a")?;
        let store = open_damaged(temp.path())?;
        let report = store.list_for_scope_isolated(&actual)?;
        assert_eq!(readable_ids(&report), ["work-b"]);
        assert_eq!(
            report.unreadable,
            [work_key(&work(&actual, "work-a", "thread-a").identity)?]
        );
        // The ordinary listing still refuses the whole namespace.
        assert!(
            store
                .list_for_scope(&actual, None, None, None, None)
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn isolated_reading_never_rewrites_the_stored_index() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-isolation-readonly")?;
        let actual = admit_works(temp.path())?;
        corrupt_record(temp.path(), "work-a")?;
        let path = temp.path().join(STATE);
        let before = fs::read(&path)?;
        let store = open_damaged(temp.path())?;
        for _ in 0..2 {
            let report = store.list_for_scope_isolated(&actual)?;
            assert_eq!(readable_ids(&report), ["work-b"]);
        }
        drop(store);
        assert_eq!(fs::read(&path)?, before);
        Ok(())
    }
}
