//! Draft page file syntax: a small frontmatter, a Markdown body with optional
//! inline markers and a trailing block of citation definitions. Parsing is
//! deterministic and never interprets body text as instructions.
use crate::StoredPage;
use kcoder_types::knowledge::KnowledgePageKind;
use std::collections::{BTreeMap, BTreeSet};

/// A located content problem. Line numbers are 1-based file lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::ingest) struct DraftDiagnostic {
    pub line: usize,
    pub code: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::ingest) enum CitationSpec {
    Ref(String),
    Lines {
        chunk: String,
        first: usize,
        last: usize,
    },
    Quote {
        chunk: String,
        text: String,
    },
    Chunk(String),
    Bytes {
        chunk: String,
        start: usize,
        end: usize,
    },
}

impl CitationSpec {
    /// The private model-wire citation object understood by `CitationRefs::expand`.
    pub(in crate::ingest) fn wire(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Self::Ref(id) => json!({"ref":id}),
            Self::Lines { chunk, first, last } => {
                json!({"chunkId":chunk,"firstLine":first,"lastLine":last})
            }
            Self::Quote { chunk, text } => json!({"chunkId":chunk,"quote":text}),
            Self::Chunk(chunk) => json!({"chunkId":chunk,"wholeChunk":true}),
            Self::Bytes { chunk, start, end } => {
                json!({"chunkId":chunk,"startByte":start,"endByte":end})
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::ingest) struct CitationDef {
    pub label: String,
    pub line: usize,
    pub spec: CitationSpec,
}

#[derive(Debug, Clone, Default)]
pub(in crate::ingest) struct ParsedDraft {
    pub page_id: Option<String>,
    pub kind: Option<KnowledgePageKind>,
    pub title: Option<String>,
    /// None: omitted; Some(None): explicit null.
    pub expected_revision: Option<Option<String>>,
    pub related_page_ids: Vec<String>,
    pub source_units: Option<Vec<String>>,
    /// Number of file lines used by the frontmatter, including both fences.
    pub frontmatter_lines: usize,
    pub field_lines: BTreeMap<&'static str, usize>,
    /// Published body: inline markers and the definition block removed.
    pub markdown: String,
    pub defs: Vec<CitationDef>,
    /// Body line (1-based) to the new citation labels marked on it.
    pub marked: BTreeMap<usize, Vec<String>>,
    pub diagnostics: Vec<DraftDiagnostic>,
}

const KEYS: [&str; 6] = [
    "pageId",
    "kind",
    "title",
    "expectedRevision",
    "relatedPageIds",
    "sourceUnits",
];

fn key_name(key: &str) -> Option<&'static str> {
    KEYS.iter().copied().find(|known| *known == key)
}

fn definition_label(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("[^")?;
    let close = rest.find("]:")?;
    let label = &rest[..close];
    let valid = label.len() >= 2
        && label.len() <= 5
        && matches!(label.as_bytes()[0], b'c' | b'p')
        && label[1..].bytes().all(|byte| byte.is_ascii_digit());
    valid.then(|| (label, rest[close + 2..].trim()))
}

fn strip_comment(value: &str) -> &str {
    // Comments need preceding whitespace so identifiers such as `C#` survive.
    match value.find(" #").or_else(|| value.find("\t#")) {
        Some(index) => value[..index].trim_end(),
        None => value,
    }
}

fn scalar(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value == "null" || value == "~" {
        return None;
    }
    if value.starts_with('"') {
        // Accept a JSON string followed only by an optional comment.
        let mut end = None;
        let mut escaped = false;
        for (index, ch) in value.char_indices().skip(1) {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                end = Some(index);
                break;
            }
        }
        let end = end?;
        return serde_json::from_str::<String>(&value[..=end]).ok();
    }
    if let Some(inner) = value.strip_prefix('\'') {
        let close = inner.rfind('\'')?;
        return Some(inner[..close].replace("''", "'"));
    }
    Some(strip_comment(value).to_owned())
}

