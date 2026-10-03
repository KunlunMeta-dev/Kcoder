//! Rebase / sync workflow for spec-driven changes.
//!
//! When the live authoritative spec drifts from the base snapshot captured at
//! change creation time, `sync` updates the change's delta specs so the author
//! can reconcile concurrent edits before archiving.

use crate::fingerprint::{
    BaseSnapshot, RequirementFingerprint, capture_base_snapshot, load_base_snapshot,
};
use crate::parse::{
    DeltaSpec, Spec, load_authoritative_specs, load_change_deltas_with_paths, normalize,
};
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Reference to a requirement in a specific domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReqRef {
    pub domain: String,
    pub name: String,
}

/// Result of syncing a change against the current authoritative specs.
#[derive(Debug, Clone, Default)]
pub struct SyncReport {
    pub fast_forwards: Vec<ReqRef>,
    pub conflicts: Vec<ReqRef>,
    pub unchanged: Vec<ReqRef>,
    pub base_updated: bool,
}

/// Rebase a change's delta specs against the current authoritative specs.
///
/// * Fast-forward: if a requirement changed in the live spec but the change's
///   delta still matches the base, the delta block is replaced with the live
///   version.
/// * Conflict: if both the live spec and the delta edited the same requirement,
///   conflict markers are inserted into the delta block and the base snapshot is
///   left unchanged so the user can resolve and re-sync.
pub fn sync(cwd: &Path, change_name: &str) -> Result<SyncReport> {
    let change_dir = crate::checked_change_dir(cwd, change_name)?;
    let specs_dir = crate::specs_dir_for(cwd);
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", change_name);
    }

    let current_specs = load_authoritative_specs(&specs_dir)?;
    let current = current_map(&current_specs);
    let base = load_base_snapshot(&change_dir)?;
    let base_map = base_map(&base);

    let deltas_with_paths = load_change_deltas_with_paths(&change_dir)?;
    if deltas_with_paths.is_empty() {
        // Nothing to rebase, but refresh the base snapshot so the change is up
        // to date for future archives.
        capture_base_snapshot(&specs_dir, &change_dir)?;
        return Ok(SyncReport {
            base_updated: true,
            ..SyncReport::default()
        });
    }

    let mut report = SyncReport::default();
    let mut files_to_write: Vec<(PathBuf, String)> = Vec::new();

    for (domain, mut delta, path) in deltas_with_paths {
        let mut changed = false;

        for req in &mut delta.modified {
            let key = (domain.clone(), req.name.clone());
            let base_body = base_map.get(&key).map(|f| f.body.as_str());
            let live_raw = current.get(&key).copied();

            let Some(base_body) = base_body else {
                continue;
            };
            let Some(live_raw) = live_raw else {
                continue;
            };
            let live_body = normalize(live_raw);

            if base_body == live_body {
                report.unchanged.push(ReqRef {
                    domain: domain.clone(),
                    name: req.name.clone(),
                });
                continue;
            }

            let delta_body = normalize(&req.raw);
            if delta_body == base_body {
                // Fast-forward: the change did not edit this requirement.
                req.raw = live_raw.to_string();
                report.fast_forwards.push(ReqRef {
                    domain: domain.clone(),
                    name: req.name.clone(),
                });
            } else {
                // Concurrent edits: insert conflict markers.
                req.raw = build_conflict_raw(
                    &req.name,
                    &extract_body(base_body),
                    &extract_body(&delta_body),
                    &extract_body(&live_body),
                );
                report.conflicts.push(ReqRef {
                    domain: domain.clone(),
                    name: req.name.clone(),
                });
            }
            changed = true;
        }

        for name in &delta.removed {
            let key = (domain.clone(), name.clone());
            if let Some(f) = base_map.get(&key)
                && let Some(live_raw) = current.get(&key)
                && f.body != normalize(live_raw)
            {
                report.conflicts.push(ReqRef {
                    domain: domain.clone(),
                    name: name.clone(),
                });
            }
        }

        for rename in &delta.renamed {
            let key = (domain.clone(), rename.from.clone());
            if let Some(f) = base_map.get(&key)
                && let Some(live_raw) = current.get(&key)
                && f.body != normalize(live_raw)
            {
                report.conflicts.push(ReqRef {
                    domain: domain.clone(),
                    name: rename.from.clone(),
                });
            }
        }

        if changed {
            files_to_write.push((path, format_delta(&delta)));
        }
    }

    if report.conflicts.is_empty() {
        for (path, content) in files_to_write {
            // Merge back any non-standard content from the original file
            // (preamble, custom sections); format_delta only serializes the
            // four known sections and would silently delete user notes.
            let merged = match std::fs::read_to_string(&path) {
                Ok(original) => merge_delta_preserving_extras(&original, &content),
                Err(_) => content,
            };
            fs::write(&path, merged)
                .with_context(|| format!("failed to write {}", path.display()))?;
        }
        capture_base_snapshot(&specs_dir, &change_dir)?;
        report.base_updated = true;
    }

    Ok(report)
}

