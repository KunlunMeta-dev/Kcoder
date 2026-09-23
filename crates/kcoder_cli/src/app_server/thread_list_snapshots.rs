use anyhow::{Context, Result};
use kcoder_app_protocol::{Thread, ThreadListCompleteness, ThreadListResult};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

const SNAPSHOT_TTL: Duration = Duration::from_secs(120);
const MAX_SNAPSHOTS: usize = 8;
const MAX_THREADS: usize = 100_000;

struct Snapshot {
    created_at: Instant,
    threads: Vec<Thread>,
    archived: Option<bool>,
    query: Option<String>,
    issue_count: u64,
}

/// Independent immutable scans shared by clients of one workspace connection.
#[derive(Default)]
pub(super) struct ThreadListSnapshots {
    snapshots: BTreeMap<u64, Snapshot>,
    next_id: u64,
}

impl ThreadListSnapshots {
    #[cfg(test)]
    pub(super) fn start(
        &mut self,
        threads: Vec<Thread>,
        limit: usize,
        archived: Option<bool>,
        query: Option<String>,
    ) -> Result<ThreadListResult> {
        self.start_report(threads, limit, archived, query, 0, false)
    }

    pub(super) fn start_report(
        &mut self,
        mut threads: Vec<Thread>,
        limit: usize,
        archived: Option<bool>,
        query: Option<String>,
        issue_count: u64,
        allow_partial: bool,
    ) -> Result<ThreadListResult> {
        ensure_opt_in(issue_count, allow_partial)?;
        anyhow::ensure!(
            threads.len() <= MAX_THREADS,
            "thread/list snapshot exceeds thread budget"
        );
        self.remove_expired();
        threads.sort_by(|a, b| {
            let a_time = a.updated_at.parse::<i128>().unwrap_or_default();
            let b_time = b.updated_at.parse::<i128>().unwrap_or_default();
            b_time.cmp(&a_time).then_with(|| a.id.cmp(&b.id))
        });
        let limit = limit.clamp(1, 100);
        if threads.len() <= limit {
            return Ok(list_result(threads, None, issue_count, allow_partial));
        }

        let snapshot_id = self
            .next_id
            .checked_add(1)
            .context("thread/list snapshot IDs exhausted")?;
        let mut retained_threads = self
            .snapshots
            .values()
            .map(|snapshot| snapshot.threads.len())
            .sum::<usize>();
        while self.snapshots.len() >= MAX_SNAPSHOTS
            || retained_threads + threads.len() > MAX_THREADS
        {
            let (_, oldest) = self
                .snapshots
                .pop_first()
                .expect("snapshot budget requires an existing scan");
            retained_threads -= oldest.threads.len();
        }
        self.next_id = snapshot_id;
        self.snapshots.insert(
            snapshot_id,
            Snapshot {
                created_at: Instant::now(),
                threads,
                archived,
                query: normalize_query(query.as_deref()),
                issue_count,
            },
        );
        self.page_report(
            &format!("{snapshot_id}:0"),
            limit,
            None,
            None,
            allow_partial,
        )
    }

    #[cfg(test)]
    pub(super) fn page(
        &mut self,
        cursor: &str,
        limit: usize,
        archived: Option<bool>,
        query: Option<&str>,
    ) -> Result<ThreadListResult> {
        self.page_report(cursor, limit, archived, query, false)
    }