fn list(value: &str) -> Option<Vec<String>> {
    let value = strip_comment(value.trim());
    if value.is_empty() || value == "null" || value == "~" {
        return Some(Vec::new());
    }
    if let Ok(items) = serde_json::from_str::<Vec<String>>(value) {
        return Some(items);
    }
    let inner = value.strip_prefix('[')?.strip_suffix(']')?;
    Some(
        inner
            .split(',')
            .map(|item| {
                let item = item.trim();
                item.trim_matches('"').trim_matches('\'').to_owned()
            })
            .filter(|item| !item.is_empty())
            .collect(),
    )
}

fn kind(value: &str) -> Option<KnowledgePageKind> {
    serde_json::from_value(serde_json::Value::String(value.trim().to_owned())).ok()
}

fn parse_spec(text: &str) -> Option<CitationSpec> {
    let text = text.trim();
    let (keyword, rest) = text.split_once(char::is_whitespace)?;
    let rest = rest.trim();
    match keyword {
        "ref" => {
            let id = rest.split_whitespace().next()?;
            (rest.split_whitespace().count() == 1).then(|| CitationSpec::Ref(id.into()))
        }
        "chunk" => {
            let id = rest.split_whitespace().next()?;
            (rest.split_whitespace().count() == 1).then(|| CitationSpec::Chunk(id.into()))
        }
        "lines" | "bytes" => {
            let mut parts = rest.split_whitespace();
            let chunk = parts.next()?.to_owned();
            let range = parts.next()?;
            if parts.next().is_some() {
                return None;
            }
            let (prefix, upper) = if keyword == "lines" {
                ('L', range.to_ascii_uppercase())
            } else {
                ('B', range.to_ascii_uppercase())
            };
            let (left, right) = upper.split_once('-')?;
            let number = |part: &str| {
                part.strip_prefix(prefix)
                    .unwrap_or(part)
                    .parse::<usize>()
                    .ok()
            };
            let (first, last) = (number(left)?, number(right)?);
            Some(if keyword == "lines" {
                CitationSpec::Lines { chunk, first, last }
            } else {
                CitationSpec::Bytes {
                    chunk,
                    start: first,
                    end: last,
                }
            })
        }
        "quote" => {
            let (chunk, quoted) = rest.split_once(char::is_whitespace)?;
            let quoted = quoted.trim();
            let inner = quoted.strip_prefix('"')?.strip_suffix('"')?;
            (!inner.is_empty()).then(|| CitationSpec::Quote {
                chunk: chunk.into(),
                text: inner.into(),
            })
        }
        _ => None,
    }
}

/// Remove host-syntax inline markers. A space before a marker that is followed
/// by punctuation or the line end is removed too, so prose stays natural.
fn strip_markers(line: &str, labels: &mut Vec<String>) -> String {
    let mut output = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("[^") {
        let after = &rest[start + 2..];
        let label_len = after
            .char_indices()
            .take_while(|(index, ch)| {
                if *index == 0 {
                    matches!(ch, 'c' | 'p')
                } else {
                    ch.is_ascii_digit()
                }
            })
            .count();
        let closes = (2..=5).contains(&label_len) && after[label_len..].starts_with(']');
        if !closes {
            output.push_str(&rest[..start + 2]);
            rest = after;
            continue;
        }
        let label = &after[..label_len];
        let mut prefix = &rest[..start];
        let tail = &after[label_len + 1..];
        let next = tail.chars().next();
        if prefix.ends_with(' ')
            && next.is_none_or(|ch| ch.is_ascii_punctuation() || ch == ' ')
            && !tail.starts_with("[^")
        {
            prefix = &prefix[..prefix.len() - 1];
        }
        output.push_str(prefix);
        labels.push(label.to_owned());
        rest = tail;
    }
    output.push_str(rest);
    output
}

