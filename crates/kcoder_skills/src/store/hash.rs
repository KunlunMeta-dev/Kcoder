use super::layout::{validate_managed_file, validate_skill_name};
use super::{SkillPackage, SkillPackageFile, SkillRevision, SkillStoreError};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const HASH_FORMAT: &[u8] = b"kcoder.skill-package/1\0";

pub fn canonical_package_revision(
    package: &SkillPackage,
) -> Result<SkillRevision, SkillStoreError> {
    validate_skill_name(&package.name)?;
    let files = canonical_files(&package.files)?;
    if !files.contains_key("SKILL.md") {
        return Err(SkillStoreError::InvalidPackage(format!(
            "skill '{}' is missing SKILL.md",
            package.name
        )));
    }

    let mut hasher = Sha256::new();
    hasher.update(HASH_FORMAT);
    for (path, file) in files {
        hash_u64(&mut hasher, path.len() as u64);
        hasher.update(path.as_bytes());
        hasher.update([b'f']);
        hasher.update([u8::from(file.executable)]);
        hash_u64(&mut hasher, file.content.len() as u64);
        hasher.update(&file.content);
    }
    Ok(SkillRevision(format!("sha256:{:x}", hasher.finalize())))
}

pub fn skill_revision(skill_dir: &Path) -> Result<Option<SkillRevision>, SkillStoreError> {
    let Some(name) = skill_dir.file_name().and_then(|name| name.to_str()) else {
        return Err(SkillStoreError::InvalidPackage(format!(
            "skill directory has no UTF-8 name: {}",
            skill_dir.display()
        )));
    };
    if !skill_dir.exists() {
        return Ok(None);
    }
    let package = load_package(skill_dir, name)?;
    canonical_package_revision(&package).map(Some)
}

pub(crate) fn load_package(skill_dir: &Path, name: &str) -> Result<SkillPackage, SkillStoreError> {
    validate_skill_name(name)?;
    let metadata = fs::symlink_metadata(skill_dir)
        .map_err(|error| SkillStoreError::io("reading skill directory metadata", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SkillStoreError::UnsupportedFileType(
            skill_dir.to_path_buf(),
        ));
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(skill_dir).follow_links(false) {
        let entry = entry.map_err(|error| {
            let io = error
                .io_error()
                .map(|error| std::io::Error::new(error.kind(), error.to_string()))
                .unwrap_or_else(|| std::io::Error::other(error.to_string()));
            SkillStoreError::io("walking skill package", io)
        })?;
        if entry.path() == skill_dir {
            continue;
        }
        let file_type = entry.file_type();
        if file_type.is_dir() {
            continue;
        }
        if !file_type.is_file() || file_type.is_symlink() {
            return Err(SkillStoreError::UnsupportedFileType(
                entry.path().to_path_buf(),
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(skill_dir)
            .map_err(|_| SkillStoreError::PathEscapesRoot(entry.path().to_path_buf()))?;
        if relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".new"))
        {
            continue;
        }
        validate_managed_file(relative)?;
        let content = fs::read(entry.path())
            .map_err(|error| SkillStoreError::io("reading skill package file", error))?;
        files.push(SkillPackageFile {
            relative_path: relative.to_path_buf(),
            content,
            executable: is_executable(&entry.metadata().map_err(|error| {
                SkillStoreError::io("reading skill package file metadata", error.into())
            })?),
        });
    }
    Ok(SkillPackage {
        name: name.to_string(),
        files,
    })
}

pub(crate) fn validate_package(package: &SkillPackage) -> Result<SkillRevision, SkillStoreError> {
    let revision = canonical_package_revision(package)?;
    let skill_md = package
        .files
        .iter()
        .find(|file| validate_managed_file(&file.relative_path).ok().as_deref() == Some("SKILL.md"))
        .ok_or_else(|| SkillStoreError::InvalidPackage("missing SKILL.md".to_string()))?;
    let text = std::str::from_utf8(&skill_md.content)
        .map_err(|_| SkillStoreError::InvalidPackage("SKILL.md must be valid UTF-8".to_string()))?;
    let (frontmatter, body) = split_frontmatter(text)?;
    let value: serde_yaml::Value = serde_yaml::from_str(frontmatter).map_err(|error| {
        SkillStoreError::InvalidPackage(format!("invalid SKILL.md frontmatter: {error}"))
    })?;
    if value.get("name").and_then(|value| value.as_str()) != Some(package.name.as_str()) {
        return Err(SkillStoreError::InvalidPackage(format!(
            "SKILL.md name must equal directory name '{}'",
            package.name
        )));
    }
    if value
        .get("description")
        .and_then(|value| value.as_str())
        .is_none_or(str::is_empty)
    {
        return Err(SkillStoreError::InvalidPackage(
            "SKILL.md frontmatter requires description".to_string(),
        ));
    }
    if body.trim().is_empty() {
        return Err(SkillStoreError::InvalidPackage(
            "SKILL.md requires an instruction body".to_string(),
        ));
    }
    Ok(revision)
}

fn canonical_files(
    files: &[SkillPackageFile],
) -> Result<BTreeMap<String, &SkillPackageFile>, SkillStoreError> {
    let mut canonical = BTreeMap::new();
    for file in files {
        let path = validate_managed_file(&file.relative_path)?;
        if canonical.insert(path.clone(), file).is_some() {
            return Err(SkillStoreError::InvalidPackage(format!(
                "duplicate package path '{path}'"
            )));
        }
    }
    Ok(canonical)
}

fn split_frontmatter(content: &str) -> Result<(&str, &str), SkillStoreError> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let rest = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))
        .ok_or_else(|| {
            SkillStoreError::InvalidPackage("SKILL.md must start with YAML frontmatter".to_string())
        })?;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n', ' ', '\t']) == "---" {
            return Ok((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    Err(SkillStoreError::InvalidPackage(
        "SKILL.md frontmatter is not closed".to_string(),
    ))
}

fn hash_u64(hasher: &mut Sha256, value: u64) {
    hasher.update(value.to_be_bytes());
}

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    false
}

