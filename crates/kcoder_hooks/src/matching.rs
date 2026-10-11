use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

struct CachedRegex {
    regex: Option<Regex>,
}

static REGEX_CACHE: OnceLock<RwLock<HashMap<String, CachedRegex>>> = OnceLock::new();

fn cached_regex_matches(pattern: &str, query: &str) -> bool {
    let cache = REGEX_CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    {
        let cache = cache.read().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get(pattern) {
            return entry
                .regex
                .as_ref()
                .is_some_and(|regex| regex.is_match(query));
        }
    }

    let mut cache = cache.write().unwrap_or_else(|e| e.into_inner());
    let entry = cache
        .entry(pattern.to_string())
        .or_insert_with(|| CachedRegex {
            regex: Regex::new(pattern).ok(),
        });
    entry
        .regex
        .as_ref()
        .is_some_and(|regex| regex.is_match(query))
}

#[cfg(test)]
fn regex_compile_count(pattern: &str) -> usize {
    let pattern = pattern.strip_prefix('^').unwrap_or(pattern);
    REGEX_CACHE
        .get()
        .and_then(|cache| {
            cache
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .get(pattern)
                .map(|_| 1)
        })
        .unwrap_or(0)
}

/// Match a query string against a hook matcher pattern.
///
/// Supported syntax:
/// - `""` or `"*"` matches everything.
/// - `"A|B|C"` matches any of the pipe-separated exact values.
/// - `"^..."` is treated as a regex.
/// - Otherwise the pattern is an exact match.
pub fn matches_pattern(query: &str, pattern: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern == "*" {
        return true;
    }
    if let Some(regex_pat) = pattern.strip_prefix('^') {
        return cached_regex_matches(regex_pat, query);
    }
    for part in pattern.split('|') {
        if part.trim() == query {
            return true;
        }
    }
    false
}

/// Evaluate an `if` rule for a tool event.
///
/// The rule uses permission-style syntax: `ToolName` or `ToolName(content)`.
/// Returns `true` if the rule matches the given tool name and input.
pub fn matches_if_rule(tool_name: &str, input: &Value, if_rule: &str) -> bool {
    let rule = if_rule.trim();
    if rule.is_empty() || rule == "*" {
        return true;
    }

    let (rule_name, rule_content) = if let Some((name, rest)) = rule.split_once('(') {
        let content = rest.strip_suffix(')').unwrap_or(rest).trim();
        (name.trim(), Some(content))
    } else {
        (rule, None)
    };

    if !rule_name.eq_ignore_ascii_case(tool_name) {
        return false;
    }

    if let Some(content) = rule_content {
        let input_text = input.to_string();
        return if let Some(prefix) = content.strip_suffix('*') {
            input_text.contains(prefix)
        } else {
            input_text.contains(content)
        };
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_or_star_matches_all() {
        assert!(matches_pattern("bash", ""));
        assert!(matches_pattern("bash", "*"));
    }

    #[test]
    fn exact_match() {
        assert!(matches_pattern("bash", "bash"));
        assert!(!matches_pattern("bash", "write"));
    }

    #[test]
    fn pipe_separated_matches() {
        assert!(matches_pattern("write", "write|edit"));
        assert!(matches_pattern("edit", "write|edit"));
        assert!(!matches_pattern("bash", "write|edit"));
    }

    #[test]
    fn regex_match() {
        assert!(matches_pattern("bash", "^ba.*"));
        assert!(!matches_pattern("write", "^ba.*"));
    }

    #[test]
    fn regex_patterns_are_compiled_once() {
        let pattern = format!("^cached-pattern-{}$", std::process::id());
        assert!(matches_pattern(
            &format!("cached-pattern-{}", std::process::id()),
            &pattern
        ));
        assert!(!matches_pattern("different", &pattern));
        assert_eq!(regex_compile_count(&pattern), 1);
    }

    #[test]
    fn if_rule_tool_name_only() {
        assert!(matches_if_rule("bash", &json!({}), "bash"));
        assert!(!matches_if_rule("write", &json!({}), "bash"));
    }

    #[test]
    fn if_rule_with_content() {
        let input = json!({"command": "git push origin main"});
        assert!(matches_if_rule("bash", &input, "Bash(git push*)"));
        assert!(matches_if_rule("bash", &input, "bash(git push)"));
        assert!(!matches_if_rule("bash", &input, "bash(git status)"));
    }
}
