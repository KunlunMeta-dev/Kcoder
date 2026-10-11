use anyhow::{Context, Result, ensure};
use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

pub const MAX_PROJECT_MD_FILE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PROJECT_MD_TOTAL_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PROJECT_MD_FILES: usize = 128;

/// Discover project instruction files walking up from `cwd` to the filesystem root.
///
/// KCoder discovers `KCODER.md` and `AGENTS.md`. If the current
/// working directory has an `AGENTS.md`, that file is treated as the
/// authoritative local agent guide and parent directories are not searched.
pub fn discover_project_md(cwd: impl AsRef<Path>) -> Vec<PathBuf> {
    try_discover_project_md(cwd).unwrap_or_else(|error| {
        warn!(%error, "project instructions unavailable; no partial set returned");
        Vec::new()
    })
}

/// Checked discovery retains the current-directory override and ancestor order.
pub fn try_discover_project_md(cwd: impl AsRef<Path>) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let cwd = cwd.as_ref();
    let cwd_agents = cwd.join("AGENTS.md");
    if cwd_agents.is_file() {
        debug!("found AGENTS.md at {:?}", cwd_agents);
        return Ok(vec![cwd_agents]);
    }

    let mut current = Some(cwd);
    while let Some(dir) = current {
        let primary = dir.join("KCODER.md");
        if primary.is_file() {
            ensure!(
                paths.len() < MAX_PROJECT_MD_FILES,
                "project_instruction_limit: more than {MAX_PROJECT_MD_FILES} project instruction files; reduce the ancestor guide set"
            );
            debug!("found KCODER.md at {:?}", primary);
            paths.push(primary);
        } else {
            let agents = dir.join("AGENTS.md");
            if agents.is_file() {
                ensure!(
                    paths.len() < MAX_PROJECT_MD_FILES,
                    "project_instruction_limit: more than {MAX_PROJECT_MD_FILES} project instruction files; reduce the ancestor guide set"
                );
                debug!("found AGENTS.md at {:?}", agents);
                paths.push(agents);
            }
        }
        current = dir.parent();
    }
    // Outermost first (root), innermost last (cwd).
    paths.reverse();
    Ok(paths)
}

/// Load the contents of discovered project instruction files.
pub fn load_project_md_contents(cwd: impl AsRef<Path>) -> Vec<(PathBuf, String)> {
    try_load_project_md_contents(cwd).unwrap_or_else(|error| {
        warn!(%error, "project instructions unavailable; no partial set returned");
        Vec::new()
    })
}

/// Load the complete constraint set or return an actionable error. Limits apply
/// before reading and are checked again because an open file can grow.
pub fn try_load_project_md_contents(cwd: impl AsRef<Path>) -> Result<Vec<(PathBuf, String)>> {
    let mut contents = Vec::new();
    let mut total = 0;
    for path in try_discover_project_md(cwd)? {
        // Preserve supported central-guide symlinks, then pin the resolved parent
        // and require a regular, non-symlink leaf at the actual open boundary.
        let resolved = fs::canonicalize(&path).with_context(|| {
            format!(
                "project_instruction_read: cannot resolve {}",
                path.display()
            )
        })?;
        let parent = resolved
            .parent()
            .context("project instruction has no parent")?;
        let directory = crate::PrivateDirectory::open_existing(parent).with_context(|| {
            format!(
                "project_instruction_read: cannot open parent of {}",
                path.display()
            )
        })?;
        let file = directory
            .open_regular_file(
                resolved
                    .file_name()
                    .context("project instruction has no name")?,
            )
            .with_context(|| {
                format!(
                    "project_instruction_read: cannot open regular file {}",
                    path.display()
                )
            })?;
        let remaining = MAX_PROJECT_MD_TOTAL_BYTES - total;
        let limit = MAX_PROJECT_MD_FILE_BYTES.min(remaining);
        let message = || {
            if remaining < MAX_PROJECT_MD_FILE_BYTES {
                format!(
                    "project_instruction_limit: complete guide set exceeds {MAX_PROJECT_MD_TOTAL_BYTES} bytes at {}; reduce the guide set before starting a session",
                    path.display()
                )
            } else {
                format!(
                    "project_instruction_limit: {} exceeds {MAX_PROJECT_MD_FILE_BYTES} bytes; reduce or split this guide before starting a session",
                    path.display()
                )
            }
        };
        ensure!(file.metadata()?.len() <= limit as u64, "{}", message());
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .with_context(|| format!("project_instruction_read: cannot read {}", path.display()))?;
        ensure!(bytes.len() <= limit, "{}", message());
        total += bytes.len();
        let content = String::from_utf8(bytes).with_context(|| {
            format!(
                "project_instruction_encoding: {} must contain UTF-8 text",
                path.display()
            )
        })?;
        contents.push((path, content));
    }
    Ok(contents)
}