pub(in crate::ingest) fn parse_draft(text: &str) -> ParsedDraft {
    let mut parsed = ParsedDraft::default();
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if lines.first().map(|line| line.trim()) != Some("---") {
        parsed.diagnostics.push(DraftDiagnostic {
            line: 1,
            code: "wiki_draft_frontmatter_missing",
        });
        return parsed;
    }
    let Some(close) = lines.iter().skip(1).position(|line| line.trim() == "---") else {
        parsed.diagnostics.push(DraftDiagnostic {
            line: 1,
            code: "wiki_draft_frontmatter_unterminated",
        });
        return parsed;
    };
    let close = close + 1;
    parsed.frontmatter_lines = close + 1;
    let mut index = 1;
    while index < close {
        let line_number = index + 1;
        let line = lines[index];
        index += 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            parsed.diagnostics.push(DraftDiagnostic {
                line: line_number,
                code: "wiki_draft_frontmatter_syntax",
            });
            continue;
        };
        let Some(key) = key_name(key.trim()) else {
            parsed.diagnostics.push(DraftDiagnostic {
                line: line_number,
                code: "wiki_draft_frontmatter_unknown_key",
            });
            continue;
        };
        if parsed.field_lines.insert(key, line_number).is_some() {
            parsed.diagnostics.push(DraftDiagnostic {
                line: line_number,
                code: "wiki_draft_frontmatter_duplicate_key",
            });
            continue;
        }
        let mut value = value.trim().to_owned();
        // YAML block lists: `key:` followed by `- item` lines.
        if value.is_empty() && matches!(key, "relatedPageIds" | "sourceUnits") {
            let mut items = Vec::new();
            while index < close && lines[index].trim_start().starts_with("- ") {
                let item = lines[index].trim_start()[2..].trim();
                items.push(serde_json::Value::String(scalar(item).unwrap_or_default()));
                index += 1;
            }
            value = serde_json::Value::Array(items).to_string();
        }
        match key {
            "pageId" => parsed.page_id = scalar(&value),
            "title" => parsed.title = scalar(&value),
            "expectedRevision" => parsed.expected_revision = Some(scalar(&value)),
            "kind" => match scalar(&value).as_deref().and_then(kind) {
                Some(value) => parsed.kind = Some(value),
                None => parsed.diagnostics.push(DraftDiagnostic {
                    line: line_number,
                    code: "wiki_draft_kind",
                }),
            },
            "relatedPageIds" | "sourceUnits" => match list(&value) {
                Some(items) if key == "relatedPageIds" => parsed.related_page_ids = items,
                Some(items) => parsed.source_units = Some(items),
                None => parsed.diagnostics.push(DraftDiagnostic {
                    line: line_number,
                    code: "wiki_draft_frontmatter_list",
                }),
            },
            _ => unreachable!("known frontmatter key"),
        }
    }
    let body: Vec<&str> = lines[close + 1..].to_vec();
    // The definition block is the trailing run of definition and blank lines.
    let mut block_start = body.len();
    for (position, line) in body.iter().enumerate().rev() {
        if line.trim().is_empty() {
            continue;
        }
        if definition_label(line).is_some() {
            block_start = position;
        } else {
            break;
        }
    }
    let mut labels = BTreeSet::new();
    for (position, line) in body.iter().enumerate().skip(block_start) {
        let Some((label, spec)) = definition_label(line) else {
            continue;
        };
        let file_line = parsed.frontmatter_lines + position + 1;
        if !labels.insert(label.to_owned()) {
            parsed.diagnostics.push(DraftDiagnostic {
                line: file_line,
                code: "wiki_draft_citation_duplicate_label",
            });
            continue;
        }
        if label.starts_with('p') {
            // Prior citations are retained by the host; these lines are display only.
            continue;
        }
        match parse_spec(spec) {
            Some(spec) => parsed.defs.push(CitationDef {
                label: label.into(),
                line: file_line,
                spec,
            }),
            None => parsed.diagnostics.push(DraftDiagnostic {
                line: file_line,
                code: "wiki_draft_citation_syntax",
            }),
        }
    }
    let mut kept = Vec::new();
    for (position, line) in body[..block_start].iter().enumerate() {
        let mut found = Vec::new();
        let stripped = strip_markers(line, &mut found);
        let body_line = position + 1;
        for label in &found {
            if label.starts_with('c') {
                if !parsed.defs.iter().any(|def| &def.label == label) {
                    parsed.diagnostics.push(DraftDiagnostic {
                        line: parsed.frontmatter_lines + body_line,
                        code: "wiki_draft_citation_undefined",
                    });
                }
                parsed
                    .marked
                    .entry(body_line)
                    .or_default()
                    .push(label.clone());
            }
        }
        kept.push(stripped);
    }
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    parsed.markdown = kept.join("\n");
    parsed
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("serializing a string is infallible")
}

