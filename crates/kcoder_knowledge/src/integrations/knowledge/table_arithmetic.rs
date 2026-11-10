//! Bounded, exact arithmetic over literal Markdown table cells.
use kcoder_types::integrations::knowledge::{
    KnowledgeTableArithmetic, KnowledgeTableArithmeticStatus, KnowledgeTableNumericFact,
    KnowledgeTableNumericGroup,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_BYTES: usize = 512 * 1024;
const MAX_ROWS: usize = 512;
const MAX_COLUMNS: usize = 32;
const MAX_FACT_BYTES: usize = 4096;

mod deadlines;
pub use deadlines::calculate_markdown_deadline_facts;

#[derive(Clone, Copy)]
struct Decimal {
    value: i128,
    scale: u32,
}
impl Decimal {
    fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let unsigned = text
            .strip_prefix('-')
            .or_else(|| text.strip_prefix('+'))
            .unwrap_or(text);
        let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
        if whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
            || fraction.len() > 18
            || (unsigned.contains('.') && fraction.is_empty())
        {
            return None;
        }
        let digits = format!(
            "{}{whole}{fraction}",
            if text.starts_with('-') { "-" } else { "" }
        );
        Some(Self {
            value: digits.parse().ok()?,
            scale: fraction.len().try_into().ok()?,
        })
    }
    fn add(self, other: Self) -> Option<Self> {
        let scale = self.scale.max(other.scale);
        let a = self
            .value
            .checked_mul(10i128.checked_pow(scale - self.scale)?)?;
        let b = other
            .value
            .checked_mul(10i128.checked_pow(scale - other.scale)?)?;
        Some(Self {
            value: a.checked_add(b)?,
            scale,
        })
    }
    fn text(self) -> String {
        if self.scale == 0 {
            return self.value.to_string();
        }
        let mut digits = format!(
            "{:0width$}",
            self.value.unsigned_abs(),
            width = self.scale as usize + 1
        );
        digits.insert(digits.len() - self.scale as usize, '.');
        while digits.ends_with('0') {
            digits.pop();
        }
        if digits.ends_with('.') {
            digits.pop();
        }
        if self.value < 0 {
            digits.insert(0, '-');
        }
        digits
    }
}

struct Table {
    line: u32,
    headers: Vec<String>,
    rows: Vec<(u32, Vec<String>)>,
}

fn cells(line: &str) -> Option<Vec<String>> {
    if !line.contains('|') || line.contains(['\\', '`']) {
        return None;
    }
    let mut line = line.trim();
    if let Some(value) = line.strip_prefix('|') {
        line = value;
    }
    if let Some(value) = line.strip_suffix('|') {
        line = value;
    }
    Some(line.split('|').map(|cell| cell.trim().to_owned()).collect())
}
fn separator(row: &[String]) -> bool {
    row.iter().all(|cell| {
        let value = cell.trim_matches(':');
        value.len() >= 3 && value.bytes().all(|byte| byte == b'-')
    })
}
fn tables(markdown: &str) -> Result<Vec<Table>, KnowledgeTableArithmeticStatus> {
    if markdown.len() > MAX_BYTES {
        return Err(KnowledgeTableArithmeticStatus::LimitExceeded);
    }
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut index = 0;
    let mut row_count = 0;
    let mut fence = None;
    while index < lines.len() {
        let line = lines[index].trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            let marker = line.as_bytes()[0];
            let length = line.bytes().take_while(|byte| *byte == marker).count();
            if let Some((kind, opened)) = fence {
                if kind == marker && length >= opened && line[length..].trim().is_empty() {
                    fence = None;
                }
            } else {
                fence = Some((marker, length));
            }
            index += 1;
            continue;
        }
        if fence.is_some()
            || index + 1 == lines.len()
            || lines[index].starts_with("    ")
            || lines[index].starts_with('\t')
        {
            index += 1;
            continue;
        }
        let Some(delimiter) = cells(lines[index + 1]).filter(|row| separator(row)) else {
            index += 1;
            continue;
        };
        if lines[index + 1].starts_with("    ") || lines[index + 1].starts_with('\t') {
            index += 1;
            continue;
        }
        let Some(headers) = cells(lines[index]) else {
            return Err(KnowledgeTableArithmeticStatus::Unsupported);
        };
        if headers.len() < 2
            || headers.len() != delimiter.len()
            || headers.iter().any(String::is_empty)
            || headers.iter().collect::<BTreeSet<_>>().len() != headers.len()
        {
            return Err(KnowledgeTableArithmeticStatus::Unsupported);
        }
        if headers.len() > MAX_COLUMNS || result.len() == 16 {
            return Err(KnowledgeTableArithmeticStatus::LimitExceeded);
        }
        let mut table = Table {
            line: (index + 1) as u32,
            headers,
            rows: Vec::new(),
        };
        index += 2;
        while index < lines.len() && lines[index].contains('|') && !lines[index].trim().is_empty() {
            let Some(row) = cells(lines[index]) else {
                return Err(KnowledgeTableArithmeticStatus::Unsupported);
            };
            if row.len() != table.headers.len() {
                return Err(KnowledgeTableArithmeticStatus::Unsupported);
            }
            row_count += 1;
            if row_count > MAX_ROWS {
                return Err(KnowledgeTableArithmeticStatus::LimitExceeded);
            }
            table.rows.push(((index + 1) as u32, row));
            index += 1;
        }
        result.push(table);
    }
    Ok(result)
}

