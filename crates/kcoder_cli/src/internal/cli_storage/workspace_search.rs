//! Directory-handle search under the caller's authorized workspace anchors.
use anyhow::{Context, Result};
use kcoder_config::PrivateDirectory;
use serde_json::{Value, json};
use std::{
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
};

const WORKSPACE_SEARCH_MAX_DEPTH: usize = 20;
const WORKSPACE_SEARCH_MAX_ENTRIES: usize = 50_000;
const WORKSPACE_SEARCH_MAX_RESULTS: usize = 200;

pub fn workspace_search_open_authorized_root(
    requested_root: &Path,
    anchors: &[PathBuf],
) -> Result<Option<(PrivateDirectory, PathBuf)>> {
    for anchor in anchors {
        let Ok(anchor_path) = dunce::canonicalize(anchor) else {
            continue;
        };
        if workspace_search_root_suffix(&anchor_path, requested_root).is_none() {
            continue;
        }
        let anchor_directory =
            PrivateDirectory::open_existing(&anchor_path).with_context(|| {
                format!(
                    "failed to open workspace search anchor {}",
                    anchor_path.display()
                )
            })?;
        return workspace_search_open_relative_root(anchor_directory, &anchor_path, requested_root)
            .map(Some);
    }
    Ok(None)
}

fn workspace_search_open_relative_root(
    mut directory: PrivateDirectory,
    anchor_path: &Path,
    requested_root: &Path,
) -> Result<(PrivateDirectory, PathBuf)> {
    let suffix = workspace_search_root_suffix(anchor_path, requested_root)
        .context("workspace search root is outside its opened anchor")?;
    let mut opened_root = anchor_path.to_path_buf();
    for component in suffix {
        directory = directory.open_child(&component, false).with_context(|| {
            format!(
                "failed to open workspace search root component {}",
                component.to_string_lossy()
            )
        })?;
        opened_root.push(component);
    }
    Ok((directory, opened_root))
}

fn workspace_search_root_suffix(anchor: &Path, requested: &Path) -> Option<Vec<OsString>> {
    if !anchor.is_absolute() || !requested.is_absolute() {
        return None;
    }
    let anchor_components = anchor.components().collect::<Vec<_>>();
    let requested_components = requested.components().collect::<Vec<_>>();
    if anchor_components
        .iter()
        .chain(&requested_components)
        .any(|component| matches!(component, Component::ParentDir))
        || anchor_components.len() > requested_components.len()
        || !anchor_components
            .iter()
            .zip(&requested_components)
            .all(|(left, right)| workspace_search_component_eq(left.as_os_str(), right.as_os_str()))
    {
        return None;
    }
    requested_components[anchor_components.len()..]
        .iter()
        .map(|component| match component {
            Component::Normal(name) => Some(name.to_os_string()),
            _ => None,
        })
        .collect()
}

fn workspace_search_component_eq(left: &OsStr, right: &OsStr) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub fn workspace_search_scan(
    directory: PrivateDirectory,
    root: String,
    query: String,
) -> Result<Vec<Value>> {
    workspace_search_scan_with_limits(
        directory,
        root,
        query,
        WORKSPACE_SEARCH_MAX_ENTRIES,
        WORKSPACE_SEARCH_MAX_DEPTH,
        WORKSPACE_SEARCH_MAX_RESULTS,
    )
}

fn workspace_search_scan_with_limits(
    directory: PrivateDirectory,
    root: String,
    query: String,
    max_entries: usize,
    max_depth: usize,
    max_results: usize,
) -> Result<Vec<Value>> {
    workspace_search_scan_with_limits_and_hook(
        directory,
        root,
        query,
        max_entries,
        max_depth,
        max_results,
        |_, _| Ok(()),
    )
}

fn workspace_search_scan_with_limits_and_hook(
    directory: PrivateDirectory,
    root: String,
    query: String,
    max_entries: usize,
    max_depth: usize,
    max_results: usize,
    before_open_directory: impl FnMut(&PrivateDirectory, &OsStr) -> Result<()>,
) -> Result<Vec<Value>> {
    anyhow::ensure!(
        max_entries > 0 && max_entries <= 65_536,
        "invalid workspace search entry budget"
    );
    let mut scan = WorkspaceSearchScan {
        root,
        query,
        max_entries,
        max_depth,
        visited: 0,
        matches: Vec::new(),
        before_open_directory,
    };
    scan.visit_directory(&directory, "", 0)
        .context("workspace search inventory is incomplete")?;
    scan.matches.sort_by_key(|item| std::cmp::Reverse(item.0));
    scan.matches.truncate(max_results);
    Ok(scan.matches.into_iter().map(|(_, value)| value).collect())
}