pub(crate) fn package_file_map(
    package: SkillPackage,
) -> Result<BTreeMap<String, SkillPackageFile>, SkillStoreError> {
    let mut files = BTreeMap::new();
    for mut file in package.files {
        let canonical = validate_managed_file(&file.relative_path)?;
        file.relative_path = PathBuf::from(&canonical);
        if files.insert(canonical.clone(), file).is_some() {
            return Err(SkillStoreError::InvalidPackage(format!(
                "duplicate package path '{canonical}'"
            )));
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(files: Vec<SkillPackageFile>) -> SkillPackage {
        SkillPackage {
            name: "demo".to_string(),
            files,
        }
    }

    fn file(path: &str, content: &[u8], executable: bool) -> SkillPackageFile {
        SkillPackageFile {
            relative_path: PathBuf::from(path),
            content: content.to_vec(),
            executable,
        }
    }

    #[test]
    fn canonical_hash_is_order_independent() {
        let skill = file(
            "SKILL.md",
            b"---\nname: demo\ndescription: demo\n---\nbody",
            false,
        );
        let reference = file("references/a.md", b"a", false);
        let first =
            canonical_package_revision(&package(vec![skill.clone(), reference.clone()])).unwrap();
        let second = canonical_package_revision(&package(vec![reference, skill])).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn canonical_hash_includes_path_content_and_executable_bit() {
        let base = file(
            "SKILL.md",
            b"---\nname: demo\ndescription: demo\n---\nbody",
            false,
        );
        let first = canonical_package_revision(&package(vec![base.clone()])).unwrap();
        let mut changed = base.clone();
        changed.content.push(b'!');
        assert_ne!(
            first,
            canonical_package_revision(&package(vec![changed])).unwrap()
        );
        let mut executable = base;
        executable.executable = true;
        assert_ne!(
            first,
            canonical_package_revision(&package(vec![executable])).unwrap()
        );
    }

    #[test]
    fn canonical_hash_normalizes_native_path_components_to_forward_slashes() {
        let skill = file(
            "SKILL.md",
            b"---\nname: demo\ndescription: demo\n---\nbody",
            false,
        );
        let joined = SkillPackageFile {
            relative_path: PathBuf::from("references").join("guide.md"),
            content: b"guide".to_vec(),
            executable: false,
        };
        let slash = file("references/guide.md", b"guide", false);
        assert_eq!(
            canonical_package_revision(&package(vec![skill.clone(), joined])).unwrap(),
            canonical_package_revision(&package(vec![skill, slash])).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn disk_package_rejects_symlinked_files() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let skill = temp.path().join("demo");
        fs::create_dir_all(skill.join("references")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            b"---\nname: demo\ndescription: demo\n---\nbody",
        )
        .unwrap();
        fs::write(temp.path().join("outside"), b"secret").unwrap();
        symlink(temp.path().join("outside"), skill.join("references/secret")).unwrap();
        assert!(matches!(
            load_package(&skill, "demo"),
            Err(SkillStoreError::UnsupportedFileType(_))
        ));
    }
}
