use super::SkillStoreError;
use std::path::{Component, Path, PathBuf};

pub(crate) const TRANSACTIONS_DIR: &str = ".transactions";
pub(crate) const ARCHIVE_DIR: &str = ".archive";
pub(crate) const COMMITS_FILE: &str = ".commits.jsonl";
pub(crate) const STATE_FILE: &str = ".store-state.json";
pub(crate) const PROVENANCE_FILE: &str = ".provenance.json";
pub(crate) const USAGE_FILE: &str = ".usage.json";
pub(crate) const BUNDLED_MANIFEST_FILE: &str = ".bundled_manifest";
pub(crate) const BUILTIN_MANIFEST_FILE: &str = ".builtin_manifest";
pub(crate) const CURATOR_LOG_FILE: &str = ".curator.log";
pub(crate) const RELOAD_PENDING_FILE: &str = ".reload-pending.json";

#[derive(Debug, Clone)]
pub(crate) struct StoreLayout {
    pub(crate) root: PathBuf,
    pub(crate) lock: PathBuf,
}

impl StoreLayout {
    pub(crate) fn new(root: &Path) -> Result<Self, SkillStoreError> {
        let root = absolute_lexical(root)?;
        let parent = root.parent().ok_or_else(|| {
            SkillStoreError::InvalidPackage(format!(
                "skill root must have a parent: {}",
                root.display()
            ))
        })?;
        let file_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                SkillStoreError::InvalidPackage(format!(
                    "skill root must have a UTF-8 directory name: {}",
                    root.display()
                ))
            })?;
        for candidate in [root.as_path(), parent] {
            if let Ok(metadata) = std::fs::symlink_metadata(candidate)
                && (metadata.file_type().is_symlink() || !metadata.is_dir())
            {
                return Err(SkillStoreError::UnsupportedFileType(
                    candidate.to_path_buf(),
                ));
            }
        }
        Ok(Self {
            root: root.clone(),
            lock: parent.join(format!("{file_name}.lock")),
        })
    }

    pub(crate) fn transactions(&self) -> PathBuf {
        self.root.join(TRANSACTIONS_DIR)
    }

    pub(crate) fn transaction(&self, id: &str) -> PathBuf {
        self.transactions().join(id)
    }

    pub(crate) fn archive(&self) -> PathBuf {
        self.root.join(ARCHIVE_DIR)
    }

    pub(crate) fn commits(&self) -> PathBuf {
        self.root.join(COMMITS_FILE)
    }

    pub(crate) fn state(&self) -> PathBuf {
        self.root.join(STATE_FILE)
    }

    pub(crate) fn usage_lock(&self) -> PathBuf {
        self.root.join(format!("{USAGE_FILE}.lock"))
    }
}

pub fn validate_skill_name(name: &str) -> Result<(), SkillStoreError> {
    if name.is_empty() || name.chars().count() > 64 {
        return Err(SkillStoreError::InvalidPackage(
            "skill name must contain 1..=64 characters".to_string(),
        ));
    }
    let mut chars = name.chars();
    let first = chars.next().expect("empty name rejected above");
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(SkillStoreError::InvalidPackage(format!(
            "invalid skill name '{name}'"
        )));
    }
    if !chars.all(|value| {
        value.is_ascii_lowercase() || value.is_ascii_digit() || matches!(value, '-' | '_' | '.')
    }) {
        return Err(SkillStoreError::InvalidPackage(format!(
            "invalid skill name '{name}'"
        )));
    }
    if name.starts_with('.') {
        return Err(SkillStoreError::InvalidPackage(format!(
            "reserved skill name '{name}'"
        )));
    }
    Ok(())
}

pub(crate) fn canonical_relative_path(path: &Path) -> Result<String, SkillStoreError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(SkillStoreError::PathEscapesRoot(path.to_path_buf()));
    }
    let mut values = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or_else(|| {
                    SkillStoreError::InvalidPackage(format!(
                        "non-UTF-8 package path: {}",
                        path.display()
                    ))
                })?;
                if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\'])
                {
                    return Err(SkillStoreError::PathEscapesRoot(path.to_path_buf()));
                }
                values.push(value);
            }
            _ => return Err(SkillStoreError::PathEscapesRoot(path.to_path_buf())),
        }
    }
    if values.is_empty() {
        return Err(SkillStoreError::PathEscapesRoot(path.to_path_buf()));
    }
    Ok(values.join("/"))
}

pub(crate) fn validate_managed_file(path: &Path) -> Result<String, SkillStoreError> {
    let canonical = canonical_relative_path(path)?;
    let mut parts = canonical.split('/');
    let first = parts.next().expect("canonical path is non-empty");
    let remaining = parts.next();
    let allowed = match (first, remaining) {
        ("SKILL.md", None) => true,
        (root_file, None) => !root_file.starts_with('.') && root_file != "SKILL.md.new",
        // Bundled skill packages also ship fonts, evaluator helpers, GIF code and themes.
        // These remain ordinary package assets; storing them never executes their content.
        (
            "references" | "templates" | "scripts" | "assets" | "examples" | "canvas-fonts"
            | "agents" | "eval-viewer" | "core" | "themes",
            Some(_),
        ) => true,
        _ => false,
    };
    if !allowed
        || canonical
            .rsplit('/')
            .next()
            .is_some_and(|file_name| file_name.ends_with(".new"))
    {
        return Err(SkillStoreError::InvalidPackage(format!(
            "unsupported managed package path '{canonical}'"
        )));
    }
    Ok(canonical)
}

pub(crate) fn validate_internal_relative_path(path: &Path) -> Result<PathBuf, SkillStoreError> {
    let canonical = canonical_relative_path(path)?;
    if !canonical.starts_with(".transactions/")
        && !canonical.starts_with(".archive/")
        && !matches!(
            canonical.as_str(),
            COMMITS_FILE
                | STATE_FILE
                | PROVENANCE_FILE
                | USAGE_FILE
                | BUNDLED_MANIFEST_FILE
                | BUILTIN_MANIFEST_FILE
                | CURATOR_LOG_FILE
                | RELOAD_PENDING_FILE
        )
    {
        validate_skill_name(canonical.split('/').next().unwrap_or_default())?;
    }
    Ok(PathBuf::from(canonical))
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, SkillStoreError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| SkillStoreError::io("resolving current directory", error))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(SkillStoreError::PathEscapesRoot(path.to_path_buf()));
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escape_and_windows_separator_injection() {
        assert!(canonical_relative_path(Path::new("../secret")).is_err());
        assert!(canonical_relative_path(Path::new("references\\secret")).is_err());
        assert!(canonical_relative_path(Path::new("/absolute")).is_err());
    }

    #[test]
    fn accepts_only_managed_package_locations() {
        assert_eq!(
            validate_managed_file(Path::new("references/guide.md")).unwrap(),
            "references/guide.md"
        );
        assert!(validate_managed_file(Path::new("other/file.md")).is_err());
        assert!(validate_managed_file(Path::new("SKILL.md.new")).is_err());
        assert!(validate_managed_file(Path::new("references/guide.md.new")).is_err());
        for path in [
            "canvas-fonts/font.ttf",
            "agents/evaluator.md",
            "eval-viewer/index.html",
            "core/gif.py",
            "themes/blue.md",
        ] {
            assert!(validate_managed_file(Path::new(path)).is_ok());
        }
        for path in [
            "../escape.txt",
            "/absolute.txt",
            "canvas-fonts/../../escape",
            "core/code.py.new",
            ".transactions/file",
            "unknown/file",
        ] {
            assert!(validate_managed_file(Path::new(path)).is_err());
        }
    }
}
