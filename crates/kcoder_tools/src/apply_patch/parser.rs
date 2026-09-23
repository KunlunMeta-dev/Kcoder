/// One file-level operation in a patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Hunk {
    Add {
        path: String,
        lines: Vec<String>,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        chunks: Vec<Chunk>,
    },
}

/// One `@@`-anchored change region inside an Update hunk. `old_lines` and
/// `new_lines` already interleave shared context lines (space prefix).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Chunk {
    pub(crate) context: Vec<String>,
    pub(crate) old_lines: Vec<String>,
    pub(crate) new_lines: Vec<String>,
    pub(crate) end_of_file: bool,
}

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const DELETE: &str = "*** Delete File: ";
const UPDATE: &str = "*** Update File: ";
const MOVE_TO: &str = "*** Move to: ";
const EOF_MARKER: &str = "*** End of File";

/// Parse full patch text. Lenient: tolerates blank lines, whitespace padding
/// around markers, a quoted-heredoc wrapper (`<<'EOF' … EOF`), and CRLF.
pub(crate) fn parse_patch(raw: &str) -> Result<Vec<Hunk>, String> {
    let body = strip_heredoc(raw).replace("\r\n", "\n");
    let lines: Vec<&str> = body.lines().collect();
    let mut index = 0usize;
    while index < lines.len() && lines[index].trim().is_empty() {
        index += 1;
    }
    if index >= lines.len() || lines[index].trim() != BEGIN {
        return Err("patch must start with `*** Begin Patch`".to_string());
    }
    index += 1;

    let mut hunks: Vec<Hunk> = Vec::new();
    loop {
        if index >= lines.len() {
            return Err("patch is missing `*** End Patch`".to_string());
        }
        let trimmed = lines[index].trim();
        if trimmed == END {
            break;
        }
        if trimmed == BEGIN {
            return Err(format!("line {}: nested `*** Begin Patch`", index + 1));
        }
        if trimmed.is_empty() {
            index += 1;
            continue;
        }

        if let Some(path) = trimmed.strip_prefix(ADD) {
            index += 1;
            let mut content = Vec::new();
            while index < lines.len() {
                let line = lines[index];
                let trimmed_line = line.trim_start();
                if trimmed_line == END || trimmed_line.starts_with("*** ") {
                    break;
                }
                match line.strip_prefix('+') {
                    Some(rest) => content.push(rest.to_string()),
                    None => {
                        return Err(format!(
                            "line {}: Add File body must start with `+`: {line:?}",
                            index + 1
                        ));
                    }
                }
                index += 1;
            }
            if content.is_empty() {
                return Err(format!("Add File {path} has no content lines"));
            }
            hunks.push(Hunk::Add {
                path: path.trim().to_string(),
                lines: content,
            });
        } else if let Some(path) = trimmed.strip_prefix(DELETE) {
            index += 1;
            hunks.push(Hunk::Delete {
                path: path.trim().to_string(),
            });
        } else if let Some(path) = trimmed.strip_prefix(UPDATE) {
            let path = path.trim().to_string();
            index += 1;
            let mut move_to = None;
            if index < lines.len() && lines[index].trim().starts_with(MOVE_TO) {
                move_to = Some(lines[index].trim()[MOVE_TO.len()..].trim().to_string());
                index += 1;
            }
            let mut chunks: Vec<Chunk> = Vec::new();
            while index < lines.len() {
                let line = lines[index];
                let trimmed_line = line.trim_start();
                // EOF marker is checked BEFORE the generic "***" break: it
                // belongs to the current update hunk.
                if trimmed_line == EOF_MARKER {
                    match chunks.last_mut() {
                        Some(current) => current.end_of_file = true,
                        None => {
                            return Err(format!(
                                "line {}: `*** End of File` outside a change chunk",
                                index + 1
                            ));
                        }
                    }
                    index += 1;
                    continue;
                }
                if trimmed_line == END || trimmed_line.starts_with("*** ") {
                    break;
                }
                if trimmed_line == "@@" || trimmed_line.starts_with("@@ ") {
                    let anchor = trimmed_line[2..].trim().to_string();
                    chunks.push(if anchor.is_empty() {
                        Chunk::default()
                    } else {
                        Chunk {
                            context: vec![anchor],
                            ..Default::default()
                        }
                    });
                    index += 1;
                    continue;
                }
                if chunks.is_empty() {
                    chunks.push(Chunk::default());
                }
                let current = chunks.last_mut().expect("chunk pushed above");
                if let Some(rest) = line.strip_prefix('+') {
                    current.new_lines.push(rest.to_string());
                } else if let Some(rest) = line.strip_prefix('-') {
                    current.old_lines.push(rest.to_string());
                } else if let Some(rest) = line.strip_prefix(' ') {
                    let shared = rest.to_string();
                    current.old_lines.push(shared.clone());
                    current.new_lines.push(shared);
                } else {
                    return Err(format!(
                        "line {}: unexpected line in update chunk: {line:?}",
                        index + 1
                    ));
                }
                index += 1;
            }
            hunks.push(Hunk::Update {
                path,
                move_to,
                chunks,
            });
        } else {
            return Err(format!(
                "line {}: unknown hunk header {trimmed:?}",
                index + 1
            ));
        }
    }
    Ok(hunks)
}

