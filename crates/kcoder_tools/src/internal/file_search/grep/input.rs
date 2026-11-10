//! Wire inputs for content search.

use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GrepInput {
    /// Regular expression pattern to search for. Escape special regex
    /// characters when searching for a literal string.
    pub pattern: String,
    /// Existing file or project/subdirectory to search. Omit only when cwd is the intended project; avoid broad home/drive scans.
    pub path: Option<String>,
    /// Filename filter such as `*.rs` or `src/**/*.ts`, not a content regex. Prefer this or type to bound the scan.
    pub glob: Option<String>,
    /// Output modes: `files_with_matches` lists files, `content` shows matching lines,
    /// and `count` reports per-file counts plus an exact global total. The default is `files_with_matches`.
    pub output_mode: Option<GrepOutputMode>,
    /// Number of lines to show before each content match.
    #[serde(rename = "-B")]
    pub before_context: Option<usize>,
    /// Number of lines to show after each content match.
    #[serde(rename = "-A")]
    pub after_context: Option<usize>,
    /// Number of lines to show before and after each content match.
    #[serde(rename = "-C")]
    #[schemars(skip)]
    pub context_flag: Option<usize>,
    /// Lines before and after each content match.
    pub context: Option<usize>,
    /// Show line numbers in content mode. Defaults to true.
    #[serde(rename = "-n")]
    pub line_numbers: Option<bool>,
    /// Case insensitive search.
    #[serde(rename = "-i")]
    pub case_insensitive: Option<bool>,
    /// Ripgrep file type filter such as `rust`, `js`, or `py`.
    #[serde(rename = "type")]
    pub file_type: Option<String>,
    /// Maximum output lines/entries, 1..=10000; defaults to 250. Zero is rejected.
    /// Count totals still include all matches; only displayed per-file rows are limited.
    #[schemars(range(min = 1, max = 10000))]
    pub head_limit: Option<usize>,
    /// Skip this many output lines/entries before applying `head_limit`.
    pub offset: Option<usize>,
    /// Enable ripgrep multiline mode (`-U --multiline-dotall`).
    pub multiline: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrepOutputMode {
    Content,
    FilesWithMatches,
    Count,
}
