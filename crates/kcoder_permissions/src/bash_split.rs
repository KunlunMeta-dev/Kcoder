//! tree-sitter based bash compound-command splitting for permission rules.
//!
//! Permission rules for shell tools are evaluated per constituent command:
//! a compound command (`a && b | c ; d`) is decomposed into its leaf simple
//! commands via the tree-sitter bash grammar, so an allow rule must cover
//! every constituent while a deny rule fires on any one of them.

/// Split `command` into its constituent simple commands (leaf `command`
/// nodes of the bash AST), covering `&&`, `||`, `;`, `|`, if/while/for
/// bodies, subshells, and command substitutions. Falls back to the raw
/// string when parsing fails so callers never lose coverage.
pub fn split_bash_command(command: &str) -> Vec<String> {
    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .is_err()
    {
        return vec![command.trim().to_string()];
    }
    let Some(tree) = parser.parse(command, None) else {
        return vec![command.trim().to_string()];
    };
    let mut out = Vec::new();
    collect_commands(tree.root_node(), command.as_bytes(), &mut out);
    if out.is_empty() {
        out.push(command.trim().to_string());
    }
    out
}

fn collect_commands(node: tree_sitter::Node, source: &[u8], out: &mut Vec<String>) {
    if node.kind() == "command" {
        let text = node.utf8_text(source).unwrap_or("").trim();
        if !text.is_empty() {
            out.push(text.to_string());
        }
        // Keep descending: arguments may embed command substitutions.
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_commands(child, source, out);
    }
}

/// Glob match supporting `*` (any, possibly empty, substring). Patterns
/// without `*` must equal the text exactly.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == text;
    }
    let mut parts = pattern.split('*');
    let head = parts.next().unwrap_or_default();
    let tail = parts.next_back().unwrap_or_default();
    let Some(rest) = text.strip_prefix(head) else {
        return false;
    };
    // Reserve the anchored suffix first so an earlier identical literal cannot hide the terminal match, while also forbidding prefix/suffix overlap.
    let Some(mut rest) = rest.strip_suffix(tail) else {
        return false;
    };
    for part in parts {
        if part.is_empty() {
            continue;
        }
        let Some(index) = rest.find(part) else {
            return false;
        };
        rest = &rest[index + part.len()..];
    }
    true
}

/// Rule evaluation for shell commands. `require_all` is the allow case
/// (every constituent must glob-match); otherwise any single constituent
/// that glob-matches — or, for wildcard-free patterns, contains the pattern
/// (legacy substring semantics) — suffices (the deny case).
pub fn bash_command_matches(pattern: &str, command: &str, require_all: bool) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return true;
    }
    let parts = split_bash_command(command);
    if require_all {
        !parts.is_empty() && parts.iter().all(|part| glob_match(pattern, part))
    } else if pattern.contains('*') {
        parts.iter().any(|part| glob_match(pattern, part))
    } else {
        parts.iter().any(|part| part.contains(pattern))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_operators_pipelines_and_conditionals() {
        assert_eq!(
            split_bash_command("cargo test && cargo fmt | tail -1 ; echo done"),
            vec!["cargo test", "cargo fmt", "tail -1", "echo done"]
        );
        let parts = split_bash_command("if [ -f x ]; then rm -rf /tmp/x; else echo missing; fi");
        assert!(parts.iter().any(|p| p == "rm -rf /tmp/x"), "{parts:?}");
        assert!(parts.iter().any(|p| p == "echo missing"), "{parts:?}");
    }

    #[test]
    fn splits_subshells_and_command_substitutions() {
        let parts = split_bash_command("echo $(rm -rf /tmp/evil) && (cd /tmp && make)");
        assert!(parts.iter().any(|p| p == "rm -rf /tmp/evil"), "{parts:?}");
        assert!(parts.iter().any(|p| p == "make"), "{parts:?}");
    }

    #[test]
    fn glob_anchor_semantics() {
        assert!(glob_match("cargo test", "cargo test"));
        assert!(!glob_match("cargo test", "cargo test --release"));
        assert!(glob_match("cargo *", "cargo test --release"));
        assert!(glob_match("*test*", "cargo test x"));
        assert!(glob_match("git push *", "git push origin main"));
        assert!(!glob_match("git push *", "xgit push origin"));
        assert!(glob_match("rm -rf *", "rm -rf /tmp/x"));
        assert!(glob_match("*", "anything at all"));
    }

    #[test]
    fn glob_repeated_suffix_unicode_and_overlap() {
        for (pattern, text, expected) in [
            ("*test", "test foo test", true),
            ("*测试", "测试 再次测试", true),
            ("a**b*c", "abbcc", true),
            ("*ab*ab", "abab", true),
            ("*aba*aba", "ababa", false),
            ("aba*aba", "aba", false),
            ("**", "", true),
            ("", "", true),
            ("", "x", false),
            ("*test", "test tail", false),
        ] {
            assert_eq!(
                glob_match(pattern, text),
                expected,
                "{pattern:?} / {text:?}"
            );
        }
    }

    #[test]
    fn allow_requires_every_constituent_to_match() {
        assert!(bash_command_matches(
            "cargo *",
            "cargo test && cargo fmt",
            true
        ));
        assert!(!bash_command_matches(
            "cargo test",
            "cargo test && cargo fmt",
            true
        ));
        assert!(!bash_command_matches(
            "cargo *",
            "cargo test && rm -rf /tmp/x",
            true
        ));
    }

    #[test]
    fn deny_fires_on_any_constituent() {
        assert!(bash_command_matches(
            "rm -rf *",
            "ls && rm -rf /tmp/x",
            false
        ));
        assert!(!bash_command_matches("rm -rf *", "ls && echo hi", false));
        assert!(bash_command_matches(
            "sudo *",
            "echo hi && sudo rm x",
            false
        ));
    }
}
