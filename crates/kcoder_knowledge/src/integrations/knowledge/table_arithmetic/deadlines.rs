//! Literal-cell calendar observations; these never infer permission or task completion.
use super::{MAX_FACT_BYTES, tables};
use chrono::NaiveDate;
use kcoder_types::integrations::knowledge::{
    KnowledgeDeadlineClassification as Class, KnowledgeTableArithmeticStatus as Status,
    KnowledgeTableDeadlineRow, KnowledgeTableDeadlines,
};
use sha2::{Digest, Sha256};

fn date(value: &str) -> Option<NaiveDate> {
    if value.len() != 10
        || !value.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}
fn column(headers: &[String], names: &[&str]) -> Option<usize> {
    let found = headers
        .iter()
        .enumerate()
        .filter(|(_, header)| names.contains(&header.to_lowercase().as_str()))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    (found.len() == 1).then(|| found[0])
}

/// Uses the caller's pinned task date, never a date or instruction found in prose.
/// Only supported explicit states are classified; unknown cells remain unresolved.
pub fn calculate_markdown_deadline_facts(
    markdown: &str,
    as_of_date: &str,
) -> KnowledgeTableDeadlines {
    let mut result = KnowledgeTableDeadlines {
        status: Status::NotApplicable,
        markdown_sha256: format!("{:x}", Sha256::digest(markdown.as_bytes())),
        as_of_date: as_of_date.to_owned(),
        rows: Vec::new(),
    };
    let calculation = (|| {
        let as_of = date(as_of_date).ok_or(Status::Unsupported)?;
        for table in tables(markdown)? {
            let due = column(
                &table.headers,
                &["due date", "due", "deadline", "截止日期", "到期日期"],
            );
            let state = column(&table.headers, &["status", "状态"]);
            let id = column(
                &table.headers,
                &["item", "task", "id", "事项", "任务", "标识"],
            );
            let owner = column(&table.headers, &["owner", "assignee", "负责人"]);
            let (Some(due), Some(state), Some(id), Some(owner)) = (due, state, id, owner) else {
                continue;
            };
            for (line, cells) in table.rows {
                let source_status = &cells[state];
                let status = source_status.to_lowercase();
                let completed = matches!(
                    status.as_str(),
                    "completed" | "done" | "closed" | "已完成" | "完成" | "已关闭"
                );
                let open = matches!(
                    status.as_str(),
                    "open" | "pending" | "in progress" | "待办" | "进行中" | "未完成"
                );
                let delta = date(&cells[due]).map(|due_date| (as_of - due_date).num_days());
                let classification = if cells[id].is_empty() || cells[owner].is_empty() {
                    Class::Unresolved
                } else if completed {
                    Class::Completed
                } else if !open {
                    Class::Unresolved
                } else {
                    match delta {
                        Some(days) if days > 0 => Class::Overdue,
                        Some(-7..=0) => Class::Upcoming,
                        Some(_) => Class::Later,
                        None => Class::Unresolved,
                    }
                };
                result.rows.push(KnowledgeTableDeadlineRow {
                    table_start_line: table.line,
                    row_line: line,
                    id: cells[id].clone(),
                    owner: cells[owner].clone(),
                    due_date: cells[due].clone(),
                    source_status: source_status.clone(),
                    classification,
                    overdue_days: if classification == Class::Overdue {
                        delta.and_then(|days| u64::try_from(days).ok())
                    } else {
                        None
                    },
                });
            }
        }
        if serde_json::to_vec(&result.rows)
            .map_err(|_| Status::Unsupported)?
            .len()
            > MAX_FACT_BYTES
        {
            return Err(Status::LimitExceeded);
        }
        Ok(())
    })();
    if let Err(status) = calculation {
        result.status = status;
        result.rows.clear();
    } else if !result.rows.is_empty() {
        result.status = Status::Available;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_boundary_and_completed_filter_are_source_bound() {
        let markdown = "| Task | Owner | Due | Status |\n|---|---|---|---|\n| Q9 | Ada | 2024-02-28 | open |\n| Q4 | Ben | 2024-02-27 | completed |\n| Q8 | Ada | 2024-03-01 | pending |\n| Q6 | Chen | 2024-03-08 | open |\n| Q7 | Dana | 2024-03-09 | open |\n| Q5 | Evan | 2024-02-29 | unknown |\n";
        let result = calculate_markdown_deadline_facts(markdown, "2024-03-01");
        assert_eq!(result.status, Status::Available);
        assert_eq!(
            result.markdown_sha256,
            format!("{:x}", Sha256::digest(markdown.as_bytes()))
        );
        assert_eq!(result.as_of_date, "2024-03-01");
        assert_eq!(
            result
                .rows
                .iter()
                .map(|row| row.classification)
                .collect::<Vec<_>>(),
            [
                Class::Overdue,
                Class::Completed,
                Class::Upcoming,
                Class::Upcoming,
                Class::Later,
                Class::Unresolved
            ]
        );
        assert_eq!(result.rows[0].overdue_days, Some(2));
        assert_eq!(result.rows[0].row_line, 3);
        assert_eq!(result.rows[1].overdue_days, None);
        assert_eq!(result.rows[1].source_status, "completed");
        let changed = calculate_markdown_deadline_facts(
            &markdown.replace(
                "Q4 | Ben | 2024-02-27 | completed",
                "Q4 | Ben | 2024-02-27 | open",
            ),
            "2024-03-01",
        );
        assert_eq!(changed.rows[1].classification, Class::Overdue);
        assert_ne!(changed.markdown_sha256, result.markdown_sha256);
    }
    #[test]
    fn ambiguity_invalid_dates_and_unbounded_inputs_never_produce_a_partial_verified_list() {
        for bad in ["2024-02-30", "24-01-01", "2024-2-01", "2024-01-01Z"] {
            let result = calculate_markdown_deadline_facts(
                "| Item | Owner | Due | Status |\n|---|---|---|---|\n| A | B | 2024-01-01 | open |",
                bad,
            );
            assert_eq!(result.status, Status::Unsupported);
            assert!(result.rows.is_empty());
        }
        let invalid = "| Item | Owner | Due | Status |\n|---|---|---|---|\n| X | Ada | 2024-02-30 | open |\n| Y | Ben | 2024-02-28 | waiting approval |";
        assert!(
            calculate_markdown_deadline_facts(invalid, "2024-03-01")
                .rows
                .iter()
                .all(|row| row.classification == Class::Unresolved)
        );
        for ambiguous in [
            "| Item | Owner | Due | Status | Status |\n|---|---|---|---|---|\n| X | Ada | 2024-02-28 | open | completed |",
            "```\n| Item | Owner | Due | Status |\n|---|---|---|---|\n| X | Ada | 2024-02-28 | open |\n```",
        ] {
            let result = calculate_markdown_deadline_facts(ambiguous, "2024-03-01");
            assert!(result.rows.is_empty());
        }
        let malformed = format!(
            "{invalid}\n\n| Item | Owner | Due | Status |\n|---|---|---|---|\n| Z | extra | cells | here | extra |"
        );
        assert_eq!(
            calculate_markdown_deadline_facts(&malformed, "2024-03-01").status,
            Status::Unsupported
        );
        assert!(
            calculate_markdown_deadline_facts(&malformed, "2024-03-01")
                .rows
                .is_empty()
        );
        let long = format!(
            "| Item | Owner | Due | Status |\n|---|---|---|---|\n{}",
            "| Z | Ada | 2024-02-01 | open |\n".repeat(513)
        );
        let limited = calculate_markdown_deadline_facts(&long, "2024-03-01");
        assert_eq!(limited.status, Status::LimitExceeded);
        assert!(limited.rows.is_empty());
    }
}