/// Merge a freshly formatted delta with the original file's non-standard
/// content: the preamble before the first `## ` header and any custom
/// sections, which `format_delta` cannot represent.
fn merge_delta_preserving_extras(original: &str, formatted: &str) -> String {
    const KNOWN_SECTIONS: [&str; 4] = [
        "ADDED Requirements",
        "MODIFIED Requirements",
        "REMOVED Requirements",
        "RENAMED Requirements",
    ];
    let mut extras = String::new();
    let mut keep = true;
    for line in original.lines() {
        if let Some(title) = line.strip_prefix("## ") {
            keep = !KNOWN_SECTIONS
                .iter()
                .any(|known| title.trim().eq_ignore_ascii_case(known));
        }
        if keep {
            extras.push_str(line);
            extras.push('\n');
        }
    }
    let extras = extras.trim_end();
    if extras.is_empty() {
        formatted.to_string()
    } else {
        format!("{}\n\n{}", extras, formatted)
    }
}

fn base_map(base: &BaseSnapshot) -> BTreeMap<(String, String), &RequirementFingerprint> {
    let mut map = BTreeMap::new();
    for fp in &base.requirements {
        map.insert((fp.domain.clone(), fp.name.clone()), fp);
    }
    map
}

fn current_map(specs: &[Spec]) -> BTreeMap<(String, String), &str> {
    let mut map = BTreeMap::new();
    for spec in specs {
        for req in &spec.requirements {
            map.insert((spec.domain.clone(), req.name.clone()), req.raw.as_str());
        }
    }
    map
}

fn extract_body(raw: &str) -> String {
    let mut lines = raw.lines();
    if lines
        .next()
        .map(|l| l.starts_with("### Requirement:"))
        .unwrap_or(false)
    {
        lines.collect::<Vec<_>>().join("\n").trim().to_string()
    } else {
        raw.trim().to_string()
    }
}

fn build_conflict_raw(name: &str, base: &str, delta: &str, live: &str) -> String {
    format!(
        "### Requirement: {}\n<<<<<<< delta\n{}\n||||||| base\n{}\n=======\n{}\n>>>>>>> live",
        name, delta, base, live
    )
}

