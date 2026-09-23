use std::collections::HashSet;

pub(crate) fn tool_names(names: &[&str]) -> HashSet<String> {
    names.iter().map(|name| (*name).to_string()).collect()
}