struct WorkspaceSearchScan<F> {
    root: String,
    query: String,
    max_entries: usize,
    max_depth: usize,
    visited: usize,
    matches: Vec<(usize, Value)>,
    before_open_directory: F,
}

impl<F> WorkspaceSearchScan<F>
where
    F: FnMut(&PrivateDirectory, &OsStr) -> Result<()>,
{
    fn visit_directory(
        &mut self,
        directory: &PrivateDirectory,
        prefix: &str,
        depth: usize,
    ) -> Result<()> {
        let per_directory_budget = self.max_entries.saturating_sub(self.visited).max(1);
        directory.visit_entry_names_bounded(per_directory_budget, |name| {
            anyhow::ensure!(
                self.visited < self.max_entries,
                "workspace search exceeds its entry budget"
            );
            self.visited += 1;
            if matches!(
                name.to_str(),
                Some(".git" | "node_modules" | "target" | ".next")
            ) {
                return Ok(());
            }
            let Some(name_text) = name.to_str() else {
                // Invalid UTF-8 names cannot round-trip through the RPC path format.
                return Ok(());
            };
            let candidate = if prefix.is_empty() {
                name_text.to_owned()
            } else {
                format!("{prefix}/{name_text}")
            };
            let Some((relative, file_name)) = workspace_search_relative_path(
                Path::new("workspace"),
                &Path::new("workspace").join(&candidate),
            ) else {
                // Names with separator ambiguity or control characters cannot be opened safely
                // through the slash-separated client path format.
                return Ok(());
            };
            // Keep this no-follow handle alive until a directory child handle has been
            // opened and its stable identity compared, preventing inode/file-index ABA.
            let entry = directory.open_entry_handle(name)?;
            let metadata = entry.metadata();
            if metadata.file_type().is_symlink() {
                return Ok(());
            }
            let is_directory = metadata.is_dir();
            if is_directory {
                (self.before_open_directory)(directory, name)?;
                let child = entry.open_child_directory()?;
                drop(entry);
                self.push_match(&relative, &file_name, depth, true);
                if depth >= self.max_depth {
                    child.visit_entry_names_bounded(1, |_| {
                        anyhow::bail!("workspace search exceeds its depth limit")
                    })?;
                } else {
                    self.visit_directory(&child, &relative, depth + 1)?;
                }
            } else if metadata.is_file() {
                self.push_match(&relative, &file_name, depth, false);
            }
            Ok(())
        })?;
        Ok(())
    }

    fn push_match(&mut self, relative: &str, file_name: &str, depth: usize, is_directory: bool) {
        let haystack = relative.to_lowercase();
        if let Some(index) = haystack.find(&self.query) {
            let score = 10_000_usize
                .saturating_sub(index * 10)
                .saturating_sub(depth * 25)
                .saturating_sub(relative.len());
            self.matches.push((
                score,
                json!({
                    "root": self.root,
                    "path": relative,
                    "fileName": file_name,
                    "matchType": if is_directory { "directory" } else { "file" },
                    "score": score,
                    "indices": (index..index + self.query.len()).collect::<Vec<_>>(),
                }),
            ));
        }
    }
}

fn workspace_search_relative_path(root: &Path, path: &Path) -> Option<(String, String)> {
    let relative = path.strip_prefix(root).ok()?;
    let mut components = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return None;
        };
        let component = component.to_str()?;
        if component.is_empty()
            || component.contains(['/', '\\'])
            || component.chars().any(char::is_control)
        {
            return None;
        }
        components.push(component.to_owned());
    }
    let name = components.last()?.clone();
    Some((components.join("/"), name))
}

#[cfg(test)]
mod workspace_search_path_tests {
    use super::{
        workspace_search_open_authorized_root, workspace_search_open_relative_root,
        workspace_search_relative_path, workspace_search_root_suffix, workspace_search_scan,
        workspace_search_scan_with_limits, workspace_search_scan_with_limits_and_hook,
    };
    use kcoder_config::PrivateDirectory;
    use serde_json::Value;
    use std::path::Path;