    pub(super) fn page_report(
        &mut self,
        cursor: &str,
        limit: usize,
        archived: Option<bool>,
        query: Option<&str>,
        allow_partial: bool,
    ) -> Result<ThreadListResult> {
        self.remove_expired();
        let (snapshot_id, offset) = cursor
            .split_once(':')
            .context("invalid thread/list cursor")?;
        let snapshot_id = snapshot_id
            .parse::<u64>()
            .context("invalid thread/list cursor")?;
        let offset = offset
            .parse::<usize>()
            .context("invalid thread/list cursor")?;
        let snapshot = self
            .snapshots
            .get(&snapshot_id)
            .context("expired thread/list cursor")?;
        ensure_opt_in(snapshot.issue_count, allow_partial)?;
        anyhow::ensure!(
            archived.is_none_or(|value| Some(value) == snapshot.archived)
                && query.is_none_or(|value| normalize_query(Some(value)) == snapshot.query),
            "thread/list cursor filters do not match snapshot"
        );
        anyhow::ensure!(
            offset <= snapshot.threads.len(),
            "invalid thread/list cursor"
        );
        let end = offset
            .saturating_add(limit.clamp(1, 100))
            .min(snapshot.threads.len());
        let threads = snapshot.threads[offset..end].to_vec();
        let next_cursor = (end < snapshot.threads.len()).then(|| format!("{snapshot_id}:{end}"));
        let result = list_result(threads, next_cursor, snapshot.issue_count, allow_partial);
        if result.next_cursor.is_none() {
            self.snapshots.remove(&snapshot_id);
        }
        Ok(result)
    }

    fn remove_expired(&mut self) {
        let now = Instant::now();
        self.snapshots
            .retain(|_, snapshot| now.duration_since(snapshot.created_at) < SNAPSHOT_TTL);
    }
}

fn ensure_opt_in(issue_count: u64, allow_partial: bool) -> Result<()> {
    anyhow::ensure!(
        issue_count == 0 || allow_partial,
        "thread/list is incomplete; explicit allowPartial is required"
    );
    Ok(())
}

fn list_result(
    threads: Vec<Thread>,
    next_cursor: Option<String>,
    issue_count: u64,
    allow_partial: bool,
) -> ThreadListResult {
    ThreadListResult {
        threads,
        next_cursor,
        completeness: allow_partial.then_some(if issue_count == 0 {
            ThreadListCompleteness::Complete
        } else {
            ThreadListCompleteness::Partial
        }),
        issue_count: allow_partial.then_some(issue_count),
    }
}

