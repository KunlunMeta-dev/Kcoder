//! Offline evaluation cases and deterministic checks (plan section 9).
//!
//! Case sources, in order:
//!
//! 1. the skill's own cases: the declared `evolution.eval` path or
//!    `evals/evals.json` (skill-creator format: `prompt`, `expected_output`,
//!    `files`, `expectations`; KCoder also accepts machine-checkable
//!    `assertions` such as `{"contains": "..."}`);
//! 2. the KCoder catalog entry of a bundled skill
//!    (`skills/.evals/<name>/evals.json`, embedded by `kcoder_skills`), for
//!    vendored skills whose upstream layout carries no cases. It applies only
//!    to the bundled copy ([`bundled_catalog`]), never to a same-named user,
//!    project, Hub or plugin skill. Catalog cases have no input files;
//! 3. local replay of recorded tasks of this target that did not depend on
//!    workspace state (no files written, no commands run, not marked
//!    workspace-dependent). The request snippet comes from local evidence
//!    and is never uploaded;
//! 4. none: the target has no offline evaluator and canaries at reduced
//!    traffic with a doubled observation period
//!    ([`kcoder_evolution::RolloutPolicy::from_settings`]).
//!
//! A malformed or mismatched case file is skipped as a source; it never
//! fails the evaluation itself.

use kcoder_evolution::EvolutionStore;
use kcoder_skills::SkillEvolutionDeclaration;
use kcoder_types::evolution::{OverlayContent, TargetKey, TargetType};
use serde::Deserialize;
use std::collections::{BTreeSet, HashSet};
use std::io::Read;
use std::path::Path;

/// Largest `evals.json` read.
const EVALS_MAX_BYTES: u64 = 512 * 1024;
/// Largest input file inlined into an eval prompt.
const EVAL_FILE_MAX_BYTES: u64 = 16 * 1024;
/// Prompt bytes of one case.
const CASE_PROMPT_MAX_BYTES: usize = 8 * 1024;

/// Where the cases of one evaluation came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaseSource {
    SkillEvals,
    BundledCatalog,
    LocalReplay,
}

/// A machine-checkable assertion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HardAssertion {
    Contains(String),
    NotContains(String),
    MaxChars(usize),
    MinChars(usize),
}

/// One evaluation task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EvalCase {
    pub(crate) id: String,
    pub(crate) prompt: String,
    pub(crate) expected_output: Option<String>,
    /// Natural-language expectations, graded by the judge.
    pub(crate) expectations: Vec<String>,
    pub(crate) assertions: Vec<HardAssertion>,
}

#[derive(Deserialize)]
struct EvalsFile {
    #[serde(default)]
    skill_name: Option<String>,
    #[serde(default)]
    evals: Vec<EvalsEntry>,
}

#[derive(Deserialize)]
struct EvalsEntry {
    #[serde(default)]
    id: Option<serde_json::Value>,
    prompt: String,
    #[serde(default)]
    expected_output: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    expectations: Vec<String>,
    #[serde(default)]
    assertions: Vec<serde_json::Value>,
}

fn bounded(text: &str, max: usize) -> String {
    kcoder_evolution::truncate_snippet(text, max).to_string()
}

fn contained(relative: &str) -> bool {
    !relative.is_empty()
        && !relative.starts_with('/')
        && !relative.contains('\\')
        && relative
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn read_bounded(path: &Path, max: u64) -> Option<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(max + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= max).then_some(bytes)
}

fn assertion(value: &serde_json::Value) -> Option<HardAssertion> {
    let object = value.as_object()?;
    let text = |key: &str| object.get(key).and_then(serde_json::Value::as_str);
    let number = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .map(|value| value as usize)
    };
    if let Some(value) = text("contains") {
        return Some(HardAssertion::Contains(value.to_string()));
    }
    if let Some(value) = text("not_contains").or_else(|| text("notContains")) {
        return Some(HardAssertion::NotContains(value.to_string()));
    }
    if let Some(value) = number("max_chars").or_else(|| number("maxChars")) {
        return Some(HardAssertion::MaxChars(value));
    }
    number("min_chars")
        .or_else(|| number("minChars"))
        .map(HardAssertion::MinChars)
}

/// Cases of the skill's `evals.json` (declared `evolution.eval` path or
/// `evals/evals.json`). Cases whose input files are missing, binary or
/// escape the skill directory are skipped.
pub(crate) fn skill_eval_cases(
    skill_dir: &Path,
    declaration: Option<&SkillEvolutionDeclaration>,
    max_cases: usize,
) -> Vec<EvalCase> {
    let relative = declaration
        .and_then(|declaration| declaration.eval.clone())
        .unwrap_or_else(|| "evals/evals.json".to_string());
    if !contained(&relative) {
        return Vec::new();
    }
    let Some(bytes) = read_bounded(&skill_dir.join(&relative), EVALS_MAX_BYTES) else {
        return Vec::new();
    };
    parse_cases(&bytes, Some(skill_dir), None, max_cases)
}

