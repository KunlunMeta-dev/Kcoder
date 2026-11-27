//! Bounded local search scans and result projection.

#[path = "glob.rs"]
pub mod glob;
#[path = "grep.rs"]
pub mod grep;

pub const VCS_DIRECTORIES_TO_EXCLUDE: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
pub const GENERATED_DIRECTORIES_TO_EXCLUDE: &[&str] = &[
    "target",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    "out",
];
