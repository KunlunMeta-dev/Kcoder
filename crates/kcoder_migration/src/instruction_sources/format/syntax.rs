//! Recognize a conservative static Claude import subset outside Markdown code and block comments.
use anyhow::{Result, ensure};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use std::ops::Range;

const MAX_EVENTS: usize = 65_536;
const MAX_EDITS: usize = 4096;

pub(super) enum Edit {
    Import { range: Range<usize>, path: String },
    Comment(Range<usize>),
}
impl Edit {
    pub(super) fn range(&self) -> &Range<usize> {
        match self {
            Self::Import { range, .. } | Self::Comment(range) => range,
        }
    }
}

/// A path is only a proposed static dependency. The Native pinned-root reader must authorize it.
pub(super) fn edits(text: &str) -> Result<Vec<Edit>> {
    let mut edits = Vec::new();
    let mut code = false;
    let mut html = false;
    let mut events = 0;
    let mut text_ranges = Vec::<Range<usize>>::new();
    for (event, range) in Parser::new(text).into_offset_iter() {
        events += 1;
        ensure!(
            events <= MAX_EVENTS,
            "migration_instruction_source_budget_exceeded"
        );
        match event {
            Event::Start(Tag::CodeBlock(_)) => code = true,
            Event::End(TagEnd::CodeBlock) => code = false,
            Event::Start(Tag::HtmlBlock) => {
                html = true;
                let value = &text[range.clone()];
                if comments_only(value) {
                    edits.push(Edit::Comment(range));
                } else {
                    ensure!(
                        !value.contains('@') && !value.trim_start().starts_with("<!--"),
                        "migration_instruction_import_semantics_require_review"
                    );
                }
            }
            Event::End(TagEnd::HtmlBlock) => html = false,
            Event::Text(_) if !code && !html => {
                if let Some(last) = text_ranges.last_mut()
                    && last.end == range.start
                {
                    last.end = range.end;
                } else {
                    text_ranges.push(range);
                }
            }
            Event::InlineHtml(value) if value.contains('@') => {
                anyhow::bail!("migration_instruction_import_semantics_require_review")
            }
            _ => {}
        }
        ensure!(
            edits.len() <= MAX_EDITS,
            "migration_instruction_source_budget_exceeded"
        );
    }
    for range in text_ranges {
        imports(text, range, &mut edits)?;
    }
    edits.sort_by_key(|edit| edit.range().start);
    ensure!(
        edits
            .windows(2)
            .all(|pair| pair[0].range().end <= pair[1].range().start),
        "migration_instruction_import_semantics_require_review"
    );
    Ok(edits)
}

fn comments_only(mut text: &str) -> bool {
    loop {
        text = text.trim();
        if text.is_empty() {
            return true;
        }
        let Some(comment) = text.strip_prefix("<!--") else {
            return false;
        };
        let Some(end) = comment.find("-->") else {
            return false;
        };
        text = &comment[end + 3..];
    }
}

fn imports(text: &str, range: Range<usize>, edits: &mut Vec<Edit>) -> Result<()> {
    let raw = &text[range.clone()];
    let mut position = 0;
    while let Some(found) = raw[position..].find('@') {
        let at = position + found;
        let before = text[..range.start + at].chars().next_back();
        let after = raw[at + 1..].chars().next();
        // Quoted paths are not imports. Other ambiguous adjacent punctuation stays reviewable.
        if matches!(before, Some('"' | '\'')) || matches!(after, Some('"' | '\'')) {
            let (quote, start) = if let Some(quote @ ('"' | '\'')) = before {
                (quote, at + 1)
            } else {
                (after.expect("quoted path"), at + 2)
            };
            let end = raw[start..].find(quote).ok_or_else(|| {
                anyhow::anyhow!("migration_instruction_import_semantics_require_review")
            })?;
            position = start + end + quote.len_utf8();
            continue;
        }
        ensure!(
            before.is_none_or(|value| value.is_whitespace()),
            "migration_instruction_import_semantics_require_review"
        );
        let mut end = at + 1;
        let mut path = String::new();
        let mut chars = raw[end..].char_indices().peekable();
        while let Some((offset, ch)) = chars.next() {
            let absolute = at + 1 + offset;
            if ch.is_whitespace() {
                break;
            }
            if ch == '\\' {
                ensure!(
                    chars.peek().is_some_and(|(_, next)| *next == ' '),
                    "migration_instruction_import_semantics_require_review"
                );
                let (offset, _) = chars.next().expect("checked escaped space");
                path.push(' ');
                end = at + 1 + offset + 1;
                continue;
            }
            ensure!(
                !matches!(
                    ch,
                    '`' | '"' | '\'' | '@' | '<' | '>' | '[' | ']' | '(' | ')'
                ),
                "migration_instruction_import_semantics_require_review"
            );
            path.push(ch);
            ensure!(
                path.len() <= 4096,
                "migration_instruction_import_semantics_require_review"
            );
            end = absolute + ch.len_utf8();
        }
        ensure!(
            !path.is_empty() && path.len() <= 4096,
            "migration_instruction_import_semantics_require_review"
        );
        edits.push(Edit::Import {
            range: range.start + at..range.start + end,
            path,
        });
        ensure!(
            edits.len() <= MAX_EDITS,
            "migration_instruction_source_budget_exceeded"
        );
        position = end;
    }
    Ok(())
}