fn unit_column(table: &Table, column: usize) -> bool {
    let header = table.headers[column].to_lowercase();
    matches!(
        header.as_str(),
        "currency" | "unit" | "units" | "币种" | "货币" | "单位" | "计量单位"
    ) || table.rows.iter().all(|(_, row)| {
        row[column].len() == 3 && row[column].bytes().all(|byte| byte.is_ascii_uppercase())
    })
}
#[derive(Default)]
struct Group {
    rows: Vec<u32>,
    missing: Vec<u32>,
    numeric: u32,
    sum: Option<Decimal>,
    overflow: bool,
}
fn table_facts(
    table: &Table,
) -> Result<Vec<KnowledgeTableNumericFact>, KnowledgeTableArithmeticStatus> {
    if table.rows.is_empty() {
        return Ok(Vec::new());
    }
    let numeric = (0..table.headers.len())
        .filter(|column| {
            table
                .rows
                .iter()
                .any(|(_, row)| Decimal::parse(&row[*column]).is_some())
        })
        .collect::<Vec<_>>();
    let text_columns = (0..table.headers.len())
        .filter(|column| !numeric.contains(column))
        .collect::<Vec<_>>();
    let units = text_columns
        .iter()
        .copied()
        .filter(|column| unit_column(table, *column))
        .collect::<Vec<_>>();
    let categories = text_columns
        .iter()
        .copied()
        .filter(|column| {
            !units.contains(column)
                && table
                    .rows
                    .iter()
                    .map(|(_, row)| &row[*column])
                    .collect::<BTreeSet<_>>()
                    .len()
                    < table.rows.len()
        })
        .collect::<Vec<_>>();
    let mut partitions = categories
        .into_iter()
        .map(|column| {
            let mut keys = vec![column];
            keys.extend(units.iter().copied());
            keys.sort_unstable();
            keys
        })
        .collect::<Vec<_>>();
    // Currency/unit partitions always remain explicit; no total mixes units.
    if !units.is_empty() || partitions.is_empty() {
        partitions.push(units);
    }
    let mut facts = Vec::new();
    for value_column in numeric {
        for partition in &partitions {
            let mut groups: BTreeMap<Vec<String>, Group> = BTreeMap::new();
            for (line, row) in &table.rows {
                let key: Vec<String> = partition
                    .iter()
                    .map(|column| row[*column].clone())
                    .collect();
                if !groups.contains_key(&key) && groups.len() == 64 {
                    return Err(KnowledgeTableArithmeticStatus::LimitExceeded);
                }
                let group = groups.entry(key).or_default();
                group.rows.push(*line);
                if let Some(value) = Decimal::parse(&row[value_column]) {
                    group.numeric += 1;
                    if !group.overflow {
                        let next = group.sum.map_or(Some(value), |sum| sum.add(value));
                        group.overflow = next.is_none();
                        group.sum = next;
                    }
                } else {
                    group.missing.push(*line);
                }
            }
            facts.push(KnowledgeTableNumericFact {
                table_start_line: table.line,
                value_column: table.headers[value_column].clone(),
                group_by: partition
                    .iter()
                    .map(|column| table.headers[*column].clone())
                    .collect(),
                groups: groups
                    .into_iter()
                    .map(|(key, group)| KnowledgeTableNumericGroup {
                        key,
                        row_lines: group.rows,
                        numeric_rows: group.numeric,
                        known_sum: group.sum.map(Decimal::text),
                        complete: group.missing.is_empty() && !group.overflow && group.numeric > 0,
                        missing_row_lines: group.missing,
                    })
                    .collect(),
            });
        }
    }
    Ok(facts)
}

