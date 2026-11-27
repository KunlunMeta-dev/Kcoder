//! Bounded JSON transforms; no model, scripts, filesystem or network.
use crate::graph_data as data;
use anyhow::{Context, Result, ensure};
use kcoder_types::workflow::{WorkflowTransformConfig, WorkflowTransformStep};
use serde_json::{Value, json};
use std::{cmp::Ordering, collections::HashSet};

pub(crate) fn execute(config: &WorkflowTransformConfig, context: &Value) -> Result<Value> {
    let mut value = context
        .pointer(&config.source_pointer)
        .cloned()
        .context("workflow_transform: source pointer missing")?;
    for step in &config.steps {
        value = match step {
            WorkflowTransformStep::Map { fields } => {
                let map = |item: &Value| -> Result<Value> {
                    let mut out = serde_json::Map::new();
                    for (name, path) in fields {
                        out.insert(
                            name.clone(),
                            item.pointer(path).cloned().with_context(|| {
                                format!("workflow_transform: missing mapping {path}")
                            })?,
                        );
                    }
                    Ok(Value::Object(out))
                };
                match &value {
                    Value::Array(items) => {
                        Value::Array(items.iter().map(map).collect::<Result<_>>()?)
                    }
                    _ => map(&value)?,
                }
            }
            WorkflowTransformStep::Filter { condition } => {
                let items = value
                    .as_array()
                    .context("workflow_transform: filter requires an array")?;
                Value::Array(
                    items
                        .iter()
                        .filter(|item| {
                            data::predicate(
                                condition,
                                &json!({"input":item,"nodes":context["nodes"]}),
                            )
                        })
                        .cloned()
                        .collect(),
                )
            }
            WorkflowTransformStep::Sort {
                pointer,
                descending,
            } => {
                let mut items = value
                    .as_array()
                    .context("workflow_transform: sort requires an array")?
                    .clone();
                let mut category = None;
                for item in &items {
                    let field = item.pointer(pointer).unwrap_or(&Value::Null);
                    if field.is_null() {
                        continue;
                    }
                    let kind = if field.is_number() {
                        0
                    } else if field.is_string() {
                        1
                    } else {
                        anyhow::bail!("workflow_transform: sort field must be a number or string")
                    };
                    ensure!(
                        category.is_none_or(|previous| previous == kind),
                        "workflow_transform: sort fields have mixed types"
                    );
                    category = Some(kind);
                }
                items.sort_by(|a, b| {
                    let a = a.pointer(pointer).unwrap_or(&Value::Null);
                    let b = b.pointer(pointer).unwrap_or(&Value::Null);
                    if a.is_null() {
                        return if b.is_null() {
                            Ordering::Equal
                        } else {
                            Ordering::Greater
                        };
                    }
                    if b.is_null() {
                        return Ordering::Less;
                    }
                    let order = match (a, b) {
                        (Value::Number(a), Value::Number(b)) => compare_numbers(a, b),
                        (Value::String(a), Value::String(b)) => a.cmp(b),
                        _ => Ordering::Equal,
                    };
                    if *descending { order.reverse() } else { order }
                });
                Value::Array(items)
            }
            WorkflowTransformStep::Deduplicate { pointer } => {
                let items = value
                    .as_array()
                    .context("workflow_transform: deduplicate requires an array")?;
                let mut seen = HashSet::new();
                let mut output = Vec::new();
                for item in items {
                    let key = match pointer {
                        Some(pointer) => item
                            .pointer(pointer)
                            .context("workflow_transform: deduplication key missing")?,
                        None => item,
                    };
                    if seen.insert(serde_json::to_string(key)?) {
                        output.push(item.clone());
                    }
                }
                Value::Array(output)
            }
            WorkflowTransformStep::Limit { count } => Value::Array(
                value
                    .as_array()
                    .context("workflow_transform: limit requires an array")?
                    .iter()
                    .take(*count)
                    .cloned()
                    .collect(),
            ),
        };
        data::bounded_value(&value, data::MAX_VALUE_BYTES)?;
    }
    Ok(value)
}
fn compare_numbers(a: &serde_json::Number, b: &serde_json::Number) -> Ordering {
    if let (Some(a), Some(b)) = (a.as_i64(), b.as_i64()) {
        return a.cmp(&b);
    }
    if let (Some(a), Some(b)) = (a.as_u64(), b.as_u64()) {
        return a.cmp(&b);
    }
    if a.as_i64().is_some_and(|n| n < 0) && b.as_u64().is_some() {
        return Ordering::Less;
    }
    if b.as_i64().is_some_and(|n| n < 0) && a.as_u64().is_some() {
        return Ordering::Greater;
    }
    a.as_f64().unwrap().total_cmp(&b.as_f64().unwrap())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transforms_filter_sort_deduplicate_limit_and_map() {
        let config:WorkflowTransformConfig=serde_json::from_value(json!({"sourcePointer":"/input","steps":[{"op":"filter","condition":{"op":"greater_than","pointer":"/input/score","value":1}},{"op":"sort","pointer":"/score","descending":true},{"op":"deduplicate","pointer":"/name"},{"op":"limit","count":1},{"op":"map","fields":{"winner":"/name"}}]})).unwrap();
        assert_eq!(execute(&config,&json!({"input":[{"name":"a","score":1},{"name":"b","score":3},{"name":"b","score":2}],"nodes":{}})).unwrap(),json!([{"winner":"b"}]));
    }
    #[test]
    fn sort_keeps_missing_values_last_and_rejects_mixed_types() {
        let config:WorkflowTransformConfig=serde_json::from_value(json!({"sourcePointer":"/input","steps":[{"op":"sort","pointer":"/n","descending":true}]})).unwrap();
        assert_eq!(
            execute(&config, &json!({"input":[{}, {"n":2}, {"n":1}]})).unwrap(),
            json!([{"n":2},{"n":1},{}])
        );
        assert!(execute(&config, &json!({"input":[{"n":1},{"n":"2"}]})).is_err());
    }
}
