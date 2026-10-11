//! Spec validation domain implementation.

use super::*;

/// Validate a change or the entire spec subsystem.
pub fn validate(cwd: &Path, change_name: Option<&str>) -> Result<Vec<String>> {
    let checked_change = change_name
        .map(|name| checked_change_dir(cwd, name))
        .transpose()?;
    let mut errors = Vec::new();

    let specs_dir = specs_dir_for(cwd);
    if !specs_dir.exists() {
        errors.push("spec subsystem has not been initialized".to_string());
        return Ok(errors);
    }

    if let Some(name) = change_name {
        let change_dir = checked_change.as_ref().expect("已校验指定的 change");
        if !change_dir.exists() {
            errors.push(format!("change '{}' does not exist", name));
            return Ok(errors);
        }
        validate_change(change_dir, &mut errors)?;
    } else {
        let changes_dir = checked_changes_dir(cwd)?;
        for entry in fs::read_dir(&changes_dir)
            .with_context(|| format!("failed to read {:?}", changes_dir))?
        {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() || path.file_name() == Some(std::ffi::OsStr::new("archive")) {
                continue;
            }
            let name = entry.file_name();
            let checked =
                checked_change_dir(cwd, name.to_str().context("change name is not UTF-8")?)?;
            if let Err(e) = validate_change(&checked, &mut errors) {
                errors.push(format!("{}: {}", path.display(), e));
            }
        }
    }

    // Structural validation of authoritative specs and deltas.
    validate_authoritative_specs(&specs_dir, &mut errors)?;
    if let Some(change_dir) = checked_change {
        validate_change_deltas(&specs_dir, &change_dir, &mut errors)?;
        validate_config_rules(&specs_dir, &change_dir, &mut errors)?;
    } else {
        let changes_dir = checked_changes_dir(cwd)?;
        for entry in fs::read_dir(&changes_dir)
            .with_context(|| format!("failed to read {:?}", changes_dir))?
        {
            let path = entry?.path();
            if !path.is_dir() || path.file_name() == Some(std::ffi::OsStr::new("archive")) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .context("change name is not UTF-8")?;
            let path = checked_change_dir(cwd, name)?;
            validate_change_deltas(&specs_dir, &path, &mut errors)?;
            validate_config_rules(&specs_dir, &path, &mut errors)?;
        }
    }

    if let Some(config) = config::read_project_config(&specs_dir)? {
        errors.extend(config::validate_schema(&config));
    }

    Ok(errors)
}

pub(super) fn validate_authoritative_specs(
    specs_dir: &Path,
    errors: &mut Vec<String>,
) -> Result<()> {
    match parse::load_authoritative_specs(specs_dir) {
        Ok(specs) => {
            for spec in specs {
                if spec.domain.trim().is_empty() {
                    errors.push("spec: missing domain".to_string());
                }
                if spec.purpose.trim().is_empty() {
                    errors.push(format!("specs/{}: missing purpose", spec.domain));
                }
                for req in &spec.requirements {
                    validate_requirement_structure(&spec.domain, req, errors);
                }
            }
        }
        Err(e) => errors.push(format!("failed to parse authoritative specs: {}", e)),
    }
    Ok(())
}

pub(super) fn validate_change_deltas(
    specs_dir: &Path,
    change_dir: &Path,
    errors: &mut Vec<String>,
) -> Result<()> {
    let change_name = change_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?");
    scan_unresolved_conflict_markers(change_dir, change_name, errors)?;
    match parse::load_change_deltas(change_dir) {
        Ok(deltas) => {
            for (domain, delta) in deltas {
                for req in &delta.added {
                    validate_requirement_structure(&domain, req, errors);
                }
                for req in &delta.modified {
                    validate_requirement_structure(&domain, req, errors);
                }
                for name in &delta.removed {
                    if name.trim().is_empty() {
                        errors.push(format!(
                            "change {} specs/{}: empty removed requirement name",
                            change_name, domain
                        ));
                    }
                }
                for rename in &delta.renamed {
                    if rename.from.trim().is_empty() || rename.to.trim().is_empty() {
                        errors.push(format!(
                            "change {} specs/{}: empty rename pair",
                            change_name, domain
                        ));
                    }
                }
            }
        }
        Err(e) => errors.push(format!(
            "change {}: failed to parse delta specs: {}",
            change_name, e
        )),
    }

    // Cross-check: modified/removed/renamed.from requirements must exist.
    match fingerprint::check_change(specs_dir, change_dir) {
        Ok(drift_errors) => errors.extend(drift_errors),
        Err(e) => errors.push(format!(
            "change {}: failed to cross-check spec drift: {}",
            change_name, e
        )),
    }
    Ok(())
}