/// This pure projection neither reads a source nor authorizes access to one.
pub fn calculate_markdown_table_facts(markdown: &str) -> KnowledgeTableArithmetic {
    let mut result = KnowledgeTableArithmetic {
        status: KnowledgeTableArithmeticStatus::NotApplicable,
        markdown_sha256: format!("{:x}", Sha256::digest(markdown.as_bytes())),
        facts: Vec::new(),
    };
    let calculation = (|| {
        for table in tables(markdown)? {
            result.facts.extend(table_facts(&table)?);
            if serde_json::to_vec(&result.facts)
                .map_err(|_| KnowledgeTableArithmeticStatus::Unsupported)?
                .len()
                > MAX_FACT_BYTES
            {
                return Err(KnowledgeTableArithmeticStatus::LimitExceeded);
            }
        }
        Ok(())
    })();
    if let Err(status) = calculation {
        result.status = status;
        result.facts.clear();
    } else if !result.facts.is_empty() {
        result.status = KnowledgeTableArithmeticStatus::Available;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_status_groups_do_not_mix_completed_and_pending_rows() {
        let source = "| Item | Status | Units |\n|---|---|---:|\n| A | done | 7 |\n| B | done | 4 |\n| C | pending | 3 |\n";
        let result = calculate_markdown_table_facts(source);
        assert_eq!(result.status, KnowledgeTableArithmeticStatus::Available);
        let fact = result
            .facts
            .iter()
            .find(|fact| fact.value_column == "Units" && fact.group_by == ["Status"])
            .unwrap();
        let done = fact
            .groups
            .iter()
            .find(|group| group.key == ["done"])
            .unwrap();
        assert_eq!(done.known_sum.as_deref(), Some("11"));
        assert_eq!(done.row_lines, [3, 4]);
        assert!(done.complete);
        let pending = fact
            .groups
            .iter()
            .find(|group| group.key == ["pending"])
            .unwrap();
        assert_eq!(pending.known_sum.as_deref(), Some("3"));
        assert_eq!(source.lines().count(), 5);
    }

    #[test]
    fn decimal_sums_partition_currencies_and_leave_missing_cells_unresolved() {
        let source = "| Row | Category | Amount | Currency |\n|---|---|---:|---|\n| A | open | 1.20 | CNY |\n| B | open | 0.10 | CNY |\n| C | open | missing | CNY |\n| D | open | 2.5 | USD |\n";
        let result = calculate_markdown_table_facts(source);
        assert_eq!(result.status, KnowledgeTableArithmeticStatus::Available);
        for fact in &result.facts {
            assert!(fact.group_by.contains(&"Currency".to_string()));
        }
        let fact = result
            .facts
            .iter()
            .find(|fact| fact.group_by == ["Currency"])
            .unwrap();
        let cny = fact
            .groups
            .iter()
            .find(|group| group.key == ["CNY"])
            .unwrap();
        assert_eq!(cny.known_sum.as_deref(), Some("1.3"));
        assert_eq!(cny.missing_row_lines, [5]);
        assert!(!cny.complete);
        let usd = fact
            .groups
            .iter()
            .find(|group| group.key == ["USD"])
            .unwrap();
        assert_eq!(usd.known_sum.as_deref(), Some("2.5"));
        assert!(usd.complete);
    }

    #[test]
    fn invalid_table_or_excessive_rows_never_publish_a_partial_arithmetic_subset() {
        let invalid = "| Item | Value |\n|---|---:|\n| A | 2 |\n\n| Item | Value |\n|---|---:|\n| B | 3 | extra |\n";
        let result = calculate_markdown_table_facts(invalid);
        assert_eq!(result.status, KnowledgeTableArithmeticStatus::Unsupported);
        assert!(result.facts.is_empty());
        let long = format!(
            "| Item | Value |\n|---|---:|\n{}",
            "| A | 1 |\n".repeat(MAX_ROWS + 1)
        );
        let result = calculate_markdown_table_facts(&long);
        assert_eq!(result.status, KnowledgeTableArithmeticStatus::LimitExceeded);
        assert!(result.facts.is_empty());
    }

    #[test]
    fn fenced_text_and_ambiguous_numeric_formats_do_not_become_verified_totals() {
        assert_eq!(
            calculate_markdown_table_facts("```md\n| X | Y |\n|---|---|\n| a | 10 |\n```\n").status,
            KnowledgeTableArithmeticStatus::NotApplicable
        );
        assert_eq!(
            calculate_markdown_table_facts("````md\n```\n| X | Y |\n|---|---|\n| a | 10 |\n````\n")
                .status,
            KnowledgeTableArithmeticStatus::NotApplicable
        );
        assert_eq!(
            calculate_markdown_table_facts("    | X | Y |\n    |---|---|\n    | a | 10 |\n").status,
            KnowledgeTableArithmeticStatus::NotApplicable
        );
        for literal in ["1,000", "$12", "1e3", "NaN", "Infinity", "", "1.2.3"] {
            assert!(Decimal::parse(literal).is_none(), "{literal}");
        }
        assert_eq!(
            Decimal::parse("-0.2")
                .unwrap()
                .add(Decimal::parse("0.3").unwrap())
                .unwrap()
                .text(),
            "0.1"
        );
        let overflow = format!(
            "| Item | Value |\n|---|---:|\n| A | {} |\n| A | 1 |\n",
            i128::MAX
        );
        let result = calculate_markdown_table_facts(&overflow);
        assert!(
            result
                .facts
                .iter()
                .flat_map(|fact| &fact.groups)
                .all(|group| !group.complete && group.known_sum.is_none())
        );
    }
}
