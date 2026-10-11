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
}