fn format_delta(delta: &DeltaSpec) -> String {
    let mut out = String::new();
    if !delta.added.is_empty() {
        out.push_str("## ADDED Requirements\n\n");
        for req in &delta.added {
            out.push_str(&req.raw);
            out.push_str("\n\n");
        }
    }
    if !delta.modified.is_empty() {
        out.push_str("## MODIFIED Requirements\n\n");
        for req in &delta.modified {
            out.push_str(&req.raw);
            out.push_str("\n\n");
        }
    }
    if !delta.removed.is_empty() {
        out.push_str("## REMOVED Requirements\n\n");
        for name in &delta.removed {
            out.push_str(&format!("- ### Requirement: {}\n", name));
        }
        out.push('\n');
    }
    if !delta.renamed.is_empty() {
        out.push_str("## RENAMED Requirements\n\n");
        for rename in &delta.renamed {
            out.push_str(&format!(
                "- FROM: `### Requirement: {}`\n- TO: `### Requirement: {}`\n",
                rename.from, rename.to
            ));
        }
        out.push('\n');
    }
    out.trim_end().to_string() + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprint::capture_base_snapshot;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn merge_preserves_preamble_and_custom_sections() {
        let original = "<!-- team note: do not lose this -->\n\n## ADDED Requirements\n\n### Requirement: A\nold body\n\n## Open Questions\n\n- what about X?\n";
        let formatted = "## ADDED Requirements\n\n### Requirement: B\nnew body\n";
        let merged = merge_delta_preserving_extras(original, formatted);

        assert!(merged.contains("<!-- team note: do not lose this -->"));
        assert!(merged.contains("## Open Questions"));
        assert!(merged.contains("what about X?"));
        assert!(merged.contains("### Requirement: B"));
        assert!(
            !merged.contains("old body"),
            "standard sections come from the formatted delta"
        );
    }

    #[test]
    fn merge_without_extras_returns_formatted() {
        let original = "## ADDED Requirements\n\n### Requirement: A\nold body\n";
        let formatted = "## ADDED Requirements\n\n### Requirement: B\nnew body\n";
        assert_eq!(
            merge_delta_preserving_extras(original, formatted),
            formatted
        );
    }

    fn write_spec(dir: &Path, domain: &str, content: &str) {
        let domain_dir = dir.join(".kcoder/specs/specs").join(domain);
        fs::create_dir_all(&domain_dir).unwrap();
        fs::write(domain_dir.join("spec.md"), content).unwrap();
    }

    #[test]
    fn sync_fast_forwards_unchanged_delta() {
        let dir = tmp_dir();
        write_spec(
            dir.path(),
            "core",
            "# Spec: core\n\n## Requirements\n\n### Requirement: login\nOld.\n",
        );

        let change_dir = dir.path().join(".kcoder/specs/changes/update");
        fs::create_dir_all(change_dir.join("specs")).unwrap();
        fs::write(
            change_dir.join("specs/core.md"),
            "<!-- keep this team note -->\n\n## MODIFIED Requirements\n\n### Requirement: login\nOld.\n\n## Open Questions\n\n- preserve this question\n",
        )
        .unwrap();
        capture_base_snapshot(&dir.path().join(crate::SPECS_DIR), &change_dir).unwrap();

        fs::write(
            dir.path().join(".kcoder/specs/specs/core/spec.md"),
            "# Spec: core\n\n## Requirements\n\n### Requirement: login\nNew.\n",
        )
        .unwrap();

        let report = sync(dir.path(), "update").unwrap();
        assert_eq!(report.fast_forwards.len(), 1);
        assert!(report.conflicts.is_empty());
        assert!(report.base_updated);

        let delta = fs::read_to_string(change_dir.join("specs/core.md")).unwrap();
        assert!(delta.contains("New."));
        assert!(delta.contains("<!-- keep this team note -->"), "{delta}");
        assert!(delta.contains("## Open Questions"), "{delta}");
        assert!(delta.contains("preserve this question"), "{delta}");
    }

    #[test]
    fn sync_detects_conflict_when_both_sides_edited() {
        let dir = tmp_dir();
        write_spec(
            dir.path(),
            "core",
            "# Spec: core\n\n## Requirements\n\n### Requirement: login\nBase.\n",
        );

        let change_dir = dir.path().join(".kcoder/specs/changes/update");
        fs::create_dir_all(change_dir.join("specs")).unwrap();
        fs::write(
            change_dir.join("specs/core.md"),
            "## MODIFIED Requirements\n\n### Requirement: login\nDelta.\n",
        )
        .unwrap();
        capture_base_snapshot(&dir.path().join(crate::SPECS_DIR), &change_dir).unwrap();

        fs::write(
            dir.path().join(".kcoder/specs/specs/core/spec.md"),
            "# Spec: core\n\n## Requirements\n\n### Requirement: login\nLive.\n",
        )
        .unwrap();

        let report = sync(dir.path(), "update").unwrap();
        assert!(report.fast_forwards.is_empty());
        assert_eq!(report.conflicts.len(), 1);
        assert!(!report.base_updated);

        // Conflicts block file writes and base refresh until the user resolves
        // them manually and re-runs sync.
        let delta = fs::read_to_string(change_dir.join("specs/core.md")).unwrap();
        assert!(delta.contains("Delta."));
    }

    #[test]
    fn sync_updates_base_when_no_deltas() {
        let dir = tmp_dir();
        let change_dir = dir.path().join(".kcoder/specs/changes/update");
        fs::create_dir_all(&change_dir).unwrap();
        capture_base_snapshot(&dir.path().join(crate::SPECS_DIR), &change_dir).unwrap();

        let report = sync(dir.path(), "update").unwrap();
        assert!(report.base_updated);
        assert!(report.conflicts.is_empty());
    }
}
