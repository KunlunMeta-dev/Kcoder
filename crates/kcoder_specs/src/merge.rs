//! Apply a change's delta specs to the authoritative spec files.
//!
//! This implements the OpenSpec archive step: once drift checks pass, the
//! requirement-level operations in `changes/<name>/specs/` are merged into
//! `.kcoder/specs/specs/<domain>/spec.md`.

use crate::parse::{DeltaSpec, Spec, load_authoritative_specs, load_change_deltas};
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Merge a single change into the authoritative specs.
///
/// Returns the paths of every spec file that was updated.
pub fn merge_change(specs_dir: &Path, change_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut specs: BTreeMap<String, Spec> = load_authoritative_specs(specs_dir)?
        .into_iter()
        .map(|s| (s.domain.clone(), s))
        .collect();
    let deltas = load_change_deltas(change_dir)?;

    let mut updated_domains = Vec::new();

    for (domain, delta) in deltas {
        let spec = specs.entry(domain.clone()).or_insert_with(|| Spec {
            domain: domain.clone(),
            purpose: String::new(),
            requirements: Vec::new(),
            sections: vec![
                ("Purpose".to_string(), String::new()),
                ("Requirements".to_string(), String::new()),
            ],
        });

        apply_delta(spec, &delta, &domain)
            .with_context(|| format!("failed to apply delta for {}", domain))?;

        if !updated_domains.contains(&domain) {
            updated_domains.push(domain);
        }
    }

    let mut updated_paths = Vec::new();
    for domain in updated_domains {
        let spec = specs
            .remove(&domain)
            .expect("domain was just inserted or updated");
        let domain_dir = specs_dir.join("specs").join(&domain);
        fs::create_dir_all(&domain_dir)
            .with_context(|| format!("failed to create {}", domain_dir.display()))?;
        let path = domain_dir.join("spec.md");
        fs::write(&path, format_spec(&spec))
            .with_context(|| format!("failed to write {}", path.display()))?;
        updated_paths.push(path);
    }

    Ok(updated_paths)
}

fn apply_delta(spec: &mut Spec, delta: &DeltaSpec, domain: &str) -> Result<()> {
    // Fill missing documentation without silently replacing an established purpose.
    if spec.purpose.trim().is_empty()
        && let Some(purpose) = &delta.purpose
    {
        spec.purpose = purpose.clone();
    }
    // Process renames first so modified blocks can refer to the new name.
    for rename in &delta.renamed {
        let pos = spec
            .requirements
            .iter()
            .position(|r| r.name == rename.from)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "specs/{}: renamed requirement '{}' not found",
                    domain,
                    rename.from
                )
            })?;
        let mut req = spec.requirements.remove(pos);
        req.name = rename.to.clone();
        req.raw = req
            .raw
            .replacen(
                &format!("### Requirement: {}", rename.from),
                &format!("### Requirement: {}", rename.to),
                1,
            )
            .to_string();
        spec.requirements.push(req);
    }

    for req in &delta.modified {
        let pos = spec
            .requirements
            .iter()
            .position(|r| r.name == req.name)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "specs/{}: modified requirement '{}' not found",
                    domain,
                    req.name
                )
            })?;
        spec.requirements[pos] = req.clone();
    }

    for req in &delta.added {
        if spec.requirements.iter().any(|r| r.name == req.name) {
            anyhow::bail!(
                "specs/{}: added requirement '{}' already exists",
                domain,
                req.name
            );
        }
        spec.requirements.push(req.clone());
    }

    for name in &delta.removed {
        let pos = spec
            .requirements
            .iter()
            .position(|r| r.name == *name)
            .ok_or_else(|| {
                anyhow::anyhow!("specs/{}: removed requirement '{}' not found", domain, name)
            })?;
        spec.requirements.remove(pos);
    }

    Ok(())
}

