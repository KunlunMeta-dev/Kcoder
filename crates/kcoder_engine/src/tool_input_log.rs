use serde_json::Value;

pub(super) fn tool_input_log_summary(input: &Value) -> String {
    summarize_json_for_log(input, 0)
}

fn summarize_json_for_log(value: &Value, depth: usize) -> String {
    const MAX_FIELDS: usize = 12;
    const MAX_DEPTH: usize = 4;

    match value {
        Value::Null => "null".to_string(),
        Value::Bool(_) => "bool".to_string(),
        Value::Number(_) => "number".to_string(),
        Value::String(text) => format!("string:{}c", text.chars().count()),
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                return format!("array:{} items", items.len());
            }
            let preview = items
                .iter()
                .take(3)
                .map(|item| summarize_json_for_log(item, depth + 1))
                .collect::<Vec<_>>()
                .join(", ");
            if items.len() > 3 {
                format!("array:{} items [{} ...]", items.len(), preview)
            } else {
                format!("array:{} items [{}]", items.len(), preview)
            }
        }
        Value::Object(map) => {
            if depth >= MAX_DEPTH {
                return format!("object:{} fields", map.len());
            }
            let mut fields = Vec::new();
            for (idx, (key, value)) in map.iter().enumerate() {
                if idx >= MAX_FIELDS {
                    fields.push(format!("...{} more", map.len() - MAX_FIELDS));
                    break;
                }
                if is_sensitive_log_key(key) {
                    fields.push(format!("{key}:redacted"));
                } else {
                    fields.push(format!(
                        "{key}:{}",
                        summarize_json_for_log(value, depth + 1)
                    ));
                }
            }
            format!("object:{} fields {{{}}}", map.len(), fields.join(", "))
        }
    }
}

fn is_sensitive_log_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    normalized == "authorization"
        || normalized == "secret"
        || normalized == "token"
        || normalized == "password"
        || normalized == "auth_token"
        || normalized == "api_key"
        || normalized.ends_with("_api_key")
        || normalized.ends_with("_token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_password")
        || normalized.contains("access_token")
        || normalized.contains("refresh_token")
}
