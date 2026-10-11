//! Git-independent, bounded text baselines for live workspace progress.
use super::*;
use kcoder_types::tool_ui::WorkspaceFileProgress;
use similar::{ChangeTag, TextDiff};
use std::collections::{BTreeSet, HashMap, HashSet};

const MAX_ENTRIES: usize = 10_000;
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone)]
struct Entry {
    revision: String,
    digest: String,
    text: Option<Arc<str>>,
}

pub(super) struct Snapshot {
    entries: HashMap<String, Entry>,
    skipped: HashSet<String>,
    complete: bool,
}

pub(super) async fn capture(
    root: &Path,
    policy: &kcoder_config::TurnFileChangesSettings,
    previous: Option<&Snapshot>,
) -> Result<Snapshot> {
    use tokio::io::AsyncReadExt;
    let ignore = policy.compile_ignore_globs()?;
    let mut result = Snapshot {
        entries: HashMap::new(),
        skipped: HashSet::new(),
        complete: true,
    };
    let mut directories = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    let mut total_bytes = 0_u64;
    let deadline = std::time::Instant::now() + Duration::from_millis(1500);
    while let Some((directory, depth)) = directories.pop() {
        if workspace_io::parent(root, &directory).is_err() {
            result.complete = false;
            continue;
        }
        let mut children = match tokio::fs::read_dir(&directory).await {
            Ok(children) => children,
            Err(_) => {
                result.complete = false;
                continue;
            }
        };
        while let Some(child) = children.next_entry().await? {
            count += 1;
            if count > MAX_ENTRIES || std::time::Instant::now() >= deadline {
                result.complete = false;
                return Ok(result);
            }
            let path = child.path();
            let relative = path.strip_prefix(root)?;
            if relative
                .components()
                .any(|component| component.as_os_str() == ".git")
                || policy.excludes(relative, &ignore)
            {
                continue;
            }
            let key = relative.to_string_lossy().into_owned();
            let kind = match child.file_type().await {
                Ok(kind) => kind,
                Err(_) => {
                    result.skipped.insert(key);
                    continue;
                }
            };
            if kind.is_dir() {
                if depth < 32 {
                    directories.push((path, depth + 1));
                } else {
                    result.complete = false;
                }
                continue;
            }
            if !kind.is_file() {
                result.skipped.insert(key);
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                result.skipped.insert(key);
                continue;
            };
            let opened = workspace_io::file(root, &directory, name);
            let Ok((_, parent, leaf, opened)) = opened else {
                result.skipped.insert(key);
                continue;
            };
            let Ok((metadata, revision)) = workspace_revision::snapshot(&opened) else {
                result.skipped.insert(key);
                continue;
            };
            if metadata.len() > MAX_FILE_BYTES
                || policy.file_exceeds_limit(metadata.len())
                || total_bytes.saturating_add(metadata.len()) > MAX_BYTES
            {
                result.skipped.insert(key);
                continue;
            }
            total_bytes += metadata.len();
            if let Some(old) = previous
                .and_then(|value| value.entries.get(&key))
                .filter(|old| old.revision == revision)
            {
                result.entries.insert(key, old.clone());
                continue;
            }
            let mut file = tokio::fs::File::from_std(opened);
            let mut bytes = Vec::new();
            let read = (&mut file)
                .take(MAX_FILE_BYTES + 1)
                .read_to_end(&mut bytes)
                .await;
            let opened = file.into_std().await;
            let current = parent.open_regular_file(&leaf);
            if read.is_err()
                || bytes.len() as u64 > MAX_FILE_BYTES
                || workspace_revision::revision(&opened).ok().as_ref() != Some(&revision)
                || current
                    .as_ref()
                    .ok()
                    .and_then(|file| workspace_revision::revision(file).ok())
                    .as_ref()
                    != Some(&revision)
            {
                result.skipped.insert(key);
                continue;
            }
            let digest = hex_sha256(&bytes);
            let text = if bytes.iter().take(8000).any(|byte| *byte == 0) {
                None
            } else {
                String::from_utf8(bytes).ok().map(Arc::from)
            };
            result.entries.insert(
                key,
                Entry {
                    revision,
                    digest,
                    text,
                },
            );
        }
    }
    Ok(result)
}

pub(super) fn compare(before: &Snapshot, after: &Snapshot) -> WorkspaceFileProgress {
    let mut counts = WorkspaceFileProgress {
        partial: !before.complete
            || !after.complete
            || !before.skipped.is_empty()
            || !after.skipped.is_empty(),
        ..WorkspaceFileProgress::default()
    };
    let paths = before
        .entries
        .keys()
        .chain(after.entries.keys())
        .collect::<BTreeSet<_>>();
    let deadline = std::time::Instant::now() + Duration::from_millis(100);
    for path in paths {
        if std::time::Instant::now() >= deadline {
            counts.partial = true;
            break;
        }
        if before.skipped.contains(path) || after.skipped.contains(path) {
            continue;
        }
        let old = before.entries.get(path);
        let new = after.entries.get(path);
        if old.is_some_and(|old| new.is_some_and(|new| old.digest == new.digest)) {
            continue;
        }
        if (old.is_none() && !before.complete) || (new.is_none() && !after.complete) {
            counts.partial = true;
            continue;
        }
        counts.files += 1;
        if old.is_some_and(|entry| entry.text.is_none())
            || new.is_some_and(|entry| entry.text.is_none())
        {
            counts.binary_files += 1;
            continue;
        }
        let old_text = old
            .and_then(|entry| entry.text.as_deref())
            .unwrap_or_default();
        let new_text = new
            .and_then(|entry| entry.text.as_deref())
            .unwrap_or_default();
        let diff = TextDiff::configure()
            .timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .diff_lines(old_text, new_text);
        for change in diff.iter_all_changes() {
            match change.tag() {
                ChangeTag::Insert => counts.additions += 1,
                ChangeTag::Delete => counts.deletions += 1,
                ChangeTag::Equal => {}
            }
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn counts_text_and_binary_changes_without_git_or_a_repository() {
        let workspace = tempfile::tempdir().unwrap();
        let policy = kcoder_config::TurnFileChangesSettings::default();
        std::fs::write(workspace.path().join("old.txt"), "before\nsecond\n").unwrap();
        std::fs::write(workspace.path().join("gone.txt"), "gone\n").unwrap();
        let before = capture(workspace.path(), &policy, None).await.unwrap();
        std::fs::write(workspace.path().join("old.txt"), "after\n").unwrap();
        std::fs::remove_file(workspace.path().join("gone.txt")).unwrap();
        std::fs::write(workspace.path().join("new.txt"), "new\nmore\n").unwrap();
        std::fs::write(workspace.path().join("binary.bin"), [0, 1, 2]).unwrap();
        let after = capture(workspace.path(), &policy, Some(&before))
            .await
            .unwrap();
        let counts = compare(&before, &after);
        assert_eq!(
            (
                counts.additions,
                counts.deletions,
                counts.files,
                counts.binary_files
            ),
            (3, 3, 4, 1)
        );
        assert!(!counts.partial);
        assert!(!workspace.path().join(".git").exists());
    }
}