pub(super) fn scan_unresolved_conflict_markers(
    change_dir: &Path,
    change_name: &str,
    errors: &mut Vec<String>,
) -> Result<()> {
    let specs_dir = change_dir.join("specs");
    if !specs_dir.exists() {
        return Ok(());
    }

    for path in collect_markdown_files(&specs_dir)? {
        let content =
            fs::read_to_string(&path).with_context(|| format!("failed to read {:?}", path))?;
        if content.contains("<<<<<<<")
            || content.contains("=======")
            || content.contains(">>>>>>>")
            || content.contains("|||||||")
        {
            let rel = path.strip_prefix(change_dir).unwrap_or(path.as_path());
            errors.push(format!(
                "change {} {}: unresolved conflict marker",
                change_name,
                rel.display()
            ));
        }
    }

    Ok(())
}

pub(super) fn collect_markdown_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_markdown_files_inner(root, &mut files)?;
    Ok(files)
}

pub(super) fn collect_markdown_files_inner(root: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("failed to read {:?}", root))? {
        let path = entry?.path();
        if path.is_dir() {
            collect_markdown_files_inner(&path, files)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            files.push(path);
        }
    }
    Ok(())
}

pub(super) fn validate_requirement_structure(
    domain: &str,
    req: &parse::Requirement,
    errors: &mut Vec<String>,
) {
    if req.name.trim().is_empty() {
        errors.push(format!("specs/{}: requirement name is empty", domain));
        return;
    }
    let desc = req.description.trim();
    if desc.is_empty() {
        errors.push(format!(
            "specs/{}: requirement '{}' has no description",
            domain, req.name
        ));
    } else if !desc.to_ascii_lowercase().contains("shall")
        && !desc.to_ascii_lowercase().contains("must")
        && !desc.to_ascii_lowercase().contains("should")
        && !desc.to_ascii_lowercase().contains("may")
    {
        errors.push(format!(
            "specs/{}: requirement '{}' description lacks SHALL/MUST/SHOULD/MAY",
            domain, req.name
        ));
    }

    for scenario in &req.scenarios {
        if scenario.title.trim().is_empty() {
            errors.push(format!(
                "specs/{}: requirement '{}' has scenario without title",
                domain, req.name
            ));
        }
        let body = scenario.body.to_ascii_lowercase();
        if !body.contains("when") || !body.contains("then") {
            errors.push(format!(
                "specs/{}: requirement '{}' scenario '{}' missing WHEN/THEN",
                domain, req.name, scenario.title
            ));
        }
    }
}

pub(super) fn validate_config_rules(
    specs_dir: &Path,
    change_dir: &Path,
    errors: &mut Vec<String>,
) -> Result<()> {
    let config = match config::read_project_config(specs_dir)? {
        Some(c) => c,
        None => return Ok(()),
    };

    let specs = match parse::load_authoritative_specs(specs_dir) {
        Ok(s) => s,
        Err(e) => {
            errors.push(format!("failed to parse authoritative specs: {}", e));
            return Ok(());
        }
    };
    let deltas = match parse::load_change_deltas(change_dir) {
        Ok(d) => d,
        Err(e) => {
            errors.push(format!("failed to parse delta specs: {}", e));
            return Ok(());
        }
    };
    let mut merged = specs.clone();
    for (domain, delta) in deltas {
        let mut reqs = delta.added;
        reqs.extend(delta.modified);
        if !reqs.is_empty() {
            merged.push(Spec {
                domain,
                purpose: String::new(),
                requirements: reqs,
                sections: Vec::new(),
            });
        }
    }

    config::apply_rules(&config, &merged, change_dir, errors)?;
    Ok(())
}

pub(super) fn validate_change(change_dir: &Path, errors: &mut Vec<String>) -> Result<()> {
    let meta_path = change_dir.join(".spec.yaml");
    if !meta_path.exists() {
        errors.push(format!("{}: missing .spec.yaml", change_dir.display()));
        return Ok(());
    }
    let meta =
        read_metadata(&meta_path).with_context(|| format!("failed to read {:?}", meta_path))?;

    let schema = metadata_schema_or_default(&meta);
    for &artifact in required_artifacts_for_schema(&schema) {
        let path = change_dir.join(artifact);
        if !path.exists() {
            errors.push(format!(
                "{}: missing artifact {}",
                change_dir.display(),
                artifact
            ));
        }
    }

    if meta.status == ChangeStatus::ReadyForArchive || meta.status == ChangeStatus::Archived {
        let tasks_path = change_dir.join("tasks.md");
        if tasks_path.exists() {
            let tasks = fs::read_to_string(&tasks_path)?;
            if tasks.contains("[ ]") {
                errors.push(format!(
                    "{}: incomplete tasks cannot be archived",
                    change_dir.display()
                ));
            }
        }
    }

    Ok(())
}
