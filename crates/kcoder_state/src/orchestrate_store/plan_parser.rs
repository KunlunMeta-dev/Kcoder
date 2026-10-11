use super::*;

pub fn parse_plan(plan: &str) -> anyhow::Result<ParsedPlan> {
    let lines = plan.lines().collect::<Vec<_>>();
    if !lines.first().is_some_and(|line| line.starts_with("# ")) {
        bail!("plan must start with one level-one title");
    }
    let context = lines
        .iter()
        .position(|line| *line == "## Context")
        .context("missing ## Context")?;
    let todos = lines
        .iter()
        .position(|line| *line == "## TODOs")
        .context("missing ## TODOs")?;
    let final_wave = lines
        .iter()
        .position(|line| *line == "## Final Verification Wave")
        .context("missing ## Final Verification Wave")?;
    if !(context < todos && todos < final_wave) {
        bail!("plan sections must be ordered Context, TODOs, Final Verification Wave");
    }

    let mut tasks = Vec::new();
    let mut todo_number = 1usize;
    let mut final_number = 1usize;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("- [") && !line.starts_with("- [") {
            continue;
        }
        if !line.starts_with("- [") {
            continue;
        }
        let (completed, tail) = if let Some(tail) = line.strip_prefix("- [ ] ") {
            (false, tail)
        } else if let Some(tail) = line.strip_prefix("- [x] ") {
            (true, tail)
        } else {
            bail!("checkbox at line {} must use [ ] or [x]", index + 1);
        };
        if index > todos && index < final_wave {
            let prefix = format!("{todo_number}. ");
            if !tail.starts_with(&prefix) {
                bail!("TODO numbering must be contiguous at {todo_number}");
            }
            validate_todo_metadata(&lines, index, final_wave)?;
            tasks.push(PlanTask {
                key: todo_number.to_string(),
                completed,
                line_index: index,
                is_final_verification: false,
                evidence_requirements: Vec::new(),
            });
            todo_number += 1;
        } else if index > final_wave {
            let prefix = format!("F{final_number}. ");
            if !tail.starts_with(&prefix) {
                bail!("final verification numbering must be contiguous at F{final_number}");
            }
            let evidence_requirements = final_evidence_requirements(&lines, index)?;
            tasks.push(PlanTask {
                key: format!("F{final_number}"),
                completed,
                line_index: index,
                is_final_verification: true,
                evidence_requirements,
            });
            final_number += 1;
        } else {
            bail!(
                "checkbox at line {} is outside plan task sections",
                index + 1
            );
        }
    }
    if todo_number == 1 || final_number == 1 {
        bail!("TODOs and Final Verification Wave must each contain at least one item");
    }
    Ok(ParsedPlan { tasks })
}

pub(super) fn final_evidence_requirements(
    lines: &[&str],
    task_line: usize,
) -> anyhow::Result<Vec<EvidenceRequirement>> {
    let end = ((task_line + 1)..lines.len())
        .find(|index| lines[*index].starts_with("- ["))
        .unwrap_or(lines.len());
    let values = (task_line + 1..end)
        .filter_map(|index| lines[index].strip_prefix("  - evidence: "))
        .collect::<Vec<_>>();
    if values.len() != 1 {
        bail!(
            "final verification at line {} must declare exactly one `  - evidence:` metadata line",
            task_line + 1
        );
    }
    let requirements = values[0]
        .split(',')
        .map(EvidenceRequirement::parse)
        .collect::<anyhow::Result<Vec<_>>>()?;
    if requirements.is_empty() {
        bail!("final verification evidence requirement must not be empty");
    }
    Ok(requirements)
}

pub(super) fn validate_todo_metadata(
    lines: &[&str],
    task_line: usize,
    final_wave: usize,
) -> anyhow::Result<()> {
    let end = ((task_line + 1)..final_wave)
        .find(|index| lines[*index].starts_with("- ["))
        .unwrap_or(final_wave);
    for field in ["artifacts", "write_scope", "acceptance", "verify"] {
        let prefix = format!("  - {field}: ");
        if !(task_line + 1..end).any(|index| lines[index].starts_with(&prefix)) {
            bail!("TODO at line {} is missing {field} metadata", task_line + 1);
        }
    }
    Ok(())
}

pub(super) fn task_block<'a>(plan: &'a str, task_key: &str) -> anyhow::Result<&'a str> {
    let parsed = parse_plan(plan)?;
    let task = parsed.task(task_key).context("unknown task")?;
    let starts = plan
        .match_indices('\n')
        .map(|(index, _)| index + 1)
        .collect::<Vec<_>>();
    let start = if task.line_index == 0 {
        0
    } else {
        starts[task.line_index - 1]
    };
    let next_line = parsed
        .tasks
        .iter()
        .filter(|candidate| candidate.line_index > task.line_index)
        .map(|candidate| candidate.line_index)
        .min();
    let end = next_line
        .and_then(|line| {
            if line == 0 {
                Some(0)
            } else {
                starts.get(line - 1).copied()
            }
        })
        .unwrap_or(plan.len());
    Ok(&plan[start..end])
}

pub(super) fn set_checkbox(
    plan: &str,
    line_index: usize,
    completed: bool,
) -> anyhow::Result<String> {
    let mut lines = plan.lines().map(str::to_string).collect::<Vec<_>>();
    let line = lines.get_mut(line_index).context("task line disappeared")?;
    let from = if completed { "- [ ] " } else { "- [x] " };
    let to = if completed { "- [x] " } else { "- [ ] " };
    if !line.starts_with(from) {
        bail!("task checkbox is not in the expected state");
    }
    *line = line.replacen(from, to, 1);
    let mut result = lines.join("\n");
    if plan.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

pub(super) fn validate_display_slug(slug: &str) -> anyhow::Result<()> {
    if slug.is_empty()
        || slug.len() > 80
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("display_slug must contain only ASCII letters, digits, '-' or '_'");
    }
    Ok(())
}
