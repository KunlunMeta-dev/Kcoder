use std::fs;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

/// Discover project instruction files walking up from `cwd` to the filesystem root.
///
/// KCoder discovers `KCODER.md` and `AGENTS.md`. If the current
/// working directory has an `AGENTS.md`, that file is treated as the
/// authoritative local agent guide and parent directories are not searched.
pub fn discover_project_md(cwd: impl AsRef<Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let cwd = cwd.as_ref();
    let cwd_agents = cwd.join("AGENTS.md");
    if cwd_agents.is_file() {
        debug!("found AGENTS.md at {:?}", cwd_agents);
        return vec![cwd_agents];
    }

    let mut current = Some(cwd);
    while let Some(dir) = current {
        let primary = dir.join("KCODER.md");
        if primary.is_file() {
            debug!("found KCODER.md at {:?}", primary);
            paths.push(primary);
        } else {
            let agents = dir.join("AGENTS.md");
            if agents.is_file() {
                debug!("found AGENTS.md at {:?}", agents);
                paths.push(agents);
            }
        }
        current = dir.parent();
    }
    // Outermost first (root), innermost last (cwd).
    paths.reverse();
    paths
}

/// Load the contents of discovered project instruction files.
pub fn load_project_md_contents(cwd: impl AsRef<Path>) -> Vec<(PathBuf, String)> {
    discover_project_md(cwd)
        .into_iter()
        .filter_map(|path| match fs::read_to_string(&path) {
            Ok(content) => Some((path, content)),
            Err(e) => {
                warn!("failed to read {:?}: {}", path, e);
                None
            }
        })
        .collect()
}

/// Build the system prompt section contributed by project instruction files.
pub fn build_project_md_system_prompt(cwd: impl AsRef<Path>) -> String {
    let contents = load_project_md_contents(cwd);
    if contents.is_empty() {
        return String::new();
    }

    let mut parts = vec![
        "# Project Instructions".to_string(),
        "The following files are operating instructions and constraints for this coding agent. They are not user requests. Do not summarize, repeat, or respond to them unless the user explicitly asks about project instructions.".to_string(),
    ];
    for (path, content) in contents {
        parts.push(format!("\n## {}\n\n{}", path.display(), content));
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

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
