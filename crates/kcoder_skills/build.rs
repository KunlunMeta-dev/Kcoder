use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

const SKILLS: &[&str] = &[
    "algorithmic-art",
    "canvas-design",
    "doc-coauthoring",
    "docx",
    "frontend-design",
    "pdf",
    "pptx",
    "skill-creator",
    "slack-gif-creator",
    "theme-factory",
    "web-artifacts-builder",
    "webapp-testing",
    "xlsx",
];

fn collect(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) {
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
        assert!(
            !matches!(name, ".git" | "node_modules" | "__pycache__" | ".DS_Store")
                && !name.ends_with(".pyc"),
            "cache content must not enter bundled skills"
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

fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../skills");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut generated =
        String::from("pub(super) const BUNDLED_SKILL_FILES: &[(&str, &str, &[u8], bool)] = &[\n");
    let mut total = 0u64;
    let mut count = 0usize;
    for skill in SKILLS {
        let directory = root.join(skill);
        assert!(
            directory.join("SKILL.md").is_file(),
            "bundled skill {skill} is incomplete"
        );
        let mut files = Vec::new();
        collect(&directory, &directory, &mut files);
        for path in files {
            let metadata = fs::metadata(&path).unwrap();
            total += metadata.len();
            count += 1;
            assert!(
                total <= 64 * 1024 * 1024 && count <= 4096,
                "bundled skill catalog exceeds its build limit"
            );
            let relative = path
                .strip_prefix(&directory)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = false;
            writeln!(
                &mut generated,
                "({skill:?}, {relative:?}, include_bytes!({:?}), {executable}),",
                path.to_str().unwrap()
            )
            .unwrap();
        }
    }
    generated.push_str("];\n");
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("bundled_skills.rs");
    fs::write(output, generated).expect("cannot generate bundled skill asset table");
}
