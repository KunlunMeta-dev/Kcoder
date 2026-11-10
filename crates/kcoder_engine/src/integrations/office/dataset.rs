//! Deterministic bounded queries over immutable owner-bound data, without SQL or code.
use anyhow::{Context, Result, ensure};
use kcoder_types::integrations::{
    core::{IntegrationOwner, IntegrationScope},
    office::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, collections::HashSet};
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    version: u32,
    dataset: OfficeArtifactRef,
    owner_sha256: String,
    query_sha256: String,
    offset: usize,
}

pub fn dataset_page(
    data: &OfficeDataset,
    query: &OfficeDatasetQuery,
    scope: &IntegrationScope,
    cancel: &CancellationToken,
) -> Result<OfficeDatasetPage> {
    data.validate()?;
    query.validate()?;
    scope.validate()?;
    ensure!(
        IntegrationOwner::from(scope) == data.owner,
        "OFFICE_OWNER_MISMATCH"
    );
    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
    let mut normalized = query.clone();
    normalized.cursor = None;
    let query_sha256 = hash(&serde_json::to_vec(&normalized)?);
    let owner_sha256 = hash(&serde_json::to_vec(scope)?);
    let reference = OfficeArtifactRef {
        id: data.id.clone(),
        revision: data.revision,
    };
    let offset = match &query.cursor {
        None => 0,
        Some(cursor) => {
            let cursor: Cursor = serde_json::from_str(cursor).context("OFFICE_INVALID_CURSOR")?;
            ensure!(
                cursor.version == 1
                    && cursor.dataset == reference
                    && cursor.owner_sha256 == owner_sha256
                    && cursor.query_sha256 == query_sha256,
                "OFFICE_STALE_CURSOR"
            );
            cursor.offset
        }
    };
    let selected: Vec<usize> = if query.columns.is_empty() {
        (0..data.columns.len()).collect()
    } else {
        let mut seen = HashSet::new();
        query
            .columns
            .iter()
            .map(|key| {
                ensure!(seen.insert(key), "OFFICE_DUPLICATE_COLUMN");
                column(data, key)
            })
            .collect::<Result<_>>()?
    };
    let filters = query
        .filters
        .iter()
        .map(|filter| {
            let index = column(data, &filter.column)?;
            validate_filter(&data.columns[index], filter)?;
            Ok((index, filter))
        })
        .collect::<Result<Vec<_>>>()?;
    let sort = query
        .sort
        .iter()
        .map(|sort| Ok((column(data, &sort.column)?, sort.descending)))
        .collect::<Result<Vec<_>>>()?;
    let mut matched = Vec::new();
    for (index, row) in data.rows.iter().enumerate() {
        if index % 128 == 0 {
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        }
        if filters
            .iter()
            .all(|(index, filter)| matches_filter(&row[*index], filter))
        {
            matched.push(index);
        }
    }
    matched.sort_by(|left, right| {
        for (index, descending) in &sort {
            let order = compare(&data.rows[*left][*index], &data.rows[*right][*index]);
            let order = if *descending { order.reverse() } else { order };
            if order != Ordering::Equal {
                return order;
            }
        }
        left.cmp(right)
    });
    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
    ensure!(offset <= matched.len(), "OFFICE_INVALID_CURSOR");
    let aggregates = query
        .aggregates
        .iter()
        .map(|aggregate| aggregate_values(data, &matched, aggregate))
        .collect::<Result<_>>()?;
    let end = offset.saturating_add(query.limit).min(matched.len());
    let rows: Vec<Vec<Value>> = matched[offset..end]
        .iter()
        .map(|index| {
            selected
                .iter()
                .map(|column| data.rows[*index][*column].clone())
                .collect()
        })
        .collect();
    let number_text = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|value| value.as_number().map(ToString::to_string))
                .collect()
        })
        .collect();
    let next_cursor = if end < matched.len() {
        Some(serde_json::to_string(&Cursor {
            version: 1,
            dataset: reference.clone(),
            owner_sha256,
            query_sha256: query_sha256.clone(),
            offset: end,
        })?)
    } else {
        None
    };
    Ok(OfficeDatasetPage {
        dataset: reference,
        columns: selected
            .into_iter()
            .map(|index| data.columns[index].clone())
            .collect(),
        rows,
        number_text,
        total_rows: data.rows.len(),
        matched_rows: matched.len(),
        next_cursor,
        query_sha256,
        source_refs: data.source_refs.clone(),
        aggregates,
    })
}
fn column(data: &OfficeDataset, key: &str) -> Result<usize> {
    data.columns
        .iter()
        .position(|column| column.key == key)
        .context("OFFICE_UNKNOWN_COLUMN")
}
fn validate_filter(column: &OfficeColumn, filter: &OfficeFilter) -> Result<()> {
    use OfficeFilterOperator::*;
    if filter.operator == IsNull {
        ensure!(filter.value.is_null(), "OFFICE_INVALID_FILTER");
        return Ok(());
    }
    let compatible = filter.value.is_null()
        || match column.kind {
            OfficeColumnType::String | OfficeColumnType::Date => filter.value.is_string(),
            OfficeColumnType::Number => filter.value.is_number(),
            OfficeColumnType::Boolean => filter.value.is_boolean(),
        };
    ensure!(compatible, "OFFICE_FILTER_TYPE_MISMATCH");
    ensure!(
        filter.operator != Contains
            || (column.kind == OfficeColumnType::String && filter.value.is_string()),
        "OFFICE_FILTER_TYPE_MISMATCH"
    );
    ensure!(
        !matches!(filter.operator, GreaterThan | LessThan)
            || (!filter.value.is_null() && column.kind != OfficeColumnType::Boolean),
        "OFFICE_FILTER_TYPE_MISMATCH"
    );
    Ok(())
}
fn matches_filter(value: &Value, filter: &OfficeFilter) -> bool {
    use OfficeFilterOperator::*;
    match filter.operator {
        IsNull => value.is_null(),
        Eq => compare(value, &filter.value) == Ordering::Equal,
        NotEq => compare(value, &filter.value) != Ordering::Equal,
        Contains => value
            .as_str()
            .zip(filter.value.as_str())
            .is_some_and(|(value, needle)| value.contains(needle)),
        GreaterThan => !value.is_null() && compare(value, &filter.value) == Ordering::Greater,
        LessThan => !value.is_null() && compare(value, &filter.value) == Ordering::Less,
    }
}
fn compare(left: &Value, right: &Value) -> Ordering {
    match (left, right) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Null, _) => Ordering::Greater,
        (_, Value::Null) => Ordering::Less,
        (Value::String(left), Value::String(right)) => left.cmp(right),
        (Value::Bool(left), Value::Bool(right)) => left.cmp(right),
        (Value::Number(left), Value::Number(right)) => {
            decimal_compare(&left.to_string(), &right.to_string())
        }
        _ => Ordering::Equal,
    }
}
// JSON numeric values are compared as decimal text rather than rounded through f64.
fn decimal_parts(value: &str) -> (bool, String, i32) {
    let negative = value.starts_with('-');
    let unsigned = value.trim_start_matches('-');
    let (base, exponent) = unsigned
        .split_once(['e', 'E'])
        .map_or((unsigned, 0), |(base, exponent)| {
            (base, exponent.parse::<i32>().unwrap_or(0))
        });
    let point = base.find('.').unwrap_or(base.len());
    let raw = base.replace('.', "");
    let leading = raw.len() - raw.trim_start_matches('0').len();
    let digits = raw
        .trim_start_matches('0')
        .trim_end_matches('0')
        .to_string();
    if digits.is_empty() {
        return (false, "0".into(), 1);
    }
    (negative, digits, point as i32 + exponent - leading as i32)
}
fn decimal_compare(left: &str, right: &str) -> Ordering {
    let (left_negative, left, left_point) = decimal_parts(left);
    let (right_negative, right, right_point) = decimal_parts(right);
    if left_negative != right_negative {
        return if left_negative {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    if left == "0" {
        return if right == "0" {
            Ordering::Equal
        } else if right_negative {
            Ordering::Greater
        } else {
            Ordering::Less
        };
    }
    if right == "0" {
        return if left_negative {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let order = left_point.cmp(&right_point).then_with(|| {
        let length = left.len().max(right.len());
        left.bytes()
            .chain(std::iter::repeat(b'0'))
            .take(length)
            .cmp(right.bytes().chain(std::iter::repeat(b'0')).take(length))
    });
    if left_negative {
        order.reverse()
    } else {
        order
    }
}
fn aggregate_values(
    data: &OfficeDataset,
    matched: &[usize],
    aggregate: &OfficeAggregate,
) -> Result<OfficeAggregateResult> {
    let index = column(data, &aggregate.column)?;
    let values: Vec<&Value> = matched
        .iter()
        .map(|row| &data.rows[*row][index])
        .filter(|value| !value.is_null())
        .collect();
    if aggregate.function != OfficeAggregateFunction::Count {
        ensure!(
            data.columns[index].kind == OfficeColumnType::Number,
            "OFFICE_AGGREGATE_TYPE_MISMATCH"
        );
    }
    let value = match aggregate.function {
        OfficeAggregateFunction::Count => Some(values.len().to_string()),
        _ if values.is_empty() => None,
        OfficeAggregateFunction::Min => values
            .iter()
            .min_by(|left, right| compare(left, right))
            .map(|value| value.to_string()),
        OfficeAggregateFunction::Max => values
            .iter()
            .max_by(|left, right| compare(left, right))
            .map(|value| value.to_string()),
        OfficeAggregateFunction::Sum => {
            let mut coefficient: i128 = 0;
            let mut scale: u32 = 0;
            for value in &values {
                let (negative, digits, point) = decimal_parts(&value.to_string());
                let raw_scale = digits.len() as i32 - point;
                ensure!(
                    (-30..=18).contains(&raw_scale) && digits.len() <= 36,
                    "OFFICE_AGGREGATE_RANGE"
                );
                let mut number = digits.parse::<i128>().context("OFFICE_AGGREGATE_RANGE")?;
                let next_scale = raw_scale.max(0) as u32;
                if raw_scale < 0 {
                    number = number
                        .checked_mul(
                            10i128
                                .checked_pow((-raw_scale) as u32)
                                .context("OFFICE_AGGREGATE_RANGE")?,
                        )
                        .context("OFFICE_AGGREGATE_RANGE")?;
                }
                if negative {
                    number = -number;
                }
                let common = scale.max(next_scale);
                coefficient = coefficient
                    .checked_mul(10i128.pow(common - scale))
                    .and_then(|old| {
                        number
                            .checked_mul(10i128.pow(common - next_scale))
                            .and_then(|next| old.checked_add(next))
                    })
                    .context("OFFICE_AGGREGATE_RANGE")?;
                scale = common;
            }
            Some(decimal_text(coefficient, scale))
        }
    };
    Ok(OfficeAggregateResult {
        key: aggregate.key.clone(),
        value,
        non_null_count: values.len(),
    })
}
fn decimal_text(coefficient: i128, scale: u32) -> String {
    let sign = if coefficient < 0 { "-" } else { "" };
    let digits = coefficient.unsigned_abs().to_string();
    if scale == 0 {
        return format!("{sign}{digits}");
    }
    let padded = format!("{:0>width$}", digits, width = scale as usize + 1);
    let point = padded.len() - scale as usize;
    let text = format!("{sign}{}.{}", &padded[..point], &padded[point..]);
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}
pub fn export_dataset(
    data: &OfficeDataset,
    format: OfficeFileFormat,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    data.validate()?;
    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
    match format {
        OfficeFileFormat::Json => Ok(serde_json::to_vec(
            &serde_json::json!({"schemaVersion":1,"dataset":{"id":data.id,"revision":data.revision},"columns":data.columns,"rows":data.rows,"numberText":data.rows.iter().map(|row|row.iter().map(|value|value.as_number().map(ToString::to_string)).collect::<Vec<_>>()).collect::<Vec<_>>(),"sourceRefs":data.source_refs}),
        )?),
        OfficeFileFormat::Csv => {
            let mut output = String::from("\u{feff}");
            output.push_str(
                &data
                    .columns
                    .iter()
                    .map(|column| csv_cell(&column.title, true))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            output.push_str("\r\n");
            for (index, row) in data.rows.iter().enumerate() {
                if index % 128 == 0 {
                    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
                }
                output.push_str(
                    &row.iter()
                        .map(|value| match value {
                            Value::Null => String::new(),
                            Value::String(value) => csv_cell(value, true),
                            _ => csv_cell(&value.to_string(), false),
                        })
                        .collect::<Vec<_>>()
                        .join(","),
                );
                output.push_str("\r\n");
                ensure!(
                    output.len() <= OFFICE_MAX_ARTIFACT_BYTES as usize,
                    "OFFICE_OUTPUT_TOO_LARGE"
                );
            }
            Ok(output.into_bytes())
        }
        _ => anyhow::bail!("OFFICE_EXPORT_FORMAT_UNSUPPORTED"),
    }
}
fn csv_cell(value: &str, text: bool) -> String {
    let dangerous = text
        && value
            .trim_start_matches([' ', '\t', '\r', '\n'])
            .starts_with(['=', '+', '-', '@']);
    let value = if dangerous {
        format!("'{value}")
    } else {
        value.to_string()
    };
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner};
    use serde_json::json;
    fn data() -> OfficeDataset {
        OfficeDataset {
            schema_version: 1,
            id: "data".into(),
            revision: 1,
            owner: IntegrationOwner {
                account_id: "a".into(),
                target_id: "t".into(),
                workspace_id: IntegrationNullable::Null,
                organization_id: None,
            },
            task: None,
            columns: vec![
                OfficeColumn {
                    key: "name".into(),
                    title: "名称".into(),
                    kind: OfficeColumnType::String,
                    unit: None,
                },
                OfficeColumn {
                    key: "amount".into(),
                    title: "金额".into(),
                    kind: OfficeColumnType::Number,
                    unit: Some("元".into()),
                },
            ],
            rows: vec![
                vec![json!("=unsafe"), json!(0.1)],
                vec![json!("B"), json!(0.2)],
                vec![json!("C"), Value::Null],
            ],
            source_refs: vec![],
        }
    }
    fn scope() -> IntegrationScope {
        IntegrationScope {
            account_id: "a".into(),
            target_id: "t".into(),
            workspace_id: IntegrationNullable::Null,
            organization_id: None,
            identity_generation: "1".into(),
            target_revision: "1".into(),
        }
    }
    fn query() -> OfficeDatasetQuery {
        OfficeDatasetQuery {
            columns: vec![],
            filters: vec![],
            sort: vec![OfficeSort {
                column: "amount".into(),
                descending: false,
            }],
            aggregates: vec![OfficeAggregate {
                column: "amount".into(),
                function: OfficeAggregateFunction::Sum,
                key: "sum".into(),
            }],
            limit: 1,
            cursor: None,
        }
    }
    #[test]
    fn pages_keep_exact_sums_nulls_units_and_bound_cursor() {
        let data = data();
        let token = CancellationToken::new();
        let first = dataset_page(&data, &query(), &scope(), &token).unwrap();
        assert_eq!(first.aggregates[0].value.as_deref(), Some("0.3"));
        assert_eq!(first.columns[1].unit.as_deref(), Some("元"));
        assert_eq!(first.total_rows, 3);
        let mut next = query();
        next.cursor = first.next_cursor;
        let second = dataset_page(&data, &next, &scope(), &token).unwrap();
        assert_eq!(second.rows[0][1], json!(0.2));
        let mut changed = data.clone();
        changed.revision = 2;
        assert!(dataset_page(&changed, &next, &scope(), &token).is_err());
        changed = data.clone();
        changed.owner.account_id = "other".into();
        assert!(dataset_page(&changed, &next, &scope(), &token).is_err());
        next.filters.push(OfficeFilter {
            column: "name".into(),
            operator: OfficeFilterOperator::Contains,
            value: json!("B"),
        });
        assert!(dataset_page(&data, &next, &scope(), &token).is_err());
    }
    #[test]
    fn csv_preserves_numbers_and_blocks_formula_injection_without_mutating_source() {
        let data = data();
        let bytes =
            export_dataset(&data, OfficeFileFormat::Csv, &CancellationToken::new()).unwrap();
        let csv = String::from_utf8(bytes).unwrap();
        assert!(csv.contains("\"'=unsafe\""));
        assert!(csv.contains("\"0.1\""));
        assert_eq!(data.rows[0][0], json!("=unsafe"));
        let token = CancellationToken::new();
        token.cancel();
        assert!(dataset_page(&data, &query(), &scope(), &token).is_err());
    }
    #[test]
    fn numeric_order_does_not_round_large_integer_identity() {
        assert_eq!(decimal_compare("0", "0.1"), Ordering::Less);
        assert_eq!(decimal_compare("0", "-0.1"), Ordering::Greater);
        assert_eq!(
            decimal_compare("9007199254740992", "9007199254740993"),
            Ordering::Less
        );
        assert_eq!(decimal_compare("-0.2", "-0.10"), Ordering::Less);
        assert_eq!(decimal_compare("1e-12", "0.000000000001"), Ordering::Equal);
    }
}