    fn result_paths(results: &[Value]) -> Vec<String> {
        results
            .iter()
            .map(|result| result["path"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn path_mapping_preserves_relative_components() {
        let root = Path::new("workspace");
        assert_eq!(
            workspace_search_relative_path(root, Path::new("workspace/foo/bar.rs")),
            Some(("foo/bar.rs".to_owned(), "bar.rs".to_owned()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_mapping_skips_separator_ambiguous_unix_names() {
        let root = Path::new("/workspace");
        assert_eq!(
            workspace_search_relative_path(root, Path::new("/workspace/foo\\bar.rs")),
            None,
            "a Unix filename containing a backslash must not map to a nested path"
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_mapping_skips_lossy_unicode_collisions() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let root = Path::new("/workspace");
        let invalid_utf8 =
            Path::new("/workspace").join(OsString::from_vec(b"name-\xff.rs".to_vec()));
        let replacement_character = Path::new("/workspace/name-\u{fffd}.rs");

        assert_eq!(workspace_search_relative_path(root, &invalid_utf8), None);
        assert_eq!(
            workspace_search_relative_path(root, replacement_character),
            Some(("name-\u{fffd}.rs".to_owned(), "name-\u{fffd}.rs".to_owned()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_mapping_skips_control_bytes() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let root = Path::new("/workspace");
        let control_byte =
            Path::new("/workspace").join(OsString::from_vec(b"file-\x01.rs".to_vec()));

        assert_eq!(workspace_search_relative_path(root, &control_byte), None);
    }

    #[test]
    fn root_suffix_requires_component_containment_and_rejects_parent_segments() {
        let anchor = Path::new("/workspace/project");
        assert_eq!(
            workspace_search_root_suffix(anchor, Path::new("/workspace/project/src")),
            Some(vec![std::ffi::OsString::from("src")])
        );
        assert_eq!(
            workspace_search_root_suffix(anchor, Path::new("/workspace/project-old/src")),
            None
        );
        assert_eq!(
            workspace_search_root_suffix(anchor, Path::new("/workspace/project/../outside")),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_and_unc_roots_match_by_component_without_prefix_collisions() {
        let drive = std::path::PathBuf::from(r"C:\Work");
        assert_eq!(
            workspace_search_root_suffix(&drive, Path::new(r"c:\work\src")),
            Some(vec![std::ffi::OsString::from("src")])
        );
        assert_eq!(
            workspace_search_root_suffix(&drive, Path::new(r"c:\worker\src")),
            None
        );
        let unc = std::path::PathBuf::from(r"\\server\share\workspace");
        assert_eq!(
            workspace_search_root_suffix(&unc, Path::new(r"\\SERVER\SHARE\workspace\src")),
            Some(vec![std::ffi::OsString::from("src")])
        );
    }

    #[test]
    fn workspace_root_and_child_replacements_keep_the_opened_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let held_root = temp.path().join("workspace-held");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("inside-needle.txt"), b"inside").unwrap();

        let opened = PrivateDirectory::open_existing(&root).unwrap();
        let root_text = root.to_str().unwrap().to_owned();
        std::fs::rename(&root, &held_root).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("replacement-needle.txt"), b"replacement").unwrap();

        let results = workspace_search_scan(opened, root_text, "needle".to_owned()).unwrap();
        assert_eq!(result_paths(&results), ["inside-needle.txt"]);
        drop(results);
        std::fs::remove_dir_all(&held_root).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn opened_child_handle_stays_pinned_after_path_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let child_path = root.join("src");
        let held_child_path = root.join("src-held");
        std::fs::create_dir_all(&child_path).unwrap();
        std::fs::write(child_path.join("inside-needle.rs"), b"inside").unwrap();
        let root_handle = PrivateDirectory::open_existing(&root).unwrap();
        let requested = child_path.clone();

        let pinned = workspace_search_open_relative_root(
            PrivateDirectory::open_existing(&root).unwrap(),
            &root,
            &requested,
        )
        .unwrap();
        std::fs::rename(&child_path, &held_child_path).unwrap();
        std::fs::create_dir(&child_path).unwrap();
        std::fs::write(child_path.join("replacement-needle.rs"), b"replacement").unwrap();
        let pinned_root = pinned.1.to_str().unwrap().to_owned();
        let results = workspace_search_scan(pinned.0, pinned_root, "needle".to_owned()).unwrap();
        assert_eq!(result_paths(&results), ["inside-needle.rs"]);

        let (replacement, replacement_root) =
            workspace_search_open_relative_root(root_handle, &root, &requested).unwrap();
        let replacement_results = workspace_search_scan(
            replacement,
            replacement_root.to_str().unwrap().to_owned(),
            "needle".to_owned(),
        )
        .unwrap();
        assert_eq!(
            result_paths(&replacement_results),
            ["replacement-needle.rs"]
        );
        drop(results);
        drop(replacement_results);
        std::fs::remove_dir_all(&held_child_path).unwrap();
        std::fs::remove_dir_all(&child_path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replacing_open_root_with_external_symlink_does_not_redirect_scan() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        let held_root = temp.path().join("workspace-held");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("inside-needle.txt"), b"inside").unwrap();
        std::fs::write(outside.join("outside-needle.txt"), b"outside").unwrap();
        let opened = PrivateDirectory::open_existing(&root).unwrap();
        std::fs::rename(&root, &held_root).unwrap();
        symlink(&outside, &root).unwrap();

        let results = workspace_search_scan(
            opened,
            root.to_str().unwrap().to_owned(),
            "needle".to_owned(),
        )
        .unwrap();
        assert_eq!(result_paths(&results), ["inside-needle.txt"]);
        drop(results);
        std::fs::remove_dir_all(&held_root).unwrap();
        std::fs::remove_file(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaced_child_symlink_is_rejected_before_open() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let child_path = root.join("src");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&child_path).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("outside-needle.rs"), b"outside").unwrap();
        let root_handle = PrivateDirectory::open_existing(&root).unwrap();
        std::fs::remove_dir(&child_path).unwrap();
        symlink(&outside, &child_path).unwrap();

        assert!(workspace_search_open_relative_root(root_handle, &root, &child_path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn scanner_excludes_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("needle.txt"), b"outside").unwrap();
        symlink(outside.join("needle.txt"), root.join("needle-file-link")).unwrap();
        symlink(&outside, root.join("needle-directory-link")).unwrap();

        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let results = workspace_search_scan(
            directory,
            root.to_str().unwrap().to_owned(),
            "needle".to_owned(),
        )
        .unwrap();
        assert!(results.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn scanner_reports_special_entry_as_incomplete_inventory() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let fifo = CString::new(root.join("pipe").as_os_str().as_bytes()).unwrap();
        // SAFETY: `fifo` is a valid NUL-terminated path and no pointer escapes.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

        let error = workspace_search_scan(
            PrivateDirectory::open_existing(&root).unwrap(),
            root.to_string_lossy().into_owned(),
            "needle".to_owned(),
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("workspace search inventory is incomplete"));
        assert!(message.contains("entry must be a file, directory, or link"));
    }

    #[cfg(unix)]
    #[test]
    fn scanner_fails_closed_when_child_directory_is_replaced_after_metadata() {
        use std::ffi::OsStr;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let child = root.join("src");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join("inside-needle.rs"), b"inside").unwrap();

        let mut replaced = false;
        let error = workspace_search_scan_with_limits_and_hook(
            PrivateDirectory::open_existing(&root).unwrap(),
            root.to_string_lossy().into_owned(),
            "needle".to_owned(),
            100,
            20,
            200,
            |_, name| {
                if name == OsStr::new("src") && !replaced {
                    std::fs::remove_dir_all(&child)?;
                    std::fs::create_dir(&child)?;
                    std::fs::write(child.join("outside-needle.rs"), b"replacement")?;
                    replaced = true;
                }
                Ok(())
            },
        )
        .unwrap_err();

        let message = format!("{error:#}");
        assert!(replaced, "the deterministic replacement hook must run");
        assert!(message.contains("workspace search inventory is incomplete"));
        assert!(message.contains("directory entry changed"));
        assert!(!message.contains("outside-needle.rs"));
    }

    #[test]
    fn scanner_fails_explicitly_when_entry_or_depth_budget_is_exceeded() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        for name in ["one-needle", "two-needle", "three-needle"] {
            std::fs::write(root.join(name), b"x").unwrap();
        }
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let error = workspace_search_scan_with_limits(
            directory,
            root.to_str().unwrap().to_owned(),
            "needle".to_owned(),
            2,
            20,
            200,
        )
        .unwrap_err();
        assert!(error.to_string().contains("incomplete"));

        let depth_root = temp.path().join("depth-workspace");
        std::fs::create_dir_all(depth_root.join("one").join("two")).unwrap();
        std::fs::write(depth_root.join("one").join("two").join("needle.txt"), b"x").unwrap();
        let directory = PrivateDirectory::open_existing(&depth_root).unwrap();
        let error = workspace_search_scan_with_limits(
            directory,
            depth_root.to_str().unwrap().to_owned(),
            "needle".to_owned(),
            100,
            1,
            200,
        )
        .unwrap_err();
        assert!(error.to_string().contains("incomplete"));
    }

    #[test]
    fn authorized_root_opens_only_beneath_a_trusted_anchor() {
        let temp = tempfile::tempdir().unwrap();
        let anchor = temp.path().join("workspace");
        let child = anchor.join("src");
        std::fs::create_dir_all(&child).unwrap();
        let (directory, root) =
            workspace_search_open_authorized_root(&child, std::slice::from_ref(&anchor))
                .unwrap()
                .unwrap();
        assert_eq!(root, child);
        assert!(directory.directory_metadata().unwrap().is_dir());
        assert!(
            workspace_search_open_authorized_root(
                &temp.path().join("outside"),
                std::slice::from_ref(&anchor),
            )
            .unwrap()
            .is_none()
        );
    }
}