fn preview(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .take(80)
        .collect();
    flat.replace('"', "'")
}

/// Render an existing page. Prior citations appear as read-only `[^pN]`
/// definitions; the host retains them whatever the model does with these lines.
pub(in crate::ingest) fn render_page(page: &StoredPage) -> String {
    let draft = &page.draft;
    let kind = serde_json::to_value(&draft.kind)
        .ok()
        .and_then(|value| value.as_str().map(String::from))
        .unwrap_or_default();
    let mut text = format!(
        "---\npageId: {}\nkind: {}\ntitle: {}\nexpectedRevision: {}\nrelatedPageIds: {}\n---\n",
        draft.page_id,
        kind,
        quoted(&draft.title),
        page.revision_id,
        serde_json::to_string(&draft.related_page_ids).unwrap_or_else(|_| "[]".into()),
    );
    text.push_str(&draft.markdown);
    if !draft.citations.is_empty() {
        text.push_str("\n\n");
        for (index, citation) in draft.citations.iter().enumerate() {
            text.push_str(&format!(
                "[^p{}]: existing {} \"{}\"\n",
                index + 1,
                citation.chunk_id,
                preview(&citation.quote)
            ));
        }
    } else {
        text.push('\n');
    }
    text
}

pub(in crate::ingest) const REVIEW_SEED: &str = "# Review\n\n## Blocking\n\n## Notes\n";

/// `## Blocking` bullets become blocking review notes; `## Notes` bullets are
/// advisory. Report other text, except for a standalone empty Blocking marker.
pub(in crate::ingest) fn parse_review(
    text: &str,
) -> (Vec<String>, Vec<String>, Vec<DraftDiagnostic>) {
    let mut blocking = Vec::new();
    let mut notes = Vec::new();
    let mut diagnostics = Vec::new();
    let mut section = None;
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("# ") {
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix("## ") {
            section = match heading.trim().to_ascii_lowercase().as_str() {
                "blocking" => Some(true),
                "notes" => Some(false),
                _ => {
                    diagnostics.push(DraftDiagnostic {
                        line: index + 1,
                        code: "wiki_review_unknown_section",
                    });
                    None
                }
            };
            continue;
        }
        let target = match section {
            Some(true) => &mut blocking,
            Some(false) => &mut notes,
            None => {
                diagnostics.push(DraftDiagnostic {
                    line: index + 1,
                    code: "wiki_review_outside_section",
                });
                continue;
            }
        };
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            if !item.trim().is_empty() {
                target.push(item.trim().to_owned());
            }
        } else if line.starts_with(char::is_whitespace) && !target.is_empty() {
            let last = target.last_mut().unwrap();
            last.push(' ');
            last.push_str(trimmed);
        } else if section == Some(true) && crate::reviews::is_empty_blocking_note(trimmed) {
            target.push(trimmed.to_owned());
        } else {
            diagnostics.push(DraftDiagnostic {
                line: index + 1,
                code: "wiki_review_not_a_bullet",
            });
        }
    }
    blocking.retain(|note| !crate::reviews::is_empty_blocking_note(note));
    (blocking, notes, diagnostics)
}