/// Paths touched by a patch (sources and move destinations). Empty on parse
/// failure — callers use this for approval context and checkpoints, never for
/// security decisions; the tool re-parses and enforces on its own.
pub fn patch_affected_paths(raw: &str) -> Vec<String> {
    match parse_patch(raw) {
        Ok(hunks) => hunks
            .iter()
            .flat_map(|hunk| match hunk {
                Hunk::Add { path, .. } | Hunk::Delete { path } => vec![path.clone()],
                Hunk::Update { path, move_to, .. } => match move_to {
                    Some(target) => vec![path.clone(), target.clone()],
                    None => vec![path.clone()],
                },
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn strip_heredoc(raw: &str) -> String {
    let trimmed = raw.trim();
    for opener in ["<<'EOF'", "<<EOF", "<<'PATCH'", "<<PATCH"] {
        if let Some(rest) = trimmed.strip_prefix(opener) {
            let closer = opener.trim_start_matches("<<").trim_matches('\'');
            if let Some(end) = rest.rfind(&format!("\n{closer}")) {
                return rest[..end].to_string();
            }
        }
    }
    raw.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(context: &[&str], old: &[&str], new: &[&str], eof: bool) -> Chunk {
        Chunk {
            context: context.iter().map(|s| s.to_string()).collect(),
            old_lines: old.iter().map(|s| s.to_string()).collect(),
            new_lines: new.iter().map(|s| s.to_string()).collect(),
            end_of_file: eof,
        }
    }

    #[test]
    fn parses_update_add_delete_and_move_hunks() {
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: src/app.rs\n",
            "@@ fn main()\n",
            "- let x = 1;\n",
            "+ let x = 2;\n",
            "*** Add File: notes/todo.md\n",
            "+# todo\n",
            "*** Delete File: old.txt\n",
            "*** Update File: lib/a.rs\n",
            "*** Move to: lib/b.rs\n",
            "@@\n",
            "-a\n",
            "+b\n",
            "*** End of File\n",
            "*** End Patch\n",
        );
        let hunks = parse_patch(patch).expect("parse ok");
        assert_eq!(
            hunks[0],
            Hunk::Update {
                path: "src/app.rs".into(),
                move_to: None,
                chunks: vec![chunk(
                    &["fn main()"],
                    &[" let x = 1;"],
                    &[" let x = 2;"],
                    false
                )],
            }
        );
        assert_eq!(
            hunks[1],
            Hunk::Add {
                path: "notes/todo.md".into(),
                lines: vec!["# todo".into()],
            }
        );
        assert_eq!(
            hunks[2],
            Hunk::Delete {
                path: "old.txt".into()
            }
        );
        assert_eq!(
            hunks[3],
            Hunk::Update {
                path: "lib/a.rs".into(),
                move_to: Some("lib/b.rs".into()),
                chunks: vec![chunk(&[], &["a"], &["b"], true)],
            }
        );
    }

    #[test]
    fn context_lines_land_in_both_sides() {
        let patch = "*** Begin Patch\n*** Update File: x\n@@\n shared\n-old\n+new\n*** End Patch\n";
        let hunks = parse_patch(patch).unwrap();
        let Hunk::Update { chunks, .. } = &hunks[0] else {
            panic!("update expected")
        };
        assert_eq!(chunks[0].old_lines, vec!["shared", "old"]);
        assert_eq!(chunks[0].new_lines, vec!["shared", "new"]);
    }

    #[test]
    fn strips_heredoc_wrapper_and_tolerates_padding() {
        let patch = concat!(
            "<<'EOF'\n",
            " *** Begin Patch\n",
            "*** Update File: a.txt\n",
            "@@\n",
            "-1\n",
            "+2\n",
            "*** End Patch\n",
            "EOF",
        );
        assert_eq!(parse_patch(patch).expect("parse ok").len(), 1);
    }

    #[test]
    fn errors_are_line_numbered_and_structural() {
        assert_eq!(
            parse_patch("hello").unwrap_err(),
            "patch must start with `*** Begin Patch`"
        );
        assert_eq!(
            parse_patch(
                "*** Begin Patch\n*** Update File: a.txt\n*** End of File\n*** End Patch\n"
            )
            .unwrap_err(),
            "line 3: `*** End of File` outside a change chunk"
        );
        assert!(
            parse_patch("*** Begin Patch\n*** Bogus: x\n*** End Patch\n")
                .unwrap_err()
                .contains("unknown hunk header")
        );
        assert!(
            parse_patch("*** Begin Patch\n*** Add File: x\nnot plus\n*** End Patch\n")
                .unwrap_err()
                .contains("must start with `+`")
        );
        // 空补丁解析为零 hunk；工具层单独拒绝（"No files were modified."）。
        // （原稿的 `unwrap_err() || == Ok(vec![])` 写法在 Ok 时会在短路前 panic。）
        assert_eq!(parse_patch("*** Begin Patch\n*** End Patch\n"), Ok(vec![]));
    }

    #[test]
    fn affected_paths_cover_moves_and_survive_parse_errors() {
        let patch = "*** Begin Patch\n*** Update File: a.rs\n*** Move to: b.rs\n@@\n-x\n+y\n*** End Patch\n";
        assert_eq!(patch_affected_paths(patch), vec!["a.rs", "b.rs"]);
        assert!(patch_affected_paths("nonsense").is_empty());
    }
}
