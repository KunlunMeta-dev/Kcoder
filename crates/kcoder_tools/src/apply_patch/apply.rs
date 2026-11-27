use super::parser::Chunk;
use super::seek::seek_sequence;

/// Apply ordered chunks to LF-normalized file content. Chunks must be written
/// top-to-bottom (the search cursor only moves forward). Trailing-newline
/// structure is preserved exactly (修订 D3)：split 后只剥掉**一个**由末尾换行
/// 产生的空元素（diff 行数约定，同 codex `file_update.rs`），应用 chunk 后按
/// 原文件「是否有尾换行」还原——尾部空行是内容不是归一化对象；无尾换行的
/// 文件保持无尾换行（与 `edit` 工具的精确保留语义一致）。
pub(crate) fn apply_chunks(content: &str, chunks: &[Chunk]) -> Result<String, String> {
    // 修订 D3：不能用 trim_end_matches('\n')——它会剥掉全部尾换行，
    // 静默吞掉文件末尾的空行（"a\n\n\n" → "a\n"）。
    let mut lines: Vec<String> = content.split('\n').map(|line| line.to_string()).collect();
    let had_trailing_newline = lines.last().is_some_and(String::is_empty);
    if had_trailing_newline {
        lines.pop();
    }
    let mut cursor = 0usize;
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        if !chunk.context.is_empty() {
            let at = seek_sequence(&lines, &chunk.context, cursor, false).ok_or_else(|| {
                format!(
                    "chunk {}: context anchor not found: {:?}",
                    chunk_index + 1,
                    chunk.context.first()
                )
            })?;
            cursor = at + chunk.context.len();
        }
        if chunk.old_lines.is_empty() {
            if chunk.new_lines.is_empty() {
                continue;
            }
            let insert_at = if chunk.end_of_file {
                lines.len()
            } else {
                cursor.min(lines.len())
            };
            for (offset, line) in chunk.new_lines.iter().enumerate() {
                lines.insert(insert_at + offset, line.clone());
            }
            cursor = insert_at + chunk.new_lines.len();
            continue;
        }
        let at = seek_sequence(&lines, &chunk.old_lines, cursor, chunk.end_of_file).ok_or_else(
            || {
                format!(
                    "Failed to find expected lines in patch chunk {} (first line: {:?})",
                    chunk_index + 1,
                    chunk.old_lines.first()
                )
            },
        )?;
        lines.splice(
            at..at + chunk.old_lines.len(),
            chunk.new_lines.iter().cloned(),
        );
        cursor = at + chunk.new_lines.len();
    }
    let mut result = lines.join("\n");
    if had_trailing_newline && !result.is_empty() {
        result.push('\n');
    }
    Ok(result)
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
    fn in_order_chunks_apply() {
        let content = "head\nmid\nmid2\ntail\n";
        let out = apply_chunks(
            content,
            &[
                chunk(&[], &["mid"], &["MIDDLE"], false),
                chunk(&[], &["tail"], &["TAIL"], true),
            ],
        )
        .unwrap();
        assert_eq!(out, "head\nMIDDLE\nmid2\nTAIL\n");
    }

    #[test]
    fn out_of_order_chunks_fail_because_the_cursor_moves_forward() {
        let content = "fn a() {\n    x\n}\nfn b() {\n    y\n}\n";
        let error = apply_chunks(
            content,
            &[
                chunk(&["fn b() {"], &["    y"], &["    y2"], false),
                chunk(&["fn a() {"], &["    x"], &["    x2"], false),
            ],
        )
        .expect_err("chunks must be written in file order");
        assert!(error.contains("context anchor not found"), "error: {error}");
    }

    #[test]
    fn inserts_at_end_when_old_lines_empty() {
        let out = apply_chunks("a\nb\n", &[chunk(&[], &[], &["c"], true)]).unwrap();
        assert_eq!(out, "a\nb\nc\n");
    }

    #[test]
    fn trailing_whitespace_in_file_still_matches_trimmed_patch() {
        let out = apply_chunks("keep   \n", &[chunk(&[], &["keep"], &["kept"], false)]).unwrap();
        assert_eq!(out, "kept\n");
    }

    #[test]
    fn missing_lines_error_names_the_first_line() {
        let error = apply_chunks("a\n", &[chunk(&[], &["zz"], &["y"], false)]).unwrap_err();
        assert!(error.contains("zz"), "error: {error}");
    }

    #[test]
    fn empty_file_receives_new_lines() {
        let out = apply_chunks("", &[chunk(&[], &[], &["hello"], false)]).unwrap();
        assert_eq!(out, "hello\n");
    }

    #[test]
    fn trailing_blank_lines_and_missing_final_newline_survive() {
        // 修订 D3：尾部空行是内容；无尾换行保持无尾换行（与 edit 一致）。
        assert_eq!(apply_chunks("a\n\n", &[]).unwrap(), "a\n\n");
        assert_eq!(apply_chunks("a\n\n\n", &[]).unwrap(), "a\n\n\n");
        assert_eq!(
            apply_chunks("a", &[chunk(&[], &["a"], &["b"], false)]).unwrap(),
            "b"
        );
    }
}
