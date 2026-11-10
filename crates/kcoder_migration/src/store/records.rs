//! A derived creation-order index never substitutes for authoritative job reads.
use super::*;
use kcoder_types::migration::MigrationSourceKind;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationRecord {
    pub job_id: String,
    pub created_at_ms: u64,
    pub source: MigrationSourceKind,
    pub status: JobStatus,
    pub sequence: u64,
    pub total_items: usize,
    pub selected_items: usize,
    pub committed_items: usize,
    pub reused_items: usize,
    pub batch: bool,
    pub requires_action_items: usize,
    pub has_unconfirmed_outcomes: bool,
}
impl MigrationStore {
    pub fn records(&self, cursor: Option<&str>) -> Result<(Vec<MigrationRecord>, Option<String>)> {
        let _lock = self.write_lock()?;
        let name = OsStr::new(".creation-index.json");
        let mut index: BTreeMap<String, u64> =
            match self.directory.open_single_link_regular_file(name) {
                Ok(file) => {
                    ensure!(
                        file.metadata()?.len() <= 1024 * 1024,
                        "migration_record_index_budget_exceeded"
                    );
                    let mut bytes = Vec::new();
                    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
                    ensure!(
                        bytes.len() <= 1024 * 1024,
                        "migration_record_index_budget_exceeded"
                    );
                    serde_json::from_slice(&bytes)
                        .map_err(|_| anyhow::anyhow!("migration_record_index_invalid"))?
                }
                Err(error)
                    if error.chain().any(|error| {
                        error
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    }) =>
                {
                    BTreeMap::new()
                }
                Err(_) => anyhow::bail!("migration_record_index_unavailable"),
            };
        ensure!(
            index.len() <= 4096,
            "migration_record_index_budget_exceeded"
        );
        let mut ids = BTreeSet::new();
        self.directory.visit_entry_names_bounded(16384, |name| {
            if let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json"))
                && job_file(id).is_ok()
            {
                ids.insert(id.to_owned());
            }
            Ok(())
        })?;
        ensure!(ids.len() <= 4096, "migration_records_budget_exceeded");
        index.retain(|id, _| ids.contains(id));
        for id in ids {
            if let std::collections::btree_map::Entry::Vacant(entry) = index.entry(id) {
                let job = self.load(entry.key())?;
                entry.insert(job.created_at_ms);
            }
        }
        self.directory
            .atomic_replace(name, &serde_json::to_vec(&index)?)?;
        let after = cursor
            .map(|cursor| {
                let (created, id) = cursor
                    .split_once(':')
                    .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
                job_file(id)?;
                ensure!(created.len() <= 20, "migration_invalid_cursor");
                Ok::<_, anyhow::Error>((
                    created
                        .parse::<u64>()
                        .map_err(|_| anyhow::anyhow!("migration_invalid_cursor"))?,
                    id.to_owned(),
                ))
            })
            .transpose()?;
        let mut ordered = index
            .into_iter()
            .map(|(id, time)| (time, id))
            .collect::<Vec<_>>();
        ordered.sort_by(|a, b| b.cmp(a));
        let mut rows = Vec::new();
        let mut next = None;
        for key in ordered
            .into_iter()
            .filter(|key| after.as_ref().is_none_or(|after| key < after))
        {
            if rows.len() == 10 {
                let last = rows.last().unwrap();
                let last: &MigrationRecord = last;
                next = Some(format!("{}:{}", last.created_at_ms, last.job_id));
                break;
            }
            let job = self.load(&key.1)?;
            rows.push(MigrationRecord {
                job_id: job.job_id.clone(),
                created_at_ms: job.created_at_ms,
                source: job.inventory.source,
                status: job.status,
                sequence: job.sequence,
                total_items: job.inventory.items.len(),
                selected_items: job.selected_item_ids.len(),
                committed_items: job
                    .inventory
                    .items
                    .iter()
                    .filter(|item| {
                        matches!(
                            item.preview.status,
                            ItemStatus::Committed | ItemStatus::Ready
                        )
                    })
                    .count(),
                reused_items: job.batch.as_ref().map_or(0, |batch| {
                    batch
                        .actions
                        .iter()
                        .filter(|action| {
                            action.status == ItemStatus::Skipped
                                && matches!(
                                    action.action,
                                    crate::batch::BatchActionKind::Reuse { .. }
                                )
                        })
                        .map(|action| action.item_ids.len())
                        .sum()
                }),
                batch: job.batch.is_some(),
                requires_action_items: job
                    .inventory
                    .items
                    .iter()
                    .filter(|item| {
                        item.preview.status == ItemStatus::RequiresAction
                            || item.preview.issues.iter().any(|issue| {
                                issue.severity
                                    == kcoder_types::migration::MigrationIssueSeverity::Blocking
                            })
                    })
                    .count(),
                has_unconfirmed_outcomes: job.status == JobStatus::RollingBack
                    || job.has_unconfirmed_credentials()
                    || job.inventory.items.iter().any(|item| {
                        matches!(
                            item.preview.status,
                            ItemStatus::Committing | ItemStatus::CommitUnknown
                        )
                    }),
            });
        }
        Ok((rows, next))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_page_ten_and_reconcile_a_missing_index_without_private_contents() {
        let root = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(root.path()).unwrap();
        let mut ids = BTreeSet::new();
        for _ in 0..23 {
            let job = store
                .create_scan(
                    "fixture",
                    crate::parse_codex_config("model='fixture'").unwrap(),
                )
                .unwrap();
            ids.insert(job.job_id);
        }
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        loop {
            let (page, next) = store.records(cursor.as_deref()).unwrap();
            assert!(page.len() <= 10);
            for row in page {
                assert!(seen.insert(row.job_id));
            }
            if next.is_none() {
                break;
            }
            cursor = next;
        }
        assert_eq!(seen, ids);
        std::fs::remove_file(root.path().join("migrations/.creation-index.json")).unwrap();
        assert_eq!(store.records(None).unwrap().0.len(), 10);
        assert!(store.records(Some("1:../../auth")).is_err());
    }
}
