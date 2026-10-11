pub fn slugify(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn converts_ascii_title() {
        assert_eq!(slugify("  KCoder E2E Workspace  "), "kcoder-e2e-workspace");
    }
}

