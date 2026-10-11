//! Explicit local package import using bounded reads and the existing transactional store.

use crate::{
    ExpectedSkillRevision, SkillCommitReceipt, SkillCommitRequest, SkillMutation,
    SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile, SkillStore,
};
use anyhow::{Context, Result, bail};
use kcoder_config::PrivateDirectory;
use std::{io::Read, path::Path};

const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_TOTAL_BYTES: usize = 5 * 1_048_576;

pub fn read_directory_package(source: &Path) -> Result<SkillPackage> {
    let source = source
        .canonicalize()
        .context("Cannot resolve skill source directory")?;
    let directory = PrivateDirectory::open_existing(&source)
        .context("Select a directory containing SKILL.md")?;
    let mut files = Vec::new();
    let mut entries = 0;
    let mut total = 0;
    collect(
        &source,
        &directory,
        Path::new(""),
        0,
        &mut entries,
        &mut total,
        &mut files,
    )?;
    let primary = files
        .iter()
        .find(|file| file.relative_path == Path::new("SKILL.md"))
        .context("Skill directory does not contain SKILL.md")?;
    let text = std::str::from_utf8(&primary.content).context("SKILL.md must be UTF-8")?;
    let (frontmatter, _) = crate::split_frontmatter(text);
    let metadata: crate::SkillFrontmatter = serde_yaml::from_str(&frontmatter)
        .map_err(|_| anyhow::anyhow!("Invalid skill frontmatter"))?;
    let package = SkillPackage {
        name: metadata.name.context("SKILL.md must declare a name")?,
        files,
    };
    crate::canonical_package_revision(&package)?;
    Ok(package)
}

fn collect(
    path: &Path,
    directory: &PrivateDirectory,
    relative: &Path,
    depth: usize,
    entries: &mut usize,
    total: &mut usize,
    files: &mut Vec<SkillPackageFile>,
) -> Result<()> {
    if depth > 16 {
        bail!("Skill package directory nesting exceeds the limit");
    }
    for entry in std::fs::read_dir(path).context("Cannot list skill source directory")? {
        let entry = entry?;
        *entries += 1;
        if *entries > 1024 {
            bail!("Skill package contains too many entries");
        }
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let kind = entry.file_type()?;
        let child_relative = relative.join(&name);
        if kind.is_symlink() {
            bail!("Skill package must not contain symbolic links");
        }
        if kind.is_dir() {
            let child = directory.open_child(&name, false)?;
            collect(
                &entry.path(),
                &child,
                &child_relative,
                depth + 1,
                entries,
                total,
                files,
            )?;
        } else if kind.is_file() {
            let file = directory.open_regular_file(&name)?;
            let metadata = file.metadata()?;
            let mut content = Vec::new();
            file.take(MAX_FILE_BYTES + 1).read_to_end(&mut content)?;
            *total = total.saturating_add(content.len());
            if content.len() as u64 > MAX_FILE_BYTES || *total > MAX_TOTAL_BYTES {
                bail!("Skill package exceeds the file or total size limit");
            }
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = {
                let _ = metadata;
                false
            };
            files.push(SkillPackageFile {
                relative_path: child_relative,
                content,
                executable,
            });
        } else {
            bail!("Skill package contains an unsupported file type");
        }
    }
    Ok(())
}

pub fn install_directory(root: &Path, source: &Path) -> Result<SkillCommitReceipt> {
    let package = read_directory_package(source)?;
    let store = SkillStore::open(root)?;
    Ok(store.commit(SkillCommitRequest {
        operation_id: uuid::Uuid::new_v4().to_string(),
        actor: SkillMutationActor::System {
            component: "studio-skill-import".into(),
            session_id: None,
        },
        operation: SkillOperationKind::Install,
        preconditions: Vec::new(),
        mutations: vec![SkillMutation::PutPackage {
            package,
            expected: ExpectedSkillRevision::Absent,
        }],
        metadata: Default::default(),
    })?)
}

