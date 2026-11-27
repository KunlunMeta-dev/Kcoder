use std::fmt::Write as _;
use std::fs;
#[path = "src/bundled_catalog.rs"]
mod bundled_catalog;
use bundled_catalog::collect;
use std::path::PathBuf;

const SKILLS: &[&str] = &[
    "algorithmic-art",
    "canvas-design",
    "doc-coauthoring",
    "docx",
    "frontend-design",
    "inline-visualization",
    "lark-approval",
    "lark-apps",
    "lark-attendance",
    "lark-base",
    "lark-calendar",
    "lark-contact",
    "lark-doc",
    "lark-drive",
    "lark-event",
    "lark-im",
    "lark-mail",
    "lark-markdown",
    "lark-meeting",
    "lark-note",
    "lark-okr",
    "lark-openapi-explorer",
    "lark-shared",
    "lark-sheets",
    "lark-skill-maker",
    "lark-slides",
    "lark-task",
    "lark-whiteboard",
    "lark-wiki",
    "lark-workflow-meeting-summary",
    "lark-workflow-standup-report",
    "pdf",
    "pptx",
    "skill-creator",
    "slack-gif-creator",
    "theme-factory",
    "web-artifacts-builder",
    "webapp-testing",
    "xlsx",
];

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
    generate_eval_catalog(&root.join(EVAL_CATALOG_DIR));
}

/// KCoder-owned offline evaluation cases for shipped skills. Vendored skills
/// keep their upstream layout, so their cases live outside the skill
/// directories in `skills/.evals/<skill-name>/evals.json`. The directory has
/// no `SKILL.md` and is never collected as a skill package.
const EVAL_CATALOG_DIR: &str = ".evals";
const EVAL_CATALOG_FILE: &str = "evals.json";
/// Same ceiling as the engine's `evals.json` reader.
const EVAL_CATALOG_MAX_BYTES: u64 = 512 * 1024;
/// Built-in skills embedded from `src/assets/builtin` rather than `skills/`.
const BUILTIN_SKILLS: &[&str] = &["kcoder-settings"];

fn generate_eval_catalog(directory: &std::path::Path) {
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut generated =
        String::from("pub(super) const BUNDLED_EVAL_CATALOG: &[(&str, &[u8])] = &[\n");
    if directory.exists() {
        let metadata = fs::symlink_metadata(directory).expect("cannot inspect eval catalog");
        assert!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "the eval catalog must be a regular directory"
        );
        let mut entries = fs::read_dir(directory)
            .expect("cannot read eval catalog")
            .map(|entry| entry.expect("cannot read eval catalog entry").path())
            .collect::<Vec<_>>();
        entries.sort();
        for entry in entries {
            let name = entry
                .file_name()
                .and_then(|name| name.to_str())
                .expect("eval catalog names must be UTF-8")
                .to_string();
            if name == ".DS_Store" {
                continue;
            }
            assert!(
                SKILLS.contains(&name.as_str()) || BUILTIN_SKILLS.contains(&name.as_str()),
                "eval catalog entry {name} does not name a shipped skill"
            );
            let metadata = fs::symlink_metadata(&entry).expect("cannot inspect eval catalog entry");
            assert!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "eval catalog entry {name} must be a regular directory"
            );
            let file = entry.join(EVAL_CATALOG_FILE);
            let file_metadata =
                fs::symlink_metadata(&file).expect("eval catalog entry lacks evals.json");
            assert!(
                file_metadata.is_file() && !file_metadata.file_type().is_symlink(),
                "{} must be a regular file",
                file.display()
            );
            assert!(
                file_metadata.len() <= EVAL_CATALOG_MAX_BYTES,
                "{} exceeds the eval catalog size limit",
                file.display()
            );
            println!("cargo:rerun-if-changed={}", file.display());
            writeln!(
                &mut generated,
                "({name:?}, include_bytes!({:?})),",
                file.to_str().unwrap()
            )
            .unwrap();
        }
    }
    generated.push_str("];\n");
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("bundled_evals.rs");
    fs::write(output, generated).expect("cannot generate bundled eval catalog");
}
