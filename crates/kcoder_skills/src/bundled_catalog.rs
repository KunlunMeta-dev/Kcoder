//! Shared build-time resource selection; generated Python caches are not assets.
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn collect(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) {
    let directory_metadata =
        fs::symlink_metadata(directory).expect("cannot inspect bundled skill directory");
    assert!(
        directory_metadata.is_dir() && !directory_metadata.file_type().is_symlink(),
        "bundled skill directory must not be a link"
    );
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut entries = fs::read_dir(directory)
        .expect("bundled skill directory missing")
        .map(|entry| entry.expect("cannot read bundled skill entry").path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        let metadata = fs::symlink_metadata(&path).expect("cannot inspect bundled skill asset");
        assert!(
            !metadata.file_type().is_symlink(),
            "bundled skill symlinks are not supported: {}",
            path.display()
        );
        let name = path
            .file_name()
            .unwrap()
            .to_str()
            .expect("bundled skill filenames must be UTF-8");
        if matches!(name, "__pycache__" | ".DS_Store")
            || name.ends_with(".pyc")
            || name.ends_with(".pyo")
        {
            continue;
        }
        assert!(
            !matches!(name, ".git" | "node_modules"),
            "development dependency directories must not enter bundled skills"
        );
        if metadata.is_dir() {
            collect(root, &path, files);
        } else {
            assert!(
                metadata.is_file(),
                "bundled skills support regular files only"
            );
            assert!(path.starts_with(root));
            assert!(
                metadata.len() <= 16 * 1024 * 1024,
                "bundled skill asset exceeds 16 MiB"
            );
            files.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_cache_files_do_not_poison_or_enter_the_bundle() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("SKILL.md"), "resource").unwrap();
        fs::write(root.path().join("script.py"), "print('resource')").unwrap();
        fs::create_dir(root.path().join("__pycache__")).unwrap();
        fs::write(root.path().join("__pycache__/script.pyc"), b"generated").unwrap();
        fs::write(root.path().join("script.pyc"), b"generated").unwrap();
        fs::write(root.path().join(".DS_Store"), b"generated").unwrap();
        let mut files = Vec::new();
        collect(root.path(), root.path(), &mut files);
        let names = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["SKILL.md", "script.py"]);
    }
    #[cfg(unix)]
    #[test]
    fn excluded_cache_names_cannot_hide_resource_symlinks() {
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("outside", root.path().join("__pycache__")).unwrap();
        let result =
            std::panic::catch_unwind(|| collect(root.path(), root.path(), &mut Vec::new()));
        assert!(result.is_err());
    }
}