pub struct ArchivedSkill {
    pub archive_name: String,
    pub receipt: SkillCommitReceipt,
}

/// Remove only a direct entry in this store, retaining its package for recovery.
pub fn archive_skill(root: &Path, name: &str) -> Result<ArchivedSkill> {
    let store = SkillStore::open(root)?;
    let revision = store
        .current_revision(name)?
        .context("Skill is not installed in this user store")?;
    let archive_name = format!("studio-{}", uuid::Uuid::new_v4().simple());
    let receipt = store.commit(SkillCommitRequest {
        operation_id: uuid::Uuid::new_v4().to_string(),
        actor: SkillMutationActor::System {
            component: "studio-skill-remove".into(),
            session_id: None,
        },
        operation: SkillOperationKind::Uninstall,
        preconditions: Vec::new(),
        mutations: vec![SkillMutation::Archive {
            name: name.to_owned(),
            expected: revision,
            archive_name: archive_name.clone(),
        }],
        metadata: Default::default(),
    })?;
    Ok(ArchivedSkill {
        archive_name,
        receipt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_import_preserves_support_files_and_refuses_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join("references")).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: imported-skill\ndescription: Test import\n---\nUse the reference.\n",
        )
        .unwrap();
        std::fs::write(source.join("references/example.md"), "support content").unwrap();
        let target = temp.path().join("skills");
        install_directory(&target, &source).unwrap();
        assert_eq!(
            std::fs::read(target.join("imported-skill/references/example.md")).unwrap(),
            b"support content"
        );
        assert!(install_directory(&target, &source).is_err());
        assert_eq!(
            std::fs::read(source.join("references/example.md")).unwrap(),
            b"support content"
        );
    }

    #[test]
    fn removal_archives_the_complete_package_and_can_be_restored() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: recoverable\ndescription: Test\n---\nInstructions.\n",
        )
        .unwrap();
        let target = temp.path().join("skills");
        install_directory(&target, &source).unwrap();
        let store = SkillStore::open(&target).unwrap();
        let revision = store.current_revision("recoverable").unwrap().unwrap();
        let archived = archive_skill(&target, "recoverable").unwrap();
        assert!(!target.join("recoverable").exists());
        assert!(store.current_revision("recoverable").unwrap().is_none());
        store
            .commit(SkillCommitRequest {
                operation_id: uuid::Uuid::new_v4().to_string(),
                actor: SkillMutationActor::System {
                    component: "test-restore".into(),
                    session_id: None,
                },
                operation: SkillOperationKind::Restore,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::Restore {
                    name: "recoverable".into(),
                    archive_name: archived.archive_name,
                    expected_archive_revision: revision.clone(),
                    expected_live: ExpectedSkillRevision::Absent,
                }],
                metadata: Default::default(),
            })
            .unwrap();
        assert_eq!(
            store.current_revision("recoverable").unwrap(),
            Some(revision)
        );
    }

    #[test]
    fn windows_frontmatter_import_preserves_original_bytes() {
        for content in [
            "---\r\nname: windows-skill\r\ndescription: Windows skill\r\n---\r\nInstructions.\r\n",
            "\u{feff}---\r\nname: windows-skill\r\ndescription: Windows skill\r\n---\r\nInstructions.\r\n",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source");
            std::fs::create_dir(&source).unwrap();
            std::fs::write(source.join("SKILL.md"), content).unwrap();
            let target = temp.path().join("skills");
            install_directory(&target, &source).unwrap();
            assert_eq!(
                std::fs::read(target.join("windows-skill/SKILL.md")).unwrap(),
                content.as_bytes()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn linked_files_are_rejected_before_installation() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(temp.path().join("outside"), "private source").unwrap();
        std::os::unix::fs::symlink(temp.path().join("outside"), source.join("SKILL.md")).unwrap();
        let target = temp.path().join("skills");
        assert!(install_directory(&target, &source).is_err());
        assert!(!target.exists());
    }
}
