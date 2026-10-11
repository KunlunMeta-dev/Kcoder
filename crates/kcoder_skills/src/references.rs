use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use std::{
    ffi::{OsStr, OsString},
    io::Read,
    path::Path,
};

const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILES: usize = 128;
const MAX_ENTRIES: usize = 10_000;

pub(super) fn load(parent: &PrivateDirectory, skill_dir: &Path) -> Result<Vec<String>> {
    let path = skill_dir.join("references");
    let directory = match parent.open_child(OsStr::new("references"), false) {
        Ok(directory) => directory,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(Vec::new());
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!("skill references must be a regular non-symlink directory: {path:?}")
            });
        }
    };
    let mut names = Vec::new();
    for (index, entry) in std::fs::read_dir(&path)
        .with_context(|| format!("failed to enumerate skill references: {path:?}"))?
        .enumerate()
    {
        ensure!(
            index < MAX_ENTRIES,
            "skill references exceed 10000 directory entries: {path:?}"
        );
        let entry =
            entry.with_context(|| format!("failed to enumerate skill references: {path:?}"))?;
        let name = entry.file_name();
        let kind = entry
            .file_type()
            .with_context(|| format!("failed to inspect skill reference: {name:?}"))?;
        ensure!(
            !kind.is_symlink(),
            "skill reference must be a non-symlink entry: {name:?}"
        );
        if Path::new(&name).extension() != Some(OsStr::new("md")) {
            continue;
        }
        ensure!(
            kind.is_file(),
            "skill reference must be a regular non-symlink file: {name:?}"
        );
        ensure!(
            names.len() < MAX_FILES,
            "skill references exceed 128 Markdown files: {path:?}"
        );
        names.push(name);
    }
    names.sort();
    read_contents(&directory, &path, names)
}

fn read_contents(
    directory: &PrivateDirectory,
    path: &Path,
    names: Vec<OsString>,
) -> Result<Vec<String>> {
    let mut references = Vec::with_capacity(names.len());
    let mut total = 0;
    for name in names {
        // Only enumerate by pathname. Content is always opened relative to the
        // pinned directory, including when an entry changes after discovery.
        let file = directory.open_regular_file(&name).with_context(|| {
            format!("skill reference must be a regular non-symlink file: {name:?}")
        })?;
        let remaining = MAX_TOTAL_BYTES - total;
        let limit = MAX_FILE_BYTES.min(remaining);
        let mut bytes = Vec::new();
        file.take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .with_context(|| format!("failed to read skill reference: {name:?}"))?;
        ensure!(
            bytes.len() <= MAX_FILE_BYTES,
            "skill reference exceeds 1 MiB limit: {name:?}"
        );
        ensure!(
            bytes.len() <= remaining,
            "skill references exceed 8 MiB total limit: {path:?}"
        );
        total += bytes.len();
        references.push(
            String::from_utf8(bytes)
                .with_context(|| format!("skill reference must be UTF-8: {name:?}"))?,
        );
    }
    Ok(references)
}

#[cfg(test)]
mod tests {
    use crate::parse_skill_file;
    use std::{fs, path::Path};

    const MIB: usize = 1024 * 1024;

    fn skill(root: &Path) -> std::path::PathBuf {
        fs::create_dir_all(root).unwrap();
        let path = root.join("SKILL.md");
        fs::write(&path, "---\nname: reference-fixture\n---\nInstructions.\n").unwrap();
        path
    }

    fn rejected(path: &Path) -> String {
        match parse_skill_file(path) {
            Ok(_) => panic!("invalid references must reject the complete Skill"),
            Err(error) => format!("{error:#}"),
        }
    }