/// The embedded KCoder catalog entry for `key`, only when the evaluated
/// copy is the bundled one: the key's source is `bundled` and the effective
/// copy lives in the built-in/bundled layer. A same-named user, project,
/// Hub, external or plugin skill gets no catalog cases.
pub(crate) fn bundled_catalog(key: &TargetKey, bundled_copy: bool) -> Option<&'static [u8]> {
    if key.target_type() != TargetType::Skill || key.source() != "bundled" || !bundled_copy {
        return None;
    }
    kcoder_skills::bundled_eval_catalog(key.name())
}

/// Cases of a catalog entry for skill `name`. The file must name the same
/// skill when it declares `skill_name`; catalog cases have no input files,
/// so a case that lists any is skipped.
pub(crate) fn catalog_eval_cases(name: &str, bytes: &[u8], max_cases: usize) -> Vec<EvalCase> {
    if bytes.len() as u64 > EVALS_MAX_BYTES {
        return Vec::new();
    }
    parse_cases(bytes, None, Some(name), max_cases)
}

/// Parse a skill-creator `evals.json`. `input_dir` resolves `files`; without
/// it, cases with input files are skipped. A document that does not parse,
/// or names another skill than `expected_skill`, yields no cases.
fn parse_cases(
    bytes: &[u8],
    input_dir: Option<&Path>,
    expected_skill: Option<&str>,
    max_cases: usize,
) -> Vec<EvalCase> {
    let Ok(file) = serde_json::from_slice::<EvalsFile>(bytes) else {
        return Vec::new();
    };
    if let (Some(expected), Some(declared)) = (expected_skill, file.skill_name.as_deref())
        && expected != declared
    {
        return Vec::new();
    }
    let mut cases = Vec::new();
    for (index, entry) in file.evals.into_iter().enumerate() {
        if cases.len() >= max_cases || entry.prompt.trim().is_empty() {
            continue;
        }
        let mut prompt = entry.prompt.clone();
        let mut usable = true;
        for name in &entry.files {
            let text = input_dir
                .filter(|_| contained(name))
                .and_then(|directory| read_bounded(&directory.join(name), EVAL_FILE_MAX_BYTES))
                .and_then(|bytes| String::from_utf8(bytes).ok());
            match text {
                Some(text) => prompt.push_str(&format!(
                    "\n\n<input_file path=\"{name}\">\n{text}\n</input_file>"
                )),
                None => usable = false,
            }
        }
        if !usable {
            continue;
        }
        cases.push(EvalCase {
            id: entry
                .id
                .map(|id| id.to_string().trim_matches('"').to_string())
                .unwrap_or_else(|| format!("eval-{index}")),
            prompt: bounded(&prompt, CASE_PROMPT_MAX_BYTES),
            expected_output: entry.expected_output,
            expectations: entry.expectations.into_iter().take(16).collect(),
            assertions: entry
                .assertions
                .iter()
                .filter_map(assertion)
                .take(16)
                .collect(),
        });
    }
    cases
}

/// Replay cases from recorded, workspace-independent tasks of `key`.
pub(crate) fn replay_cases(
    store: &EvolutionStore,
    key: &TargetKey,
    now_ms: u64,
    max_cases: usize,
) -> Vec<EvalCase> {
    let Ok(usages) = store.read_amended_usages() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut cases = Vec::new();
    for usage in usages.records.iter().rev() {
        if cases.len() >= max_cases {
            break;
        }
        let task = &usage.task;
        let hints = &usage.profile_hints;
        if &usage.target_key != key
            || task.workspace_dependent
            || hints.wrote_files
            || hints.ran_commands
            || !usage.artifacts.is_empty()
        {
            continue;
        }
        let Some(evidence) = &task.evidence_ref else {
            continue;
        };
        if let Some(hash) = &task.request_hash
            && !seen.insert(hash.clone())
        {
            continue;
        }
        let Ok(Some(snippet)) = store.read_evidence(evidence, now_ms) else {
            continue;
        };
        if snippet.text.trim().is_empty() {
            continue;
        }
        cases.push(EvalCase {
            id: format!("replay-{}", usage.usage_id),
            prompt: bounded(&snippet.text, CASE_PROMPT_MAX_BYTES),
            expected_output: None,
            expectations: Vec::new(),
            assertions: Vec::new(),
        });
    }
    cases
}

/// Select the cases of one evaluation in source order. `catalog` is the
/// bundled catalog entry of the target ([`bundled_catalog`]), if any.
pub(crate) fn eval_cases(
    skill_dir: Option<&Path>,
    declaration: Option<&SkillEvolutionDeclaration>,
    catalog: Option<&[u8]>,
    store: &EvolutionStore,
    key: &TargetKey,
    now_ms: u64,
    max_cases: usize,
) -> Option<(CaseSource, Vec<EvalCase>)> {
    if let Some(directory) = skill_dir {
        let cases = skill_eval_cases(directory, declaration, max_cases);
        if !cases.is_empty() {
            return Some((CaseSource::SkillEvals, cases));
        }
    }
    if let Some(bytes) = catalog {
        let cases = catalog_eval_cases(key.name(), bytes, max_cases);
        if !cases.is_empty() {
            return Some((CaseSource::BundledCatalog, cases));
        }
    }
    let cases = replay_cases(store, key, now_ms, max_cases);
    (!cases.is_empty()).then_some((CaseSource::LocalReplay, cases))
}