fn normalize_query(query: Option<&str>) -> Option<String> {
    query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_thread_list_requires_opt_in_on_every_page_without_consuming_cursor() {
        let mut snapshots = ThreadListSnapshots::default();
        assert!(
            snapshots
                .start_report(threads(), 1, None, None, 2, false)
                .is_err()
        );
        let first = snapshots
            .start_report(threads(), 1, None, None, 2, true)
            .unwrap();
        assert_eq!(first.completeness, Some(ThreadListCompleteness::Partial));
        assert_eq!(first.issue_count, Some(2));
        let cursor = first.next_cursor.as_deref().unwrap();
        assert!(
            snapshots
                .page_report(cursor, 100, None, None, false)
                .is_err()
        );
        let last = snapshots
            .page_report(cursor, 100, None, None, true)
            .unwrap();
        assert_eq!(last.completeness, first.completeness);
        assert_eq!(last.issue_count, Some(2));
        assert_eq!(ids(&last), ["b", "c"]);
        assert!(last.next_cursor.is_none());
    }

    #[test]
    fn partial_thread_list_complete_scan_preserves_legacy_wire_and_per_request_fields() {
        let mut snapshots = ThreadListSnapshots::default();
        let legacy = snapshots.start(threads(), 1, None, None).unwrap();
        let encoded = serde_json::to_value(&legacy).unwrap();
        assert!(encoded.get("completeness").is_none());
        assert!(encoded.get("issueCount").is_none());
        let page = snapshots
            .page_report(legacy.next_cursor.as_deref().unwrap(), 1, None, None, true)
            .unwrap();
        assert_eq!(page.completeness, Some(ThreadListCompleteness::Complete));
        assert_eq!(page.issue_count, Some(0));
        let last = snapshots
            .page_report(page.next_cursor.as_deref().unwrap(), 1, None, None, false)
            .unwrap();
        assert!(last.completeness.is_none());
        assert!(last.issue_count.is_none());
    }

    #[test]
    fn partial_thread_list_empty_partial_scan_still_requires_explicit_opt_in() {
        let mut snapshots = ThreadListSnapshots::default();
        assert!(
            snapshots
                .start_report(Vec::new(), 100, None, None, 1, false)
                .is_err()
        );
        let empty = snapshots
            .start_report(Vec::new(), 100, None, None, 1, true)
            .unwrap();
        assert_eq!(empty.completeness, Some(ThreadListCompleteness::Partial));
        assert_eq!(empty.issue_count, Some(1));
        assert!(empty.next_cursor.is_none());
    }

    fn thread(id: &str, updated_at: &str) -> Thread {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "status": "idle",
            "createdAt": "1",
            "updatedAt": updated_at,
        }))
        .unwrap()
    }

    fn threads() -> Vec<Thread> {
        vec![thread("b", "10"), thread("a", "10"), thread("c", "9")]
    }

    fn ids(page: &ThreadListResult) -> Vec<&str> {
        page.threads
            .iter()
            .map(|thread| thread.id.as_str())
            .collect()
    }

    #[test]
    fn sorts_numerically_with_session_id_tie_break() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots.start(threads(), 1, None, None).unwrap();
        assert_eq!(ids(&first), ["a"]);
        let second = snapshots
            .page(first.next_cursor.as_deref().unwrap(), 2, None, None)
            .unwrap();
        assert_eq!(ids(&second), ["b", "c"]);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn interleaved_scans_keep_their_immutable_snapshot() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots.start(threads(), 1, None, None).unwrap();
        let mut changed = threads();
        changed[2].updated_at = "20".into();
        let other = snapshots.start(changed, 1, None, None).unwrap();
        assert_eq!(ids(&other), ["c"]);
        let remaining = snapshots
            .page(first.next_cursor.as_deref().unwrap(), 2, None, None)
            .unwrap();
        assert_eq!(ids(&remaining), ["b", "c"]);
        assert!(
            snapshots
                .page(first.next_cursor.as_deref().unwrap(), 1, None, None)
                .is_err()
        );
        let remaining_other = snapshots
            .page(other.next_cursor.as_deref().unwrap(), 2, None, None)
            .unwrap();
        assert_eq!(ids(&remaining_other), ["a", "b"]);
        assert!(snapshots.snapshots.is_empty());
    }

    #[test]
    fn omitted_filters_inherit_and_equivalent_queries_are_accepted() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots
            .start(threads(), 1, Some(true), Some(" Example ".into()))
            .unwrap();
        let second = snapshots
            .page(first.next_cursor.as_deref().unwrap(), 1, None, None)
            .unwrap();
        let last = snapshots
            .page(
                second.next_cursor.as_deref().unwrap(),
                1,
                Some(true),
                Some("EXAMPLE"),
            )
            .unwrap();
        assert_eq!(ids(&last), ["c"]);
    }

    #[test]
    fn explicit_filter_changes_fail_without_consuming_snapshot() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots
            .start(threads(), 1, Some(false), Some("example".into()))
            .unwrap();
        let cursor = first.next_cursor.as_deref().unwrap();
        for (archived, query) in [(Some(true), None), (None, Some("other")), (None, Some(" "))] {
            let error = snapshots.page(cursor, 1, archived, query).unwrap_err();
            assert!(error.to_string().contains("filter"), "{error}");
        }
        assert_eq!(
            ids(&snapshots.page(cursor, 2, None, None).unwrap()),
            ["b", "c"]
        );
    }

    #[test]
    fn adding_filter_to_unfiltered_snapshot_is_rejected() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots.start(threads(), 1, None, None).unwrap();
        let cursor = first.next_cursor.as_deref().unwrap();
        assert!(snapshots.page(cursor, 1, Some(false), None).is_err());
        assert!(snapshots.page(cursor, 1, None, Some("added")).is_err());
        assert!(snapshots.page(cursor, 1, None, Some(" ")).is_ok());
    }

    #[test]
    fn expired_snapshot_is_rejected_and_removed() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots.start(threads(), 1, None, None).unwrap();
        snapshots.snapshots.values_mut().next().unwrap().created_at -= SNAPSHOT_TTL;
        let error = snapshots
            .page(first.next_cursor.as_deref().unwrap(), 1, None, None)
            .unwrap_err();
        assert!(error.to_string().contains("expired"), "{error}");
        assert!(snapshots.snapshots.is_empty());
    }

    #[test]
    fn capacity_evicts_oldest_scan_without_touching_newer_scans() {
        let mut snapshots = ThreadListSnapshots::default();
        let mut cursors = Vec::new();
        for _ in 0..=MAX_SNAPSHOTS {
            cursors.push(
                snapshots
                    .start(threads(), 1, None, None)
                    .unwrap()
                    .next_cursor
                    .unwrap(),
            );
        }
        assert_eq!(snapshots.snapshots.len(), MAX_SNAPSHOTS);
        assert!(snapshots.page(&cursors[0], 1, None, None).is_err());
        for cursor in &cursors[1..] {
            assert_eq!(
                ids(&snapshots.page(cursor, 2, None, None).unwrap()),
                ["b", "c"]
            );
        }
    }

    #[test]
    fn aggregate_thread_budget_evicts_oldest_scan() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots
            .start(vec![thread("a", "1"); 60_000], 1, None, None)
            .unwrap();
        let second = snapshots
            .start(vec![thread("b", "1"); 40_001], 1, None, None)
            .unwrap();
        assert_eq!(snapshots.snapshots.len(), 1);
        assert!(
            snapshots
                .page(first.next_cursor.as_deref().unwrap(), 1, None, None)
                .is_err()
        );
        assert!(
            snapshots
                .page(second.next_cursor.as_deref().unwrap(), 1, None, None)
                .is_ok()
        );
    }

    #[test]
    fn oversized_scan_fails_without_evicting_existing_scan() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots.start(threads(), 1, None, None).unwrap();
        let error = snapshots
            .start(vec![thread("large", "1"); MAX_THREADS + 1], 1, None, None)
            .unwrap_err();
        assert!(error.to_string().contains("budget"), "{error}");
        assert!(
            snapshots
                .page(first.next_cursor.as_deref().unwrap(), 1, None, None)
                .is_ok()
        );
    }

    #[test]
    fn invalid_cursors_fail_without_consuming_valid_scan() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots.start(threads(), 1, None, None).unwrap();
        let cursor = first.next_cursor.as_deref().unwrap();
        let snapshot_id = cursor.split_once(':').unwrap().0;
        for invalid in [
            "bad".into(),
            "1:bad".into(),
            "1:1:1".into(),
            format!("{snapshot_id}:4"),
        ] {
            assert!(snapshots.page(&invalid, 1, None, None).is_err());
        }
        assert!(snapshots.page(cursor, 1, None, None).is_ok());
    }

    #[test]
    fn single_page_scan_does_not_evict_retained_scans() {
        let mut snapshots = ThreadListSnapshots::default();
        for _ in 0..MAX_SNAPSHOTS {
            snapshots.start(threads(), 1, None, None).unwrap();
        }
        let before = snapshots.snapshots.keys().copied().collect::<Vec<_>>();
        assert!(
            snapshots
                .start(Vec::new(), 1, None, None)
                .unwrap()
                .next_cursor
                .is_none()
        );
        assert!(
            snapshots
                .start(threads(), 3, None, None)
                .unwrap()
                .next_cursor
                .is_none()
        );
        assert_eq!(
            snapshots.snapshots.keys().copied().collect::<Vec<_>>(),
            before
        );
    }

    #[test]
    fn page_limit_is_bounded_and_always_makes_progress() {
        let mut snapshots = ThreadListSnapshots::default();
        let first = snapshots
            .start(vec![thread("a", "1"); 102], 0, None, None)
            .unwrap();
        assert_eq!(first.threads.len(), 1);
        let second = snapshots
            .page(
                first.next_cursor.as_deref().unwrap(),
                usize::MAX,
                None,
                None,
            )
            .unwrap();
        assert_eq!(second.threads.len(), 100);
        assert!(second.next_cursor.is_some());
    }
}