/// Relative normalization never authorizes an outside path, private file or generated tree.
pub(super) fn resolve(current: &str, import: &str) -> Result<String> {
    ensure!(
        !import.starts_with(['/', '~'])
            && !import.contains(['\\', ':', '$', '%', '{', '}', '*', '?'])
            && !import.chars().any(char::is_control),
        "migration_instruction_import_path_requires_review"
    );
    let mut parts = current.split('/').map(str::to_owned).collect::<Vec<_>>();
    parts.pop();
    for part in import.split('/') {
        match part {
            "." => {}
            ".." => {
                ensure!(
                    parts.pop().is_some(),
                    "migration_instruction_import_path_requires_review"
                );
            }
            "" => anyhow::bail!("migration_instruction_import_path_requires_review"),
            part => parts.push(part.into()),
        }
    }
    ensure!(
        !parts.is_empty() && parts.len() <= 64,
        "migration_instruction_import_path_requires_review"
    );
    for part in &parts {
        super::super::model::validate_leaf(part)?;
        let lower = part.to_ascii_lowercase();
        ensure!(
            (!part.starts_with('.') || part == ".claude")
                && !matches!(
                    lower.as_str(),
                    "node_modules" | "target" | "__pycache__" | "secrets.json" | "secrets.md"
                ),
            "migration_instruction_import_path_requires_review"
        );
    }
    let path = parts.join("/");
    ensure!(
        path.len() <= 4096 && !path.starts_with(".claude/rules/"),
        "migration_instruction_import_path_requires_review"
    );
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_static_imports_preserve_literal_code_and_drop_only_block_comments() {
        let text = "See @docs/intro.md and @package.json\n\n`@literal.md`\n\n```md\n@also-literal.md\n<!-- code comment -->\n```\n\n<!-- @outside/private.md -->\n";
        let parsed = edits(text).unwrap();
        let paths = parsed
            .iter()
            .filter_map(|edit| match edit {
                Edit::Import { path, .. } => Some(path.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(paths, ["docs/intro.md", "package.json"]);
        let comments = parsed
            .iter()
            .filter_map(|edit| match edit {
                Edit::Comment(range) => Some(&text[range.clone()]),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(comments, ["<!-- @outside/private.md -->\n"]);
        for edit in &parsed {
            assert!(
                text.is_char_boundary(edit.range().start)
                    && text.is_char_boundary(edit.range().end)
            );
        }
    }
    #[test]
    fn escaped_spaces_and_quoted_paths_keep_their_distinct_meaning() {
        let text = "Use @Design\\ Docs/guide.md\n\"@quoted.md\"\n@\"also-quoted.md\"\n\"@owner/project@revision\"\n";
        let parsed = edits(text).unwrap();
        let paths = parsed
            .iter()
            .filter_map(|edit| match edit {
                Edit::Import { path, .. } => Some(path.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(paths, ["Design Docs/guide.md"]);
        assert_eq!(&text[parsed[0].range().clone()], "@Design\\ Docs/guide.md");
        assert!(edits("Email user@example.invalid").is_err());
    }
    #[test]
    fn path_proposals_cannot_open_ungranted_parents_credentials_or_dynamic_rules() {
        assert_eq!(
            resolve("nested/CLAUDE.md", "../docs/guide.md").unwrap(),
            "docs/guide.md"
        );
        for path in [
            "../outside.md",
            "/outside.md",
            "~/home.md",
            "C:/outside.md",
            "auth.json",
            ".env",
            ".git/config",
            "node_modules/x.md",
            ".claude/rules/scoped.md",
            "${HOME}/dynamic.md",
            "%USERPROFILE%/dynamic.md",
            "docs/*.md",
        ] {
            assert!(resolve("CLAUDE.md", path).is_err(), "{path}");
        }
    }
}