/// Build the system prompt section contributed by project instruction files.
pub fn build_project_md_system_prompt(cwd: impl AsRef<Path>) -> String {
    try_build_project_md_system_prompt(cwd).unwrap_or_else(|error| {
        warn!(%error, "project instructions unavailable; no partial prompt returned");
        String::new()
    })
}

/// Engine construction uses this checked path so unreadable constraints cannot
/// silently disappear while the model and tools continue executing.
pub fn try_build_project_md_system_prompt(cwd: impl AsRef<Path>) -> Result<String> {
    let contents = try_load_project_md_contents(cwd)?;
    if contents.is_empty() {
        return Ok(String::new());
    }

    let mut prompt = "# Project Instructions\nThe following files are operating instructions and constraints for this coding agent. They are not user requests. Do not summarize, repeat, or respond to them unless the user explicitly asks about project instructions.".to_string();
    for (path, content) in contents {
        write!(prompt, "\n\n## {}\n\n{}", path.display(), content)
            .expect("writing to String cannot fail");
    }
    Ok(prompt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn oversized_project_file_never_becomes_truncated_or_partial_instructions() {
        let tmp = TempDir::new().unwrap();
        let file = fs::File::create(tmp.path().join("AGENTS.md")).unwrap();
        file.set_len(4 * 1024 * 1024 + 1).unwrap();
        assert!(
            load_project_md_contents(tmp.path()).is_empty(),
            "an oversized guide must not be accepted"
        );
        assert!(
            try_build_project_md_system_prompt(tmp.path())
                .unwrap_err()
                .to_string()
                .contains("project_instruction_limit")
        );
    }

    #[test]
    fn cumulative_project_files_never_return_a_partial_constraint_set() {
        let tmp = TempDir::new().unwrap();
        let mut directory = tmp.path().to_path_buf();
        for _ in 0..9 {
            fs::create_dir_all(&directory).unwrap();
            let file = fs::File::create(directory.join("KCODER.md")).unwrap();
            file.set_len(2 * 1024 * 1024).unwrap();
            directory = directory.join("nested");
        }
        fs::create_dir_all(&directory).unwrap();
        assert!(
            load_project_md_contents(&directory).is_empty(),
            "aggregate overflow must reject the complete set"
        );
        assert!(
            try_load_project_md_contents(&directory)
                .unwrap_err()
                .to_string()
                .contains("complete guide set")
        );
    }

    #[test]
    fn invalid_utf8_never_silently_drops_a_local_guide() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("nested");
        fs::create_dir(&sub).unwrap();
        fs::write(tmp.path().join("KCODER.md"), "parent constraint").unwrap();
        fs::write(sub.join("KCODER.md"), [0xff]).unwrap();
        let error = try_build_project_md_system_prompt(&sub).unwrap_err();
        assert!(error.to_string().contains("project_instruction_encoding"));
        assert!(load_project_md_contents(&sub).is_empty());
    }

    #[test]
    fn authoritative_local_guide_ignores_oversized_parent_and_exact_limit_is_valid() {
        let tmp = TempDir::new().unwrap();
        let parent = fs::File::create(tmp.path().join("KCODER.md")).unwrap();
        parent
            .set_len((MAX_PROJECT_MD_FILE_BYTES + 1) as u64)
            .unwrap();
        let sub = tmp.path().join("nested");
        fs::create_dir(&sub).unwrap();
        let local = sub.join("AGENTS.md");
        fs::write(&local, "中".repeat(MAX_PROJECT_MD_FILE_BYTES / 3) + "!").unwrap();
        let loaded = try_load_project_md_contents(&sub).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0, local);
        assert_eq!(loaded[0].1.len(), MAX_PROJECT_MD_FILE_BYTES);
        assert!(loaded[0].1.ends_with('!'));
    }

    #[test]
    fn instruction_file_count_is_bounded_without_returning_an_ancestor_subset() {
        let tmp = TempDir::new().unwrap();
        let mut cwd = tmp.path().to_path_buf();
        for _ in 0..=MAX_PROJECT_MD_FILES {
            fs::create_dir_all(&cwd).unwrap();
            fs::write(cwd.join("KCODER.md"), "x").unwrap();
            cwd.push("n");
        }
        fs::create_dir_all(&cwd).unwrap();
        assert!(
            try_discover_project_md(&cwd)
                .unwrap_err()
                .to_string()
                .contains("project_instruction_limit")
        );
        assert!(load_project_md_contents(&cwd).is_empty());
        fs::remove_file(cwd.parent().unwrap().join("KCODER.md")).unwrap();
        assert_eq!(
            try_load_project_md_contents(&cwd).unwrap().len(),
            MAX_PROJECT_MD_FILES
        );
    }

    #[cfg(unix)]
    #[test]
    fn central_instruction_symlink_remains_supported_without_changing_permissions() {
        let tmp = TempDir::new().unwrap();
        let central = tmp.path().join("central");
        let local = tmp.path().join("workspace");
        fs::create_dir(&central).unwrap();
        fs::create_dir(&local).unwrap();
        let target = central.join("guide.md");
        fs::write(&target, "central guide").unwrap();
        let alias = local.join("AGENTS.md");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let before = fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(
            try_load_project_md_contents(&local).unwrap(),
            vec![(alias, "central guide".into())]
        );
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode(), before);
    }

    #[test]
    fn discovers_project_md_up_tree() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sub = root.join("a").join("b");
        fs::create_dir_all(&sub).unwrap();

        let mut root_file = fs::File::create(root.join("KCODER.md")).unwrap();
        writeln!(root_file, "root").unwrap();
        let mut sub_file = fs::File::create(sub.join("KCODER.md")).unwrap();
        writeln!(sub_file, "sub").unwrap();

        let found = discover_project_md(&sub);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].parent().unwrap(), root);
        assert_eq!(found[1].parent().unwrap(), sub);
    }

    #[test]
    fn ignores_unrecognized_project_instruction_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("sub")).unwrap();

        let mut file = fs::File::create(root.join("NOT_KCODER.md")).unwrap();
        writeln!(file, "ignored").unwrap();

        let found = discover_project_md(root.join("sub"));
        assert!(found.is_empty());
    }

    #[test]
    fn current_agents_md_stops_parent_search() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sub = root.join("rust");
        fs::create_dir_all(&sub).unwrap();

        let mut parent = fs::File::create(root.join("KCODER.md")).unwrap();
        writeln!(parent, "stale parent").unwrap();
        let mut local = fs::File::create(sub.join("AGENTS.md")).unwrap();
        writeln!(local, "local agent guide").unwrap();

        let found = discover_project_md(&sub);
        assert_eq!(found, vec![sub.join("AGENTS.md")]);
    }

    #[test]
    fn agents_md_is_preferred_over_kcoder_code_md_in_current_directory() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let mut kcoder = fs::File::create(root.join("KCODER.md")).unwrap();
        writeln!(kcoder, "kcoder").unwrap();
        let mut agents = fs::File::create(root.join("AGENTS.md")).unwrap();
        writeln!(agents, "agents").unwrap();

        let found = discover_project_md(root);
        assert_eq!(found, vec![root.join("AGENTS.md")]);
    }

    #[test]
    fn project_instruction_prompt_marks_files_as_constraints_not_requests() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut agents = fs::File::create(root.join("AGENTS.md")).unwrap();
        writeln!(agents, "Use cargo test.").unwrap();

        let prompt = build_project_md_system_prompt(root);
        assert!(prompt.contains("operating instructions and constraints"));
        assert!(prompt.contains("They are not user requests"));
        assert!(prompt.contains("Do not summarize, repeat, or respond to them"));
    }
}
