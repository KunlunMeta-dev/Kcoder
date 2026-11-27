use super::*;
use serde_json::json;

async fn read_text(ctx: &ToolContext, input: Value) -> String {
    let output = FileReadTool.call(input, ctx).await.unwrap();
    assert!(!output.is_error);
    output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn numbered_reads_state_whole_file_byte_and_newline_facts_outside_content_lines() {
    let root = tempfile::tempdir().unwrap();
    let lf_body = format!("{}\n", "x".repeat(77));
    std::fs::write(root.path().join("lf.txt"), &lf_body).unwrap();
    std::fs::write(root.path().join("bare.txt"), "alpha\nbeta").unwrap();
    std::fs::write(root.path().join("crlf.txt"), "a\r\nb\r\n").unwrap();
    std::fs::write(root.path().join("mixed.txt"), "a\r\nb\nc").unwrap();
    std::fs::write(root.path().join("long.txt"), "line\n".repeat(10)).unwrap();
    let ctx = ToolContext::new(kcoder_state::AppState::new(root.path().to_path_buf()));

    let lf = read_text(&ctx, json!({"file_path":"lf.txt"})).await;
    assert!(
        lf.contains(":\n[file: 78 bytes, utf-8, ends with LF, line endings LF]\n\n     1\t"),
        "{lf}"
    );
    let bare = read_text(&ctx, json!({"file_path":"bare.txt"})).await;
    assert!(
        bare.contains("[file: 10 bytes, utf-8, no trailing newline, line endings LF]"),
        "{bare}"
    );
    let crlf = read_text(&ctx, json!({"file_path":"crlf.txt"})).await;
    assert!(
        crlf.contains("[file: 6 bytes, utf-8, ends with CRLF, line endings CRLF]"),
        "{crlf}"
    );
    // Content lines stay LF-normalized, so edit old_string matching is unchanged.
    assert!(crlf.ends_with("     1\ta\n     2\tb"), "{crlf}");
    let mixed = read_text(&ctx, json!({"file_path":"mixed.txt"})).await;
    assert!(
        mixed.contains("no trailing newline, line endings mixed (1 LF, 1 CRLF)]"),
        "{mixed}"
    );

    // A ranged read reports the whole file, not the returned slice.
    let ranged = read_text(&ctx, json!({"file_path":"long.txt","offset":3,"limit":2})).await;
    assert!(
        ranged.contains("Showing lines 3-4 of 10 from ")
            && ranged.contains("[file: 50 bytes, utf-8, ends with LF, line endings LF]"),
        "{ranged}"
    );

    // Raw mode stays exact data without the metadata line.
    let raw = read_text(&ctx, json!({"file_path":"crlf.txt","format":"raw"})).await;
    assert_eq!(raw, "a\nb\n");
}
