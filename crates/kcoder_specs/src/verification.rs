//! Spec verification domain implementation.

use super::*;

/// Run the project's verification suite before archiving.
///
/// Uses the `precheck` command from `.kcoder/specs/config.yaml` if present.
/// If omitted, it falls back to `cargo test` when a `Cargo.toml` exists.
/// `KCODER_SPEC_SKIP_TESTS` skips the fallback but not an explicit precheck.
pub(super) fn run_precheck(cwd: &Path, specs_dir: &Path) -> Result<()> {
    if let Some(config) = config::read_project_config(specs_dir)?
        && let Some(cmd) = &config.precheck
    {
        // Keep the old fallback behavior for the default `cargo test` command
        // when the project is not a Rust workspace.
        if cmd.trim() == "cargo test" && !cwd.join("Cargo.toml").exists() {
            return Ok(());
        }
        let shell_path = resolve_shell_program()?;
        let output = run_project_precheck(cwd, &shell_path, cmd)
            .with_context(|| format!("failed to spawn precheck command: {}", cmd))?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "precheck command failed; archive blocked.\ncommand: {}\nstdout:\n{}\nstderr:\n{}",
                cmd,
                stdout,
                stderr
            );
        }
        return Ok(());
    }

    run_verification_tests(cwd)
}

pub(super) fn run_verification_tests(cwd: &Path) -> Result<()> {
    if std::env::var("KCODER_SPEC_SKIP_TESTS").is_ok() {
        return Ok(());
    }
    if !cwd.join("Cargo.toml").exists() {
        return Ok(());
    }

    let cargo_path = resolve_program("cargo")?;
    let output =
        run_cargo_precheck(cwd, &cargo_path).with_context(|| "failed to spawn cargo test")?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "cargo test failed; archive blocked.\nstdout:\n{}\nstderr:\n{}",
            stdout,
            stderr
        );
    }
    Ok(())
}

/// Write retained completion evidence for a spec-driven change.
pub fn record_verification(
    cwd: &Path,
    name: &str,
    record: SpecVerificationRecord,
) -> Result<PathBuf> {
    let change_dir = checked_change_dir(cwd, name)?;
    if record.completion_decision.trim().is_empty() {
        anyhow::bail!("completion_decision cannot be empty");
    }

    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let path = change_dir.join("verification.md");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let manual_adjustments =
        markdown_section(&existing, "Manual Adjustments").unwrap_or_else(|| "none".to_string());
    let previous_iterations = markdown_section(&existing, "Previous Iterations");

    let mut content = String::new();
    content.push_str("# Verification\n\n");
    write_markdown_value(
        &mut content,
        "Completion Decision",
        record.completion_decision.trim(),
    );
    write_markdown_list(&mut content, "Commands Run", &record.commands_run);
    write_markdown_list(&mut content, "Manual Checks", &record.manual_checks);
    write_markdown_list(&mut content, "Evidence", &record.evidence);
    write_markdown_list(&mut content, "Residual Risks", &record.residual_risks);
    if let Some(previous_iterations) = previous_iterations {
        write_markdown_value(
            &mut content,
            "Previous Iterations",
            previous_iterations.trim(),
        );
    }
    write_markdown_value(
        &mut content,
        "Manual Adjustments",
        manual_adjustments.trim(),
    );

    fs::write(&path, content).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(path)
}

/// Compare spec scenarios against the project's test suite.
///
/// Runs `cargo test -- --list` and checks whether each scenario title is
/// reflected in at least one test name. Returns covered scenarios and gaps.
/// Non-Rust projects (no `Cargo.toml`) are not supported and return an error.
pub fn verify(cwd: &Path) -> Result<SpecVerifyReport> {
    let specs_dir = specs_dir_for(cwd);
    if !specs_dir.exists() {
        anyhow::bail!("spec subsystem has not been initialized");
    }
    if !cwd.join("Cargo.toml").exists() {
        anyhow::bail!("SpecCheck action=verify only supports Rust projects with a Cargo.toml");
    }

    let specs = parse::load_authoritative_specs(&specs_dir)?;
    let mut scenarios: Vec<(String, String)> = Vec::new(); // (domain, title)
    for spec in specs {
        for req in &spec.requirements {
            for scenario in &req.scenarios {
                scenarios.push((spec.domain.clone(), scenario.title.clone()));
            }
        }
    }

    let cargo_path = resolve_program("cargo")?;
    let output = run_cargo_command(cwd, &cargo_path, &["test", "--", "--list"])
        .with_context(|| "failed to run cargo test -- --list")?;
    if !output.status.success() {
        anyhow::bail!(
            "cargo test -- --list failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let test_names = parse_cargo_test_names(&String::from_utf8_lossy(&output.stdout));

    let mut report = SpecVerifyReport::default();
    for (domain, title) in scenarios {
        let keyword = normalize_scenario_keyword(&title);
        if keyword.is_empty() {
            report
                .gaps
                .push(format!("specs/{}: '{}' (empty title)", domain, title));
            continue;
        }
        if test_names
            .iter()
            .any(|name| name.to_ascii_lowercase().contains(&keyword))
        {
            report.covered.push(format!("specs/{}: {}", domain, title));
        } else {
            report.gaps.push(format!("specs/{}: {}", domain, title));
        }
    }

    Ok(report)
}

pub(super) fn parse_cargo_test_names(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("test result:") {
                return None;
            }
            if let Some(name) = trimmed.strip_suffix(": test") {
                let name = name.trim();
                return (!name.is_empty()).then(|| name.to_string());
            }
            let legacy = trimmed.strip_prefix("test ")?;
            let (name, status) = legacy.rsplit_once(" ... ")?;
            (!name.trim().is_empty() && matches!(status, "ok" | "FAILED" | "ignored"))
                .then(|| name.trim().to_string())
        })
        .collect()
}

pub(super) fn normalize_scenario_keyword(title: &str) -> String {
    title
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}
