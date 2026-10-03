//! Base-spec fingerprints for safe archive / merge workflows.
//!
//! When a change is created we snapshot the current authoritative requirement
//! bodies into `changes/<name>/.base.json`. Before archiving we recompute the
//! live bodies and compare them to the snapshot for every requirement the
//! change touches. If the live spec has drifted, the archive is aborted so
//! parallel changes cannot silently clobber each other.

use crate::parse::{Spec, load_authoritative_specs, load_change_deltas, normalize};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Per-requirement snapshot used for three-way comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequirementFingerprint {
    pub domain: String,
    pub name: String,
    /// Normalized raw body of the requirement block at change creation time.
    pub body: String,
}

/// Full base snapshot stored alongside a change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaseSnapshot {
    pub requirements: Vec<RequirementFingerprint>,
}

impl BaseSnapshot {
    fn from_specs(specs: &[Spec]) -> Self {
        let mut requirements = Vec::new();
        for spec in specs {
            for req in &spec.requirements {
                requirements.push(RequirementFingerprint {
                    domain: spec.domain.clone(),
                    name: req.name.clone(),
                    body: normalize(&req.raw),
                });
            }
        }
        requirements.sort_by(|a, b| a.domain.cmp(&b.domain).then_with(|| a.name.cmp(&b.name)));
        Self { requirements }
    }

    fn key(&self, domain: &str, name: &str) -> Option<&RequirementFingerprint> {
        self.requirements
            .iter()
            .find(|r| r.domain == domain && r.name == name)
    }
}

/// Path to the base snapshot file inside a change directory.
pub fn base_snapshot_path(change_dir: &Path) -> PathBuf {
    change_dir.join(".base.json")
}

/// Capture the current authoritative specs and write them as the change base.
pub fn capture_base_snapshot(specs_dir: &Path, change_dir: &Path) -> Result<()> {
    let specs = load_authoritative_specs(specs_dir)?;
    let snapshot = BaseSnapshot::from_specs(&specs);
    let path = base_snapshot_path(change_dir);
    let json = serde_json::to_string_pretty(&snapshot)
        .with_context(|| "failed to serialize base snapshot")?;
    fs::write(&path, json).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

/// Load a previously captured base snapshot.
pub fn load_base_snapshot(change_dir: &Path) -> Result<BaseSnapshot> {
    let path = base_snapshot_path(change_dir);
    if !path.exists() {
        return Ok(BaseSnapshot::default());
    }
    let text =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("failed to parse {}", path.display()))
}