fn format_spec(spec: &Spec) -> String {
    let mut out = format!("# Spec: {}\n", spec.domain);
    if spec.sections.is_empty() {
        out.push_str("\n## Purpose\n\n");
        out.push_str(&spec.purpose);
        out.push_str("\n\n## Requirements\n\n");
        for req in &spec.requirements {
            out.push_str(&req.raw);
            out.push_str("\n\n");
        }
    } else {
        for (title, body) in &spec.sections {
            out.push_str("\n## ");
            out.push_str(title);
            out.push_str("\n\n");
            if title.eq_ignore_ascii_case("Purpose") {
                out.push_str(&spec.purpose);
            } else if title.eq_ignore_ascii_case("Requirements") {
                for req in &spec.requirements {
                    out.push_str(&req.raw);
                    out.push_str("\n\n");
                }
                continue; // avoid appending original body
            } else {
                out.push_str(body);
            }
            out.push('\n');
        }
    }
    out.trim_end().to_string() + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprint::capture_base_snapshot;
    use crate::parse::parse_spec;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_spec(dir: &Path, domain: &str, content: &str) {
        let domain_dir = dir.join("specs").join(domain);
        fs::create_dir_all(&domain_dir).unwrap();
        fs::write(domain_dir.join("spec.md"), content).unwrap();
    }

    #[test]
    fn merge_adds_modifies_removes_and_renames_requirements() {
        let dir = tmp_dir();
        write_spec(
            dir.path(),
            "core",
            "# Spec: core\n\n## Requirements\n\n### Requirement: keep\nKeep me.\n\n### Requirement: modify\nOld body.\n\n### Requirement: delete\nDelete me.\n\n### Requirement: old-name\nRename me.\n",
        );

        let change_dir = dir.path().join("changes/cleanup");
        fs::create_dir_all(change_dir.join("specs")).unwrap();
        fs::write(
            change_dir.join("specs/core.md"),
            "## ADDED Requirements\n\n### Requirement: fresh\nNew requirement.\n\n## MODIFIED Requirements\n\n### Requirement: modify\nUpdated body.\n\n## REMOVED Requirements\n\n### Requirement: delete\n\n## RENAMED Requirements\n\n- FROM: `### Requirement: old-name`\n- TO: `### Requirement: new-name`\n",
        )
        .unwrap();

        capture_base_snapshot(dir.path(), &change_dir).unwrap();

        let updated = merge_change(dir.path(), &change_dir).unwrap();
        assert_eq!(updated.len(), 1);

        let merged = fs::read_to_string(&updated[0]).unwrap();
        let spec = parse_spec(&merged, "core").unwrap();
        let names: Vec<_> = spec.requirements.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["keep", "modify", "new-name", "fresh"]);
        assert!(
            spec.requirements
                .iter()
                .find(|r| r.name == "modify")
                .unwrap()
                .raw
                .contains("Updated body")
        );
    }

    #[test]
    fn merge_preserves_free_sections() {
        let dir = tmp_dir();
        write_spec(
            dir.path(),
            "core",
            "# Spec: core\n\n## Purpose\n\nCore.\n\n## Migration Notes\n\nSee ADR-014.\n\n## Requirements\n\n### Requirement: keep\nKeep me.\n",
        );

        let change_dir = dir.path().join("changes/update");
        fs::create_dir_all(change_dir.join("specs")).unwrap();
        fs::write(
            change_dir.join("specs/core.md"),
            "## ADDED Requirements\n\n### Requirement: fresh\nNew.\n",
        )
        .unwrap();

        let updated = merge_change(dir.path(), &change_dir).unwrap();
        let merged = fs::read_to_string(&updated[0]).unwrap();
        assert!(merged.contains("## Migration Notes"));
        assert!(merged.contains("See ADR-014"));
        assert!(merged.contains("### Requirement: fresh"));
    }

    #[test]
    fn merge_initializes_missing_purpose_from_delta_without_overwriting_existing_purpose() {
        for initial in [None, Some(""), Some("Existing purpose.")] {
            let dir = tmp_dir();
            if let Some(purpose) = initial {
                write_spec(
                    dir.path(),
                    "api",
                    &format!("# Spec: api\n\n## Purpose\n\n{purpose}\n\n## Requirements\n"),
                );
            }
            let change = dir.path().join("changes").join("purpose");
            fs::create_dir_all(change.join("specs")).unwrap();
            fs::write(change.join("specs").join("api.md"),
                "## Purpose\n\nDocument the API contract.\n\n## ADDED Requirements\n\n### Requirement: endpoint\nGET /health.\n").unwrap();
            let updated = merge_change(dir.path(), &change).unwrap();
            let spec = parse_spec(&fs::read_to_string(&updated[0]).unwrap(), "api").unwrap();
            assert_eq!(
                spec.purpose,
                initial
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Document the API contract.")
            );
            assert_eq!(spec.requirements.len(), 1);
        }
    }

    #[test]
    fn merge_creates_new_domain_for_pure_addition() {
        let dir = tmp_dir();
        let change_dir = dir.path().join("changes/new-domain");
        fs::create_dir_all(change_dir.join("specs")).unwrap();
        fs::write(
            change_dir.join("specs/api.md"),
            "## ADDED Requirements\n\n### Requirement: endpoint\nGET /health.\n",
        )
        .unwrap();

        let updated = merge_change(dir.path(), &change_dir).unwrap();
        assert_eq!(updated.len(), 1);
        assert!(updated[0].ends_with(Path::new("api").join("spec.md")));

        let merged = fs::read_to_string(&updated[0]).unwrap();
        assert!(merged.contains("### Requirement: endpoint"));
    }
}
