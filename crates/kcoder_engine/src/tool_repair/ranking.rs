use super::{MAX_ARRAY_ITEMS, MAX_OBJECT_FIELDS, ToolRepairExample, ToolRepairIndex};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;

impl ToolRepairIndex {
    pub(crate) fn best_matches(
        &self,
        tool_name: &str,
        schema_fingerprint: &str,
        current_input: &Value,
        error_summary: &str,
        limit: usize,
    ) -> Vec<&ToolRepairExample> {
        if limit == 0 {
            return Vec::new();
        }
        let candidates = self
            .examples
            .iter()
            .filter(|example| {
                example.tool_name == tool_name && example.schema_fingerprint == schema_fingerprint
            })
            .filter(|example| repair_errors_are_related(error_summary, &example.error_summary))
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Vec::new();
        }

        let query_terms = query_terms(tool_name, current_input, error_summary);
        if query_terms.is_empty() {
            return Vec::new();
        }

        let documents = candidates
            .iter()
            .map(|example| document_terms(example))
            .collect::<Vec<_>>();
        let avg_len = documents
            .iter()
            .map(|terms| terms.len() as f64)
            .sum::<f64>()
            / documents.len().max(1) as f64;
        let mut document_frequency: HashMap<&str, usize> = HashMap::new();
        for terms in &documents {
            let unique = terms.iter().map(String::as_str).collect::<HashSet<_>>();
            for term in unique {
                *document_frequency.entry(term).or_default() += 1;
            }
        }

        let query_unique = query_terms
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let n = documents.len() as f64;
        let mut scored = Vec::new();
        for (index, terms) in documents.iter().enumerate() {
            let mut term_frequency: HashMap<&str, usize> = HashMap::new();
            for term in terms {
                *term_frequency.entry(term.as_str()).or_default() += 1;
            }
            let doc_len = terms.len().max(1) as f64;
            let mut score = 0.0;
            for term in &query_unique {
                let Some(&tf_raw) = term_frequency.get(term) else {
                    continue;
                };
                let df = *document_frequency.get(term).unwrap_or(&0) as f64;
                let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                let tf = tf_raw as f64;
                let denom = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * doc_len / avg_len.max(1.0));
                score += idf * (tf * (BM25_K1 + 1.0)) / denom;
            }
            if score > 0.0 {
                scored.push((index, score));
            }
        }

        scored.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.cmp(&right.0))
        });
        scored
            .into_iter()
            .take(limit)
            .map(|(index, _)| candidates[index])
            .collect()
    }
}

fn query_terms(tool_name: &str, input: &Value, error_summary: &str) -> Vec<String> {
    let mut terms = tokenize(tool_name);
    terms.extend(tokenize(error_summary));
    collect_json_terms(input, &mut terms);
    terms
}

fn document_terms(example: &ToolRepairExample) -> Vec<String> {
    let mut terms = tokenize(&example.tool_name);
    terms.extend(tokenize(&example.failure_signature));
    terms.extend(tokenize(&example.error_summary));
    collect_json_terms(&example.failed_input, &mut terms);
    collect_json_terms(&example.successful_input, &mut terms);
    terms
}

fn repair_errors_are_related(current_error: &str, example_error: &str) -> bool {
    let current_terms = meaningful_error_terms(current_error);
    let example_terms = meaningful_error_terms(example_error);
    if current_terms.is_empty() || example_terms.is_empty() {
        return true;
    }
    current_terms
        .iter()
        .any(|term| example_terms.contains(term.as_str()))
}

fn meaningful_error_terms(text: &str) -> HashSet<String> {
    tokenize(text)
        .into_iter()
        .filter(|term| !is_generic_error_token(term))
        .collect()
}

fn is_generic_error_token(token: &str) -> bool {
    matches!(
        token,
        "array"
            | "boolean"
            | "detail"
            | "details"
            | "error"
            | "expected"
            | "failed"
            | "field"
            | "got"
            | "input"
            | "integer"
            | "invalid"
            | "json"
            | "missing"
            | "null"
            | "number"
            | "object"
            | "one"
            | "present"
            | "received"
            | "required"
            | "schema"
            | "send"
            | "string"
            | "tool"
            | "type"
            | "value"
            | "values"
    )
}

fn collect_json_terms(value: &Value, terms: &mut Vec<String>) {
    match value {
        Value::Null => terms.push("null".to_string()),
        Value::Bool(_) => terms.push("bool".to_string()),
        Value::Number(_) => terms.push("number".to_string()),
        Value::String(text) => {
            terms.push("string".to_string());
            terms.extend(tokenize(text));
        }
        Value::Array(values) => {
            terms.push("array".to_string());
            for value in values.iter().take(MAX_ARRAY_ITEMS) {
                collect_json_terms(value, terms);
            }
        }
        Value::Object(map) => {
            terms.push("object".to_string());
            for (key, value) in map.iter().take(MAX_OBJECT_FIELDS) {
                terms.extend(tokenize(key));
                collect_json_terms(value, terms);
            }
        }
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .filter_map(|token| {
            let token = token.trim().to_ascii_lowercase();
            (token.len() >= 2 && !is_stopword(&token)).then_some(token)
        })
        .collect()
}

fn is_stopword(token: &str) -> bool {
    matches!(
        token,
        "the"
            | "and"
            | "for"
            | "with"
            | "this"
            | "that"
            | "was"
            | "were"
            | "from"
            | "into"
            | "use"
            | "json"
            | "tool"
            | "input"
            | "failed"
            | "failure"
    )
}