/// Check a change against the current authoritative specs.
///
/// Returns human-readable error strings for any inconsistency. An empty vector
/// means the change can safely be archived.
pub fn check_change(specs_dir: &Path, change_dir: &Path) -> Result<Vec<String>> {
    let mut errors = Vec::new();

    let current_specs = load_authoritative_specs(specs_dir).unwrap_or_default();
    let current = build_current_map(&current_specs);
    let base = load_base_snapshot(change_dir)?;
    let deltas = load_change_deltas(change_dir)?;

    if deltas.is_empty() {
        return Ok(errors);
    }

    for (domain, delta) in &deltas {
        for req in &delta.added {
            if current.contains_key(&(domain.as_str(), req.name.as_str())) {
                errors.push(format!(
                    "specs/{}: added requirement '{}' already exists in the current spec",
                    domain, req.name
                ));
            }
        }

        for req in &delta.modified {
            if !current.contains_key(&(domain.as_str(), req.name.as_str())) {
                errors.push(format!(
                    "specs/{}: modified requirement '{}' does not exist in the current spec",
                    domain, req.name
                ));
            } else if let Some(f) = base.key(domain, &req.name) {
                let live = current
                    .get(&(domain.as_str(), req.name.as_str()))
                    .expect("checked above");
                if f.body != normalize(live) {
                    errors.push(format!(
                        "specs/{}: requirement '{}' has changed since this change was created; rerun the spec rebase workflow before archiving",
                        domain, req.name
                    ));
                }
            }
        }

        for name in &delta.removed {
            if !current.contains_key(&(domain.as_str(), name.as_str())) {
                errors.push(format!(
                    "specs/{}: removed requirement '{}' does not exist in the current spec",
                    domain, name
                ));
            } else if let Some(f) = base.key(domain, name) {
                let live = current
                    .get(&(domain.as_str(), name.as_str()))
                    .expect("checked above");
                if f.body != normalize(live) {
                    errors.push(format!(
                        "specs/{}: requirement '{}' has changed since this change was created; rerun the spec rebase workflow before archiving",
                        domain, name
                    ));
                }
            }
        }

        for rename in &delta.renamed {
            if !current.contains_key(&(domain.as_str(), rename.from.as_str())) {
                errors.push(format!(
                    "specs/{}: renamed requirement '{}' does not exist in the current spec",
                    domain, rename.from
                ));
            } else if let Some(f) = base.key(domain, &rename.from) {
                let live = current
                    .get(&(domain.as_str(), rename.from.as_str()))
                    .expect("checked above");
                if f.body != normalize(live) {
                    errors.push(format!(
                        "specs/{}: requirement '{}' has changed since this change was created; rerun the spec rebase workflow before archiving",
                        domain, rename.from
                    ));
                }
            }
            if current.contains_key(&(domain.as_str(), rename.to.as_str()))
                && rename.from != rename.to
            {
                errors.push(format!(
                    "specs/{}: rename target '{}' already exists in the current spec",
                    domain, rename.to
                ));
            }
        }
    }

    Ok(errors)
}

fn build_current_map(specs: &[Spec]) -> BTreeMap<(&str, &str), &str> {
    let mut map = BTreeMap::new();
    for spec in specs {
        for req in &spec.requirements {
            map.insert((spec.domain.as_str(), req.name.as_str()), req.raw.as_str());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn capture_and_load_snapshot_roundtrip() {
        let dir = tmp_dir();
        let core_dir = dir.path().join("specs/core");
        fs::create_dir_all(&core_dir).unwrap();
        fs::write(
            core_dir.join("spec.md"),
            "# Spec: core\n\n## Requirements\n\n### Requirement: login\nUsers MUST authenticate.\n",
        )
        .unwrap();

        let change_dir = dir.path().join("changes/add-mfa");
        fs::create_dir_all(&change_dir).unwrap();
        capture_base_snapshot(dir.path(), &change_dir).unwrap();

        let snapshot = load_base_snapshot(&change_dir).unwrap();
        assert_eq!(snapshot.requirements.len(), 1);
        assert_eq!(snapshot.requirements[0].name, "login");
        assert!(snapshot.requirements[0].body.contains("login"));
    }

    #[test]
    fn check_change_detects_drift() {
        let dir = tmp_dir();
        let core_dir = dir.path().join("specs/core");
        fs::create_dir_all(&core_dir).unwrap();
        fs::write(
            core_dir.join("spec.md"),
            "# Spec: core\n\n## Requirements\n\n### Requirement: login\nUsers MUST authenticate.\n",
        )
        .unwrap();

        let change_dir = dir.path().join("changes/add-mfa");
        fs::create_dir_all(change_dir.join("specs")).unwrap();
        capture_base_snapshot(dir.path(), &change_dir).unwrap();

        fs::write(
            core_dir.join("spec.md"),
            "# Spec: core\n\n## Requirements\n\n### Requirement: login\nUsers MUST authenticate with MFA.\n",
        )
        .unwrap();

        let mut file = fs::File::create(change_dir.join("specs/core.md")).unwrap();
        writeln!(
            file,
            "## MODIFIED Requirements\n\n### Requirement: login\nUsers MUST authenticate with MFA and SSO.\n"
        )
        .unwrap();

        let errors = check_change(dir.path(), &change_dir).unwrap();
        assert!(
            errors.iter().any(|e| e.contains("has changed")),
            "errors: {:?}",
            errors
        );
    }
}