    #[test]
    fn references_preserve_complete_content_and_stable_filename_order() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        for (name, content) in [("z.md", "z\r\n"), ("a.md", "\u{feff}a\n"), ("m.md", "m\n")] {
            fs::write(refs.join(name), content).unwrap();
        }
        fs::write(refs.join("ignored.png"), [0xff]).unwrap();
        fs::create_dir(refs.join("ignored-directory")).unwrap();
        assert_eq!(
            parse_skill_file(&path).unwrap().references,
            ["\u{feff}a\n", "m\n", "z\r\n"]
        );
    }

    #[test]
    fn references_absent_is_empty_without_creating_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        assert!(parse_skill_file(&path).unwrap().references.is_empty());
        assert!(!temp.path().join("references").exists());
    }

    #[test]
    fn references_reject_file_over_one_mib() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        fs::File::create(refs.join("large.md"))
            .unwrap()
            .set_len((MIB + 1) as u64)
            .unwrap();
        assert!(rejected(&path).contains("1 MiB"));
    }

    #[test]
    fn references_reject_total_over_eight_mib_and_accept_exact_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        for index in 0..8 {
            fs::File::create(refs.join(format!("{index}.md")))
                .unwrap()
                .set_len(MIB as u64)
                .unwrap();
        }
        assert_eq!(
            parse_skill_file(&path)
                .unwrap()
                .references
                .iter()
                .map(String::len)
                .sum::<usize>(),
            8 * MIB
        );
        fs::write(refs.join("overflow.md"), "x").unwrap();
        assert!(rejected(&path).contains("8 MiB"));
    }

    #[test]
    fn references_reject_count_over_128_and_accept_exact_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        for index in 0..128 {
            fs::write(refs.join(format!("{index:03}.md")), "").unwrap();
        }
        assert_eq!(parse_skill_file(&path).unwrap().references.len(), 128);
        fs::write(refs.join("overflow.md"), "").unwrap();
        assert!(rejected(&path).contains("128"));
    }

    #[test]
    fn references_reject_invalid_utf8_instead_of_loading_a_partial_skill() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        fs::write(refs.join("good.md"), "valid content").unwrap();
        fs::write(refs.join("invalid.md"), [0xff]).unwrap();
        assert!(rejected(&path).contains("UTF-8"));
    }

    #[test]
    fn references_reject_a_markdown_directory() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        fs::create_dir_all(temp.path().join("references/directory.md")).unwrap();
        assert!(rejected(&path).contains("regular"));
    }

    #[test]
    fn references_reject_a_non_directory_and_wide_non_markdown_scan() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::write(&refs, "not a directory").unwrap();
        assert!(rejected(&path).contains("directory"));
        fs::remove_file(&refs).unwrap();
        fs::create_dir(&refs).unwrap();
        for index in 0..10_001 {
            fs::write(refs.join(format!("{index}.txt")), "").unwrap();
        }
        assert!(rejected(&path).contains("10000"));
    }

    #[test]
    fn references_check_size_before_utf8_even_when_the_bounded_tail_splits_a_character() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        let mut bytes = vec![b'x'; MIB];
        bytes.extend_from_slice("é".as_bytes());
        fs::write(refs.join("large.md"), &bytes).unwrap();
        assert!(rejected(&path).contains("1 MiB"));
        fs::write(&path, bytes).unwrap();
        assert!(rejected(&path).contains("1 MiB"));
    }

    #[cfg(unix)]
    #[test]
    fn references_preserve_read_only_permissions_and_exact_utf8_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        let reference = refs.join("read-only.md");
        fs::write(&reference, "\u{feff}# 文档\r\n\r\n").unwrap();
        fs::set_permissions(&reference, fs::Permissions::from_mode(0o444)).unwrap();
        fs::set_permissions(&refs, fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(
            parse_skill_file(&path).unwrap().references,
            ["\u{feff}# 文档\r\n\r\n"]
        );
        assert_eq!(
            fs::metadata(&reference).unwrap().permissions().mode() & 0o777,
            0o444
        );
        assert_eq!(
            fs::metadata(&refs).unwrap().permissions().mode() & 0o777,
            0o555
        );
        fs::set_permissions(&refs, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn references_reject_external_symlink_directory_and_leaf() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let outside = tempfile::tempdir().unwrap();
        fs::write(
            outside.path().join("secret.md"),
            "external reference must never load",
        )
        .unwrap();
        let refs = temp.path().join("references");
        symlink(outside.path(), &refs).unwrap();
        assert!(rejected(&path).contains("non-symlink"));
        fs::remove_file(&refs).unwrap();
        fs::create_dir(&refs).unwrap();
        symlink(outside.path().join("secret.md"), refs.join("linked.md")).unwrap();
        assert!(rejected(&path).contains("non-symlink"));
        fs::remove_file(refs.join("linked.md")).unwrap();
        symlink(outside.path().join("missing.md"), refs.join("dangling.md")).unwrap();
        assert!(rejected(&path).contains("non-symlink"));
        fs::remove_file(refs.join("dangling.md")).unwrap();
        fs::remove_dir(&refs).unwrap();
        symlink(outside.path().join("missing-directory"), &refs).unwrap();
        assert!(rejected(&path).contains("non-symlink"));
    }

    #[cfg(unix)]
    #[test]
    fn references_reject_a_fifo_without_waiting_for_a_writer() {
        let temp = tempfile::tempdir().unwrap();
        let path = skill(temp.path());
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(refs.join("pipe.md"))
                .status()
                .expect("mkfifo is required for this Unix file-type fixture")
                .success()
        );
        assert!(rejected(&path).contains("regular"));
    }

    #[test]
    fn a_disappeared_markdown_leaf_cannot_return_an_incomplete_reference_set() {
        let temp = tempfile::tempdir().unwrap();
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        fs::write(refs.join("a.md"), "good").unwrap();
        fs::write(refs.join("b.md"), "removed").unwrap();
        let directory = kcoder_config::PrivateDirectory::open_existing(&refs).unwrap();
        fs::remove_file(refs.join("b.md")).unwrap();
        assert!(
            super::read_contents(&directory, &refs, vec!["a.md".into(), "b.md".into()]).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn reference_content_stays_on_the_pinned_directory_after_path_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let refs = temp.path().join("references");
        fs::create_dir(&refs).unwrap();
        fs::write(refs.join("same.md"), "owned reference").unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("same.md"), "outside must never load").unwrap();
        let directory = kcoder_config::PrivateDirectory::open_existing(&refs).unwrap();
        fs::rename(&refs, temp.path().join("original-references")).unwrap();
        std::os::unix::fs::symlink(outside.path(), &refs).unwrap();
        assert_eq!(
            super::read_contents(&directory, &refs, vec!["same.md".into()]).unwrap(),
            ["owned reference"]
        );
    }

    #[test]
    fn registry_never_registers_or_activates_partially_loaded_references() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        let valid = temp.path().join("valid");
        let invalid = temp.path().join("invalid");
        let valid_path = skill(&valid);
        let invalid_path = skill(&invalid);
        fs::write(valid_path, "---\nname: valid\n---\nInstructions.\n").unwrap();
        fs::write(
            invalid_path,
            "---\nname: invalid\nuser-invocable: false\npaths: ['**/*.rs']\n---\nInstructions.\n",
        )
        .unwrap();
        fs::create_dir(valid.join("references")).unwrap();
        fs::create_dir(invalid.join("references")).unwrap();
        fs::write(valid.join("references/normal.md"), "complete reference").unwrap();
        fs::write(invalid.join("references/invalid.md"), [0xff]).unwrap();
        let registry =
            crate::SkillRegistry::load_with_layers(&project, [&valid, &invalid], None, false)
                .unwrap();
        assert_eq!(
            registry.get("valid").unwrap().references,
            ["complete reference"]
        );
        assert!(registry.get_active("invalid").is_none());
        assert!(registry.active_for_paths(&["src/lib.rs".into()]).is_empty());
        assert_eq!(registry.iter_all().count(), 1);
    }
}