/// Patterns the learned content forbids: backticked spans on lines that
/// say never / do not / avoid (in English or Chinese).
pub(crate) fn forbidden_patterns(content: &OverlayContent) -> Vec<String> {
    const MARKERS: &[&str] = &[
        "never", "don't", "do not", "avoid", "must not", "禁止", "不要", "避免", "不得",
    ];
    let mut patterns = BTreeSet::new();
    for line in content.lessons.lines().chain(content.checklist.lines()) {
        let lower = line.to_lowercase();
        if !MARKERS.iter().any(|marker| lower.contains(marker)) {
            continue;
        }
        let mut parts = line.split('`');
        parts.next();
        while let (Some(inside), Some(_)) = (parts.next(), parts.next()) {
            let inside = inside.trim();
            if !inside.is_empty() && inside.chars().count() <= 80 {
                patterns.insert(inside.to_string());
            }
        }
    }
    patterns.into_iter().take(16).collect()
}

/// Deterministic checks of one output: `(name, passed)` in a fixed order.
pub(crate) fn hard_checks(
    output: &str,
    case: &EvalCase,
    forbidden: &[String],
    reference_chars: usize,
) -> Vec<(String, bool)> {
    let trimmed = output.trim();
    let chars = trimmed.chars().count();
    let mut checks = vec![
        ("non_empty".to_string(), !trimmed.is_empty()),
        (
            "balanced_code_fences".to_string(),
            trimmed.matches("```").count().is_multiple_of(2),
        ),
    ];
    if reference_chars > 0 {
        // Length stays within a factor of three of the stable output.
        let within = chars * 3 >= reference_chars && chars <= reference_chars * 3 + 200;
        checks.push(("length".to_string(), within));
    }
    for assertion in &case.assertions {
        let (name, passed) = match assertion {
            HardAssertion::Contains(text) => (format!("contains:{text}"), trimmed.contains(text)),
            HardAssertion::NotContains(text) => {
                (format!("not_contains:{text}"), !trimmed.contains(text))
            }
            HardAssertion::MaxChars(max) => (format!("max_chars:{max}"), chars <= *max),
            HardAssertion::MinChars(min) => (format!("min_chars:{min}"), chars >= *min),
        };
        checks.push((name, passed));
    }
    for pattern in forbidden {
        checks.push((
            format!("forbidden:{pattern}"),
            !trimmed.contains(pattern.as_str()),
        ));
    }
    checks
}

/// Checks the candidate fails although the stable output passes them.
pub(crate) fn regressions(stable: &[(String, bool)], candidate: &[(String, bool)]) -> u32 {
    candidate
        .iter()
        .filter(|(name, passed)| {
            !passed
                && stable
                    .iter()
                    .find(|(other, _)| other == name)
                    .is_none_or(|(_, stable_passed)| *stable_passed)
        })
        .count() as u32
}

fn grams(text: &str) -> HashSet<String> {
    let normalized: Vec<char> = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .chars()
        .collect();
    normalized
        .windows(4)
        .map(|window| window.iter().collect())
        .collect()
}

/// Mean pairwise Jaccard similarity of character 4-grams.
pub(crate) fn mean_similarity(samples: &[String]) -> f64 {
    let sets: Vec<HashSet<String>> = samples.iter().map(|sample| grams(sample)).collect();
    let mut total = 0.0;
    let mut pairs = 0usize;
    for left in 0..sets.len() {
        for right in left + 1..sets.len() {
            let union = sets[left].union(&sets[right]).count();
            let shared = sets[left].intersection(&sets[right]).count();
            total += if union == 0 {
                1.0
            } else {
                shared as f64 / union as f64
            };
            pairs += 1;
        }
    }
    if pairs == 0 {
        0.0
    } else {
        total / pairs as f64
    }
}

/// Relative diversity change of the candidate (negative is a drop).
pub(crate) fn diversity_delta(stable: &[String], candidate: &[String]) -> f64 {
    let stable_diversity = 1.0 - mean_similarity(stable);
    let candidate_diversity = 1.0 - mean_similarity(candidate);
    if stable_diversity <= f64::EPSILON {
        return 0.0;
    }
    (candidate_diversity - stable_diversity) / stable_diversity
}

/// Mostly free text: no code fences, not JSON, prose-length lines.
pub(crate) fn looks_like_free_text(output: &str) -> bool {
    let trimmed = output.trim();
    if trimmed.is_empty()
        || trimmed.contains("```")
        || serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
    {
        return false;
    }
    let lines: Vec<&str> = trimmed
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let commands = lines
        .iter()
        .filter(|line| {
            let line = line.trim_start();
            line.starts_with('$') || line.starts_with("cargo ") || line.starts_with("npm ")
        })
        .count();
    commands * 5 < lines.len().max(1)
}
