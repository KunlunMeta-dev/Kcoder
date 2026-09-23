    use super::*;

    #[test]
    fn renders_bold_and_code() {
        let lines = render_markdown("Hello **world** and `code`");
        assert!(!lines.is_empty());
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(text, "Hello world and code");
    }

    #[test]
    fn renders_heading() {
        let lines = render_markdown("# Title\n\nBody");
        assert_eq!(lines_to_text(&lines), "Title\nBody");
    }

    #[test]
    fn headings_keep_six_semantic_styles() {
        let lines = render_markdown(
            "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n",
        );
        let styles = KCODER_UI_THEME.text_styles();
        let expected = [
            styles.heading_h1,
            styles.heading_h2,
            styles.heading_h3,
            styles.heading_h4,
            styles.heading_h5,
            styles.heading_h6,
        ];

        assert_eq!(lines.len(), expected.len());
        for (line, expected_style) in lines.iter().zip(expected) {
            let content = line
                .spans
                .iter()
                .find(|span| !span.content.is_empty())
                .expect("标题应包含可见文本");
            assert_eq!(content.style, expected_style);
        }
    }

    #[test]
    fn lists_tasks_links_quotes_and_tables_use_semantic_styles() {
        let styles = KCODER_UI_THEME.text_styles();
        let lines = render_markdown(
            "- bullet\n1. ordered\n- [ ] pending\n- [x] done\n\n> quoted **strong** text\n\n[docs](https://example.com)\n\n| Key | Value |\n| --- | --- |\n| color | codex |\n",
        );
        let spans = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .collect::<Vec<_>>();
        let span = |content: &str| {
            spans
                .iter()
                .copied()
                .find(|span| span.content == content)
                .unwrap_or_else(|| panic!("缺少 Markdown span: {content}"))
        };

        assert_eq!(span("- ").style, styles.unordered_list_marker);
        assert_eq!(span("1. ").style, styles.ordered_list_marker);
        assert_eq!(span("[ ] ").style, styles.task_unchecked);
        assert_eq!(span("[x] ").style, styles.task_checked);
        assert_eq!(span("quoted ").style.fg, styles.blockquote.fg);
        assert_eq!(span("strong").style.fg, styles.blockquote.fg);
        assert_eq!(span("https://example.com").style, styles.link);
        let table_header = lines
            .iter()
            .find(|line| line.spans.iter().any(|span| span.content == "Key"))
            .expect("应渲染表头");
        assert!(table_header.style.fg.is_some());
        assert!(table_header.style.add_modifier.contains(Modifier::BOLD));
        assert!(
            lines.iter().any(|line| line.style == styles.table_separator)
                || spans
                    .iter()
                    .any(|span| span.style == styles.table_separator)
        );
    }

    #[test]
    fn ordinary_markdown_text_uses_theme_body_style() {
        let lines = render_markdown("Body text");
        let body_span = lines[0]
            .spans
            .iter()
            .find(|span| span.content == "Body text")
            .expect("ordinary body span should render");

        assert_eq!(body_span.style, KCODER_UI_THEME.text_styles().body);
    }

    #[test]
    fn renders_list_and_link() {
        let lines = render_markdown("- Item 1\n- [link](https://example.com)");
        let text: String = lines
            .iter()
            .flat_map(|l| &l.spans)
            .map(|s| s.content.as_ref())
            .collect();
        assert!(text.contains("Item 1"));
        assert!(text.contains("link"));
    }

    #[test]
    fn renders_web_link_with_visible_destination() {
        let lines = render_markdown("See [docs](https://example.com/docs).");
        let text = lines_to_text(&lines);

        assert_eq!(text, "See docs (https://example.com/docs).");

        let label_span = lines[0]
            .spans
            .iter()
            .find(|span| span.content == "docs")
            .expect("link label should render");
        assert_eq!(label_span.style, KCODER_UI_THEME.text_styles().link);

        let destination_span = lines[0]
            .spans
            .iter()
            .find(|span| span.content == "https://example.com/docs")
            .expect("link destination should render");
        assert_eq!(destination_span.style, KCODER_UI_THEME.text_styles().link);
        assert!(
            destination_span
                .style
                .add_modifier
                .contains(Modifier::UNDERLINED)
        );
    }

    #[test]
    fn supported_terminal_hides_web_destination_and_keeps_clickable_styled_label() {
        let destination = "https://example.com/docs";
        let lines = render_markdown_hyperlink_lines_with_theme_and_cwd_policy(
            &format!("See [**docs**]({destination})."),
            "base16-ocean.dark",
            None,
            None,
            true,
        );

        assert_eq!(hyperlink_lines_to_text(&lines), "See docs.");
        let label = lines[0]
            .line
            .spans
            .iter()
            .find(|span| span.content == "docs")
            .expect("可点击 label 应保留");
        assert_eq!(
            label.style.fg,
            Some(ratatui::style::Color::Cyan)
        );
        assert!(label.style.add_modifier.contains(Modifier::BOLD));
        assert!(label.style.add_modifier.contains(Modifier::UNDERLINED));
        assert_eq!(
            lines[0].hyperlinks,
            vec![TerminalHyperlink {
                columns: text_column_range("See docs.", "docs"),
                destination: destination.to_string(),
            }]
        );
    }

    #[test]
    fn hidden_destination_policy_keeps_url_when_label_is_empty() {
        let destination = "https://example.com/docs";
        let lines = render_markdown_hyperlink_lines_with_theme_and_cwd_policy(
            &format!("[]({destination})"),
            "base16-ocean.dark",
            None,
            None,
            true,
        );

        assert!(hyperlink_lines_to_text(&lines).contains(destination));
    }

    #[test]
    fn renders_web_link_label_with_semantic_destination() {
        let destination = "https://example.com/docs";
        let lines = render_markdown_hyperlink_lines_with_theme_and_cwd(
            &format!("See [docs]({destination})."),
            "base16-ocean.dark",
            None,
            None,
        );

        assert_eq!(
            hyperlink_lines_to_text(&lines),
            format!("See docs ({destination}).")
        );
        let first_line = &lines[0];
        let first_line_text = hyperlink_line_text(first_line);
        assert!(first_line.hyperlinks.contains(&TerminalHyperlink {
            columns: text_column_range(&first_line_text, "docs"),
            destination: destination.to_string(),
        }));
        assert!(first_line.hyperlinks.contains(&TerminalHyperlink {
            columns: text_column_range(&first_line_text, destination),
            destination: destination.to_string(),
        }));
    }

    #[test]
    fn decoded_text_merge_combines_adjacent_text_ranges() {
        let merged = DecodedTextMerge::new(
            vec![
                (Event::Text("hello".into()), 0..5),
                (Event::Text(" world".into()), 5..11),
                (Event::Code("code".into()), 12..16),
                (Event::Text(" tail".into()), 17..22),
            ]
            .into_iter(),
        )
        .collect::<Vec<_>>();

        assert_eq!(merged.len(), 3);
        match &merged[0] {
            (Event::Text(text), range) => {
                assert_eq!(text.as_ref(), "hello world");
                assert_eq!(range.clone(), 0..11);
            }
            other => panic!("expected merged text event, got {other:?}"),
        }
        match &merged[1] {
            (Event::Code(code), range) => {
                assert_eq!(code.as_ref(), "code");
                assert_eq!(range.clone(), 12..16);
            }
            other => panic!("expected code event, got {other:?}"),
        }
        match &merged[2] {
            (Event::Text(text), range) => {
                assert_eq!(text.as_ref(), " tail");
                assert_eq!(range.clone(), 17..22);
            }
            other => panic!("expected trailing text event, got {other:?}"),
        }
    }

    #[test]
    fn decoded_text_merge_preserves_bare_url_annotation_for_split_events() {
        let destination = "https://example.com/path";
        let mut renderer =
            MarkdownRenderer::new(destination, "base16-ocean.dark", None, None, false);
        let events = vec![
            (Event::Text("https://".into()), 0..8),
            (Event::Text("example.com/path".into()), 8..destination.len()),
        ];

        for (event, range) in DecodedTextMerge::new(events.into_iter()) {
            renderer.handle(event, range);
        }
        let lines = renderer.finish();

        assert_eq!(hyperlink_lines_to_text(&lines), destination);
        assert_eq!(
            lines[0].hyperlinks,
            vec![TerminalHyperlink {
                columns: 0..destination.len(),
                destination: destination.to_string(),
            }]
        );
    }

    #[test]
    fn renders_local_link_target_instead_of_label() {
        let lines = render_markdown_with_theme_and_cwd(
            "[label](/Users/example/code/kcoder/crates/kcoder_repl/src/markdown.rs:12:3)",
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/kcoder")),
        );
        let text = lines_to_text(&lines);

        assert_eq!(text, "crates/kcoder_repl/src/markdown.rs:12:3");
        assert!(!text.contains("label"));

        let target_span = lines[0]
            .spans
            .iter()
            .find(|span| span.content == "crates/kcoder_repl/src/markdown.rs:12:3")
            .expect("local target should render");
        assert_eq!(target_span.style, KCODER_UI_THEME.text_styles().inline_code);
    }

    #[test]
    fn renders_file_url_hash_range_as_local_target() {
        let lines = render_markdown_with_theme_and_cwd(
            "[label](file:///Users/example/code/kcoder/crates/kcoder_repl/src/markdown.rs#L74C3-L76C9)",
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/kcoder")),
        );

        assert_eq!(
            lines_to_text(&lines),
            "crates/kcoder_repl/src/markdown.rs:74:3-76:9"
        );
    }

    #[test]
    fn renders_file_url_colon_suffix_as_local_target() {
        let lines = render_markdown_with_theme_and_cwd(
            "[label](file:///Users/example/code/kcoder/crates/kcoder_repl/src/markdown.rs:74:3)",
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/kcoder")),
        );

        assert_eq!(
            lines_to_text(&lines),
            "crates/kcoder_repl/src/markdown.rs:74:3"
        );
    }

    #[test]
    fn renders_file_url_host_without_path_as_unc_target() {
        let lines = render_markdown_with_theme_and_cwd(
            "[label](file://build-server)",
            "base16-ocean.dark",
            None,
        );

        assert_eq!(lines_to_text(&lines), "//build-server/");
    }

    #[test]
    fn ignores_multiline_local_link_label_breaks() {
        let lines = render_markdown_with_theme_and_cwd(
            "**bold** plain [foo\nbar](file:///Users/example/code/kcoder/crates/kcoder_repl/src/markdown.rs#L74C3)",
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/kcoder")),
        );

        assert_eq!(
            lines_to_text(&lines),
            "bold plain crates/kcoder_repl/src/markdown.rs:74:3"
        );
    }

    #[test]
    fn unordered_list_local_file_link_stays_inline_with_following_text() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_cwd(
            "- [binary](/Users/example/code/codex/codex-rs/README.md:93): core is the agent/business logic, tui is the terminal UI, exec is the headless automation surface, and cli is the top-level multitool binary.",
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/codex")),
            Some(72),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "- codex-rs/README.md:93: core is the agent/business logic, tui is the",
                "  terminal UI, exec is the headless automation surface, and cli is the",
                "  top-level multitool binary.",
            ]
        );
    }

    #[test]
    fn unordered_list_local_file_link_soft_break_before_colon_stays_inline() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_cwd(
            "- [binary](/Users/example/code/codex/codex-rs/README.md:93)\n  : core is the agent/business logic.",
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/codex")),
            Some(72),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["- codex-rs/README.md:93: core is the agent/business logic."]
        );
    }

    #[test]
    fn consecutive_unordered_list_local_file_links_do_not_detach_paths() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_cwd(
            "- [binary](/Users/example/code/codex/codex-rs/README.md:93)\n  : cli is the top-level multitool binary.\n- [expectations](/Users/example/code/codex/codex-rs/core/README.md:1)\n  : codex-core owns the real runtime behavior.",
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/codex")),
            Some(72),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "- codex-rs/README.md:93: cli is the top-level multitool binary.",
                "- codex-rs/core/README.md:1: codex-core owns the real runtime behavior.",
            ]
        );
    }

    #[test]
    fn renders_code_block() {
        let lines = render_markdown("```rust\nlet x = 1;\n```");
        assert_eq!(lines_to_text(&lines), "let x = 1;");
    }

    #[test]
    fn fenced_code_info_string_with_metadata_highlights() {
        for info in &["rust,no_run", "rust no_run", "rust title=\"demo\""] {
            let markdown = format!("```{info}\nfn main() {{}}\n```\n");
            let lines = render_markdown_with_theme(&markdown, "base16-ocean.dark");
            let code_line = lines
                .iter()
                .find(|line| line_text(line).contains("fn main"))
                .unwrap_or_else(|| panic!("code line should render for info string {info}"));
            assert!(
                code_line
                    .spans
                    .iter()
                    .any(|span| span.style != Style::default()),
                "info string {info:?} should still produce syntax highlighting"
            );
        }
    }

    #[test]
    fn crlf_code_block_has_no_extra_blank_lines_between_code_lines() {
        let lines = render_markdown_with_theme(
            "```rust\r\nfn main() {}\r\n    line2\r\n```\r\n",
            "base16-ocean.dark",
        );
        let rendered = lines_to_text(&lines);
        let code_lines = rendered
            .lines()
            .filter(|line| line.contains("fn main") || line.contains("line2") || line.is_empty())
            .collect::<Vec<_>>();

        assert_eq!(code_lines, vec!["fn main() {}", "    line2"]);
    }

    #[test]
    fn code_block_preserves_trailing_blank_lines() {
        let lines = render_markdown("```rust\nfn main() {}\n\n```\n");
        let rendered_lines = lines.iter().map(line_text).collect::<Vec<_>>();
        let code_start = rendered_lines
            .iter()
            .position(|line| line == "fn main() {}")
            .expect("code line should render");

        assert_eq!(
            rendered_lines.get(code_start + 1).map(String::as_str),
            Some("")
        );
    }

    #[test]
    fn indented_code_block_keeps_four_space_prefix() {
        let lines = render_markdown("    function greet() {\n      println!(\"hi\");\n    }\n");

        assert_eq!(
            lines_to_text(&lines),
            "    function greet() {\n      println!(\"hi\");\n    }"
        );
    }

    #[test]
    fn fenced_code_block_inside_unordered_list_item_is_indented() {
        let lines = render_markdown("- Item\n\n  ```\n  code line\n  ```\n");

        assert_eq!(lines_to_text(&lines), "- Item\n\n  code line");
    }

    #[test]
    fn fenced_code_block_multiple_lines_inside_unordered_list_is_indented() {
        let lines = render_markdown("- Item\n\n  ```\n  first\n  second\n  ```\n");

        assert_eq!(lines_to_text(&lines), "- Item\n\n  first\n  second");
    }

    #[test]
    fn code_block_with_inner_triple_backticks_outer_four() {
        let lines = render_markdown(
            r#"````text
Here is a code block that shows another fenced block:

```md
# Inside fence
- bullet
- `inline code`
```
````
"#,
        );
        let mut rendered = lines_to_text(&lines)
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        while rendered.last().is_some_and(|line| line.is_empty()) {
            rendered.pop();
        }

        assert_eq!(
            rendered,
            vec![
                "Here is a code block that shows another fenced block:",
                "",
                "```md",
                "# Inside fence",
                "- bullet",
                "- `inline code`",
                "```",
            ]
        );
    }

    #[test]
    fn list_item_after_code_block_keeps_blank_separator() {
        let lines =
            render_markdown("1. First:\n\n   ```rust\n   fn first() {}\n   ```\n\n2. Second:\n");

        assert_eq!(
            lines_to_text(&lines),
            "1. First:\n\n   fn first() {}\n\n2. Second:"
        );
    }

    #[test]
    fn outer_list_item_after_nested_code_block_keeps_blank_separator() {
        let lines = render_markdown(
            "1. First:\n   - Nested:\n\n     ```rust\n     fn first() {}\n     ```\n\n2. Second:\n",
        );

        assert_eq!(
            lines_to_text(&lines),
            "1. First:\n    - Nested:\n\n      fn first() {}\n\n2. Second:"
        );
    }

    #[test]
    fn ordered_item_with_code_block_and_nested_bullet() {
        let lines = render_markdown(
            "1. **item 1**\n\n2. **item 2**\n   ```\n   code\n   ```\n   - `PROCESS_START` (a `OnceLock<Instant>`) keeps the start time for the entire process.\n",
        );

        assert_eq!(
            lines_to_text(&lines),
            "1. item 1\n2. item 2\n\n   code\n    - PROCESS_START (a OnceLock<Instant>) keeps the start time for the entire process."
        );
    }

    #[test]
    fn blockquote_code_block_keeps_quote_prefix() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "> ```\n> code\n> ```\n",
            "base16-ocean.dark",
        );
        let rendered = hyperlink_lines_to_strings(&lines);
        let non_empty_lines = rendered
            .iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();

        assert!(
            non_empty_lines.iter().all(|line| line.starts_with("> ")),
            "rendered lines: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line.contains("code")),
            "rendered lines: {rendered:?}"
        );
    }

    #[test]
    fn renders_pipe_table_as_structured_rows() {
        let lines =
            render_markdown("| Name | Count |\n| --- | ---: |\n| beta | 12 |\n| alpha | 3 |");
        let rendered = lines_to_text(&lines);

        assert!(rendered.contains("Name"));
        assert!(rendered.contains("Count"));
        assert!(rendered.contains("======  ======="), "rendered table: {rendered}");
        assert!(!rendered.contains(['━', '─']), "rendered table: {rendered}");
        assert!(rendered.contains("beta"));
        assert!(rendered.contains("12"));
        assert!(rendered.contains("alpha"));
        assert!(rendered.contains("3"));
        assert!(!rendered.contains('│'));
    }

    #[test]
    fn agent_markdown_unwraps_markdown_table_fence() {
        let lines = render_agent_markdown_hyperlink_lines_with_theme(
            "```markdown\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n",
            "base16-ocean.dark",
        );
        let rendered = hyperlink_lines_to_text(&lines);

        assert!(rendered.contains("A"));
        assert!(rendered.contains("1"));
        assert!(rendered.contains('='), "rendered table: {rendered}");
        assert!(!rendered.contains(['━', '─']), "rendered table: {rendered}");
        assert!(!rendered.contains(" markdown "));
    }

    #[test]
    fn agent_markdown_keeps_markdown_fence_without_table() {
        let src = "```markdown\n**bold**\n```\n";

        assert_eq!(unwrap_markdown_fences(src).as_ref(), src);
    }

    #[test]
    fn agent_markdown_unwraps_blockquoted_table_fence() {
        let src = "> ```md\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n> ```\n";
        let rendered = unwrap_markdown_fences(src);

        assert!(!rendered.contains("```"));
        assert!(rendered.contains("> | A | B |"));
    }

    #[test]
    fn renders_table_cell_inline_styles() {
        let lines = render_markdown("| Item |\n| --- |\n| `code` |");
        let code_span = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .find(|span| span.content == "code")
            .expect("inline code cell span should render");

        assert_eq!(code_span.style, KCODER_UI_THEME.text_styles().inline_code);
    }

    #[test]
    fn width_constrained_table_wraps_cells_without_overflow() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| Name | Details |\n| --- | --- |\n| alpha | short words wrap inside the second column |",
            "base16-ocean.dark",
            Some(36),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(rendered.iter().any(|line| line.contains("Name")));
        assert!(rendered.iter().any(|line| line.contains("second")));
        assert!(rendered.iter().all(|line| !line.contains('│')));
        assert!(lines.iter().all(|line| line.width() <= 36));
    }

    #[test]
    fn narrow_table_renders_key_value_records() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| File | Problem | Status |\n| --- | --- | --- |\n| markdown.rs | compact table columns become unreadable | open |",
            "base16-ocean.dark",
            Some(24),
        );
        let rendered = hyperlink_lines_to_text(&lines);

        assert!(rendered.contains("File"));
        assert!(rendered.contains("Problem"));
        assert!(rendered.contains("compact table"));
        assert!(!rendered.contains("│"));
        assert!(lines.iter().all(|line| line.width() <= 24));
    }

    #[test]
    fn narrow_table_records_preserve_web_hyperlinks() {
        let destination = "https://example.com/docs/reference";
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            &format!("| Link | Notes |\n| --- | --- |\n| [docs]({destination}) | read carefully |"),
            "base16-ocean.dark",
            Some(18),
        );

        assert!(
            lines
                .iter()
                .flat_map(|line| line.hyperlinks.iter())
                .any(
                    |link| link.destination == destination && link.columns.end > link.columns.start
                )
        );
        assert!(hyperlink_lines_to_text(&lines).contains("docs"));
    }

    #[test]
    fn table_spillover_single_cell_row_renders_after_table() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| Name | Count |\n| --- | --- |\n| alpha | 1 |\ntrailing paragraph",
            "base16-ocean.dark",
            Some(80),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(
            rendered.iter().any(|line| line == "trailing paragraph"),
            "rendered lines: {rendered:?}"
        );
        assert!(
            rendered
                .iter()
                .all(|line| !line.contains("│ trailing paragraph"))
        );
    }

    #[test]
    fn table_spillover_keeps_pipe_syntax_single_cell_row() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| Name | Count |\n| --- | --- |\n| alpha | 1 |\n| sparse |",
            "base16-ocean.dark",
            Some(80),
        );
        let rendered = hyperlink_lines_to_text(&lines);

        assert!(rendered.contains("sparse"));
        assert!(!rendered.contains('│'));
    }

    #[test]
    fn header_only_table_uses_pipe_fallback_when_grid_cannot_fit() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| Alpha | Beta |\n| --- | --- |\n",
            "base16-ocean.dark",
            Some(8),
        );
        let rendered = hyperlink_lines_to_text(&lines);

        assert!(rendered.contains("| Alpha"));
        assert!(rendered.contains("|---|---"));
        assert!(!rendered.contains('│'));
        assert!(lines.iter().all(|line| line.width() <= 8));
    }

    #[test]
    fn table_inside_blockquote_has_quote_prefix() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "> | A | B |\n> |---|---|\n> | 1 | 2 |\n",
            "base16-ocean.dark",
            Some(80),
        );
        let rendered = hyperlink_lines_to_strings(&lines);
        let non_empty_lines = rendered
            .iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();

        assert!(
            non_empty_lines.iter().all(|line| line.starts_with("> ")),
            "rendered lines: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line.contains("=====  =====")),
            "rendered lines: {rendered:?}"
        );
    }

    #[test]
    fn escaped_pipes_render_in_table_cells() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "| Col |\n| --- |\n| a \\| b |\n",
            "base16-ocean.dark",
        );

        assert!(
            hyperlink_lines_to_strings(&lines)
                .iter()
                .any(|line| line.contains("a | b"))
        );
    }

    #[test]
    fn table_falls_back_to_key_value_records_if_grid_cannot_fit() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |\n",
            "base16-ocean.dark",
            Some(20),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(rendered.first().is_some_and(|line| line.contains("c1")));
        assert!(
            rendered
                .iter()
                .any(|line| line.contains("c10") && line.contains("10"))
        );
        assert!(
            !rendered
                .iter()
                .any(|line| line.starts_with('|') || line.contains('━') || line.contains('─'))
        );
    }

    #[test]
    fn table_key_value_fallback_preserves_rich_values_and_themed_labels() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| Key | Content | Extra | More |\n|---|---|---|---|\n| item | [link](https://example.com) | **bold** | `code` |\n",
            "base16-ocean.dark",
            Some(16),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(rendered.iter().any(|line| line.contains("Key")));
        assert!(rendered.iter().any(|line| line.contains("item")));
        assert!(rendered.iter().any(|line| line.contains("link")));
        assert!(rendered.iter().any(|line| line.contains("bold")));
        assert!(rendered.iter().any(|line| line.contains("code")));
        assert!(
            lines
                .iter()
                .flat_map(|line| line.hyperlinks.iter())
                .any(|link| link.destination == "https://example.com")
        );
    }

    #[test]
    fn table_column_classification_uses_alignment_heuristics() {
        let header = vec![test_table_cell("ID"), test_table_cell("Description")];
        let rows = vec![
            vec![
                test_table_cell("1"),
                test_table_cell("a long description of the item"),
            ],
            vec![
                test_table_cell("2"),
                test_table_cell("another verbose body cell here"),
            ],
        ];
        let metrics = collect_table_column_metrics(&header, &rows, 2);

        assert_eq!(metrics[0].kind, TableColumnKind::Compact);
        assert_eq!(metrics[1].kind, TableColumnKind::Narrative);

        let header = vec![test_table_cell("Files")];
        let rows = vec![
            vec![test_table_cell(
                "crates/kcoder_repl/src/markdown.rs:1 crates/kcoder_engine/src/lib.rs:1",
            )],
            vec![test_table_cell(
                "crates/kcoder_tools/src/bash.rs:1 crates/kcoder_state/src/lib.rs:1",
            )],
        ];
        let metrics = collect_table_column_metrics(&header, &rows, 1);

        assert_eq!(metrics[0].kind, TableColumnKind::TokenHeavy);
    }

    #[test]
    fn table_column_shrink_prefers_token_heavy_then_narrative() {
        let widths = [20usize, 20, 20];
        let floors = [8usize, 8, 8];
        let metrics = [
            TableColumnMetrics {
                max_width: 30,
                header_token_width: 8,
                body_token_width: 6,
                kind: TableColumnKind::Narrative,
            },
            TableColumnMetrics {
                max_width: 30,
                header_token_width: 8,
                body_token_width: 28,
                kind: TableColumnKind::TokenHeavy,
            },
            TableColumnMetrics {
                max_width: 30,
                header_token_width: 8,
                body_token_width: 6,
                kind: TableColumnKind::Compact,
            },
        ];

        assert_eq!(next_column_to_shrink(&widths, &floors, &metrics), Some(1));

        let widths = [20usize, 8, 20];
        assert_eq!(next_column_to_shrink(&widths, &floors, &metrics), Some(0));
    }

    #[test]
    fn table_keeps_grid_when_only_one_compact_record_fragments() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| Key | Date | State |\n| --- | --- | --- |\n| short | 2025-01-01 | Ready |\n| verylongidentifier | 2025-02-02 | Ready |\n| final | 2025-03-03 | Done |\n",
            "base16-ocean.dark",
            Some(40),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(
            rendered.iter().any(|line| line.contains('=')),
            "expected grid header separator, got: {rendered:?}"
        );
        assert_eq!(
            rendered.iter().filter(|line| line.contains("Key")).count(),
            1,
            "grid should render the Key header once, got: {rendered:?}"
        );
        assert!(lines.iter().all(|line| line.width() <= 40));
    }

    #[test]
    fn table_renders_stacked_records_when_path_column_becomes_too_narrow() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            r#"| Session | Why useful | Detected table blocks |
| --- | --- | --- |
| [2026-05-25 current gallery](/Users/example/.codex/sessions/2026/05/25/rollout-current-gallery.jsonl) | The large gallery from this thread: emojis, links, emphasis, code, alignment, paragraphs, and a 30+ row table | 7 |
| [2026-05-14 renderer testing](/Users/example/.codex/sessions/2026/05/14/rollout-renderer-testing.jsonl) | Explicit "markdown tables for testing" session with several successive assistant samples | 16 |
| [2026-05-14 five-table test](/Users/example/.codex/sessions/2026/05/14/rollout-five-table-test.jsonl) | Explicit request for five tables containing emojis, code, italics, and varied cell content | 10 |
"#,
            "base16-ocean.dark",
            Some(42),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(
            rendered.iter().all(|line| !line.contains('━')),
            "expected key/value records, got: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line == " Session"),
            "expected stacked Session label, got: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line == " Why useful"),
            "expected stacked Why useful label, got: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line == " Detected table blocks"),
            "expected stacked Detected table blocks label, got: {rendered:?}"
        );
        assert!(lines.iter().all(|line| line.width() <= 42));
    }

    #[test]
    fn table_renders_records_when_multiple_prose_columns_are_starved() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            r#"| Issue | Activity | Complexity | Why start |
| --- | ---: | ---: | --- |
| [#24485: newline shortcut fails in terminal](https://github.com/openai/codex/issues/24485) | `+1` 0, substantive comments 0 | Low | New, deterministic regression range; localized composer/keymap path. |
| [#23926: Vim composer stalls at word end](https://github.com/openai/codex/issues/23926) | `+1` 0, comments 0 | Low | Standing best quick win; deterministic motion bug. |
| [#23651: Zellij scrollback misses transcript](https://github.com/openai/codex/issues/23651) | `+1` 3, human comments 2 | Medium | Clear regression and strong scrollback evidence. |
| [#23740: raw ANSI/control sequences](https://github.com/openai/codex/issues/23740) | `+1` 7, human comments 7 | Medium | Highest activity; established Windows rendering regression family. |
| [#24527: typing lag increases with session length](https://github.com/openai/codex/issues/24527) | `+1` 0, substantive comments 0 | Medium | New TUI-visible performance report; needs profiling before implementation. |
"#,
            "base16-ocean.dark",
            Some(76),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(
            rendered.iter().all(|line| !line.contains('━')),
            "expected key/value records, got: {rendered:?}"
        );
        assert!(
            rendered
                .iter()
                .filter(|line| line.trim_start().starts_with("Issue"))
                .count()
                >= 5,
            "expected repeated Issue fields, got: {rendered:?}"
        );
        assert!(
            rendered
                .iter()
                .any(|line| line.trim_start().starts_with("Why start")),
            "expected Why start field, got: {rendered:?}"
        );
        assert!(lines.iter().all(|line| line.width() <= 76));
    }

    #[test]
    fn table_renders_records_when_compact_fragmentation_is_systemic() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "| Key | Notes |\n| --- | --- |\n| firstlongid | A readable explanatory sentence for this row. |\n| secondlongid | Another readable explanatory sentence for this row. |\n| short | A final readable explanatory sentence for this row. |\n",
            "base16-ocean.dark",
            Some(17),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(
            rendered.iter().all(|line| !line.contains('━')),
            "expected key/value records, got: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line == " Key"),
            "expected stacked Key label, got: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line == " Notes"),
            "expected stacked Notes label, got: {rendered:?}"
        );
        assert!(
            rendered.iter().filter(|line| line == &" Key").count() >= 3,
            "expected one Key field per record, got: {rendered:?}"
        );
        assert!(lines.iter().all(|line| line.width() <= 17));
    }

    #[test]
    fn table_wraps_file_paths_before_collapsing_narrative_columns() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_cwd(
            r#"| Unit | Files | Adds | Removes | What It Adds |
|---|---:|---:|---:|---|
| Suggestion engine and unit coverage | [next_prompt_suggestion.rs](/Users/example/code/codex/codex-rs/core/src/next_prompt_suggestion.rs:1), [next_prompt_suggestion_tests.rs](/Users/example/code/codex/codex-rs/core/src/next_prompt_suggestion_tests.rs:1) | 704 | 0 | Sampling workflow, stable-history checks, tool-flow suppression, fast reasoning profile, filtering rules, cancellation and timeout. |
| Model instruction fragment and contextual isolation | [next_prompt_suggestion.rs](/Users/example/code/codex/codex-rs/core/src/context/next_prompt_suggestion.rs:1), [contextual_user_message_tests.rs](/Users/example/code/codex/codex-rs/core/src/context/contextual_user_message_tests.rs:1) | 54 | 0 | Synthetic suggestion prompt and an isolation test for ordinary user text. |
"#,
            "base16-ocean.dark",
            Some(Path::new("/Users/example/code/codex")),
            Some(120),
        );
        let rendered = hyperlink_lines_to_strings(&lines);

        assert!(
            rendered
                .iter()
                .any(|line| line.contains("Unit") && line.contains("What It Adds")),
            "expected table grid header, got: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line.contains('=')),
            "expected grid separator, got: {rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line.contains("codex-rs/core/")),
            "expected relative file path segment, got: {rendered:?}"
        );
        assert!(
            rendered
                .iter()
                .any(|line| line.contains("next_prompt_sugg")),
            "expected path column to wrap before narrative collapse, got: {rendered:?}"
        );
        assert!(
            rendered
                .iter()
                .any(|line| line.contains("Sampling workflow, stable-history")),
            "expected narrative column to retain readable width, got: {rendered:?}"
        );
        assert!(
            rendered
                .iter()
                .any(|line| line.contains("Synthetic suggestion prompt and an")),
            "expected second narrative value to retain readable width, got: {rendered:?}"
        );
        assert!(lines.iter().all(|line| line.width() <= 120));
    }

    #[test]
    fn table_spillover_detects_html_content() {
        let row = table_body_row(
            vec![test_table_cell("<div>content</div>"), test_table_cell("")],
            false,
        );

        assert!(is_table_spillover_row(&row, None));
    }

    #[test]
    fn table_spillover_detects_label_followed_by_html() {
        let row = table_body_row(
            vec![test_table_cell("HTML block:"), test_table_cell("")],
            false,
        );
        let next = table_body_row(
            vec![test_table_cell("<div>x</div>"), test_table_cell("")],
            false,
        );

        assert!(is_table_spillover_row(&row, Some(&next)));
    }

    #[test]
    fn table_spillover_keeps_sparse_label_when_next_is_not_html() {
        let row = table_body_row(vec![test_table_cell("Status:"), test_table_cell("")], true);
        let next = table_body_row(vec![test_table_cell("ok"), test_table_cell("")], true);

        assert!(!is_table_spillover_row(&row, Some(&next)));
    }

    #[test]
    fn wrapped_table_url_fragments_keep_complete_web_destination() {
        let destination = "https://example.com/a/very/long/path/to/a/table/artifact";
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            &format!("| Item | URL |\n| --- | --- |\n| report | {destination} |\n"),
            "base16-ocean.dark",
            Some(32),
        );
        let linked_rows = lines
            .iter()
            .filter(|line| !line.hyperlinks.is_empty())
            .collect::<Vec<_>>();

        assert!(
            linked_rows.len() > 1,
            "expected URL wrapped across table rows, got: {:?}",
            hyperlink_lines_to_strings(&lines)
        );
        assert!(linked_rows.iter().all(|line| {
            line.hyperlinks
                .iter()
                .all(|link| link.destination == destination)
        }));
        assert!(lines.iter().all(|line| line.width() <= 32));
    }

    #[test]
    fn key_value_table_keeps_web_annotations() {
        let destination = "https://example.com/a/very/long/path";
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            &format!(
                "| c1 | c2 | c3 | c4 | c5 | c6 |\n| --- | --- | --- | --- | --- | --- |\n| {destination} | 2 | 3 | 4 | 5 | 6 |\n"
            ),
            "base16-ocean.dark",
            Some(20),
        );
        let destinations = lines
            .iter()
            .flat_map(|line| line.hyperlinks.iter().map(|link| link.destination.as_str()))
            .collect::<Vec<_>>();

        assert!(!destinations.is_empty());
        assert!(destinations.iter().all(|link| *link == destination));
    }

    #[test]
    fn does_not_annotate_code_or_non_web_markdown_links() {
        let markdown = "`https://example.com/inline`\n\n```text\nhttps://example.com/block\n```\n\n[mail](mailto:test@example.com)\n\n[https://example.com/label](mailto:test@example.com)\n\n| Target |\n| --- |\n| [https://example.com/table-label](mailto:test@example.com) |";
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            markdown,
            "base16-ocean.dark",
            Some(80),
        );

        assert!(lines.iter().all(|line| line.hyperlinks.is_empty()));
    }

    #[test]
    fn pipe_table_fallback_keeps_web_annotations() {
        let destination = "https://example.com/a/long/path";
        let target = "https://target.example/path";
        let code_url = "https://code.example/not-a-link";
        let markdown = format!(
            "| URL | Code | Label |\n| --- | --- | --- |\n| {destination} | `{code_url}` | [https://shown.example]({target}) |\n"
        );
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            &markdown,
            "base16-ocean.dark",
            Some(5),
        );
        let destinations = lines
            .iter()
            .flat_map(|line| line.hyperlinks.iter().map(|link| link.destination.as_str()))
            .collect::<Vec<_>>();

        assert!(destinations.contains(&destination));
        assert!(destinations.contains(&target));
        assert!(!destinations.contains(&code_url));
        assert!(!destinations.contains(&"https://shown.example"));
    }

    #[test]
    fn separates_multiple_paragraphs_with_blank_line() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "Paragraph 1\n\nParagraph 2",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["Paragraph 1", "", "Paragraph 2"]
        );
    }

    #[test]
    fn html_inline_is_verbatim() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "Hello <span>world</span>!",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["Hello <span>world</span>!"]
        );
    }

    #[test]
    fn html_block_is_verbatim_multiline() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "<div>\n  <span>hi</span>\n</div>\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["<div>", "  <span>hi</span>", "</div>"]
        );
    }

    #[test]
    fn html_in_tight_ordered_item_soft_breaks_with_space() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "1. Foo\n   <i>Bar</i>\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["1. Foo", "   <i>Bar</i>"]
        );
    }

    #[test]
    fn html_continuation_paragraph_in_unordered_item_indented() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "- Item\n\n  <em>continued</em>\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["- Item", "", "  <em>continued</em>"]
        );
    }

    #[test]
    fn unordered_item_continuation_paragraph_is_indented() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "- Intro\n\n  Continuation paragraph line 1\n  Continuation paragraph line 2\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "- Intro",
                "",
                "  Continuation paragraph line 1",
                "  Continuation paragraph line 2",
            ]
        );
    }

    #[test]
    fn ordered_item_continuation_paragraph_is_indented() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "1. Intro\n\n   More details about intro\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["1. Intro", "", "   More details about intro"]
        );
    }

    #[test]
    fn nested_item_continuation_paragraph_is_indented() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "1. A\n    - B\n\n      Continuation for B\n2. C\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "1. A",
                "    - B",
                "",
                "      Continuation for B",
                "",
                "2. C",
            ]
        );
    }

    #[test]
    fn horizontal_rule_renders_em_dashes() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "Before\n\n---\n\nAfter\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["Before", "", "———", "", "After"]
        );
    }

    #[test]
    fn wraps_plain_text_when_width_is_provided() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "This is a simple sentence that should wrap.",
            "base16-ocean.dark",
            Some(16),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["This is a simple", "sentence that", "should wrap.",]
        );
    }

    #[test]
    fn wraps_list_items_preserving_indent() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "- first second third fourth",
            "base16-ocean.dark",
            Some(14),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["- first second", "  third fourth"]
        );
    }

    #[test]
    fn wraps_nested_lists_preserving_codex_indent() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "- outer item with several words to wrap\n  - inner item that also needs wrapping",
            "base16-ocean.dark",
            Some(20),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "- outer item with",
                "  several words to",
                "  wrap",
                "    - inner item",
                "      that also",
                "      needs wrapping",
            ]
        );
    }

    #[test]
    fn wraps_ordered_lists_preserving_indent() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "1. ordered item contains many words for wrapping",
            "base16-ocean.dark",
            Some(18),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "1. ordered item",
                "   contains many",
                "   words for",
                "   wrapping",
            ]
        );
    }

    #[test]
    fn wrapped_list_item_is_separated_from_next_sibling() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "1. This item wraps onto another visible rendered line\n2. Next item\n",
            "base16-ocean.dark",
            Some(24),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "1. This item wraps onto",
                "   another visible",
                "   rendered line",
                "",
                "2. Next item",
            ]
        );
    }

    #[test]
    fn nested_five_levels_mixed_lists_keep_codex_indent() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "1. First\n   - Second level\n     1. Third level (ordered)\n        - Fourth level (bullet)\n          - Fifth level to test indent consistency\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "1. First",
                "    - Second level",
                "        1. Third level (ordered)",
                "            - Fourth level (bullet)",
                "                - Fifth level to test indent consistency",
            ]
        );
    }

    #[test]
    fn task_list_markers_render_as_source_text() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "- [ ] Task: unchecked\n- [x] Task: checked\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["- [ ] Task: unchecked", "- [x] Task: checked"]
        );
    }

    #[test]
    fn list_soft_break_uses_continuation_indent() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "- item line1\n  item line2\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["- item line1", "  item line2"]
        );
    }

    #[test]
    fn wraps_blockquotes_preserving_quote_prefix() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "> block quote with content that should wrap nicely",
            "base16-ocean.dark",
            Some(22),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "> block quote with",
                "> content that should",
                "> wrap nicely",
            ]
        );
    }

    #[test]
    fn blockquote_with_list_items_keeps_quote_before_marker() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "> - item 1\n> - item 2\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["> - item 1", "> - item 2"]
        );
    }

    #[test]
    fn blockquote_list_then_nested_blockquote_preserves_context_order() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "> - parent\n>   > child\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["> - parent", ">   > child"]
        );
    }

    #[test]
    fn blockquote_in_ordered_list_on_next_line_stays_on_marker_line() {
        let lines =
            render_markdown_hyperlink_lines_with_theme("1.\n   > quoted\n", "base16-ocean.dark");

        assert_eq!(hyperlink_lines_to_strings(&lines), vec!["1. > quoted"]);
    }

    #[test]
    fn blockquote_in_unordered_list_on_next_line_stays_on_marker_line() {
        let lines =
            render_markdown_hyperlink_lines_with_theme("-\n  > quoted\n", "base16-ocean.dark");

        assert_eq!(hyperlink_lines_to_strings(&lines), vec!["- > quoted"]);
    }

    #[test]
    fn blockquote_two_paragraphs_inside_ordered_list_keeps_blank_quote_line() {
        let lines = render_markdown_hyperlink_lines_with_theme(
            "1.\n   > para 1\n   >\n   > para 2\n",
            "base16-ocean.dark",
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec!["1. > para 1", "   > ", "   > para 2"]
        );
    }

    #[test]
    fn wraps_blockquotes_inside_lists_preserving_codex_indent() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "- list item\n  > block quote inside list that wraps",
            "base16-ocean.dark",
            Some(24),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "- list item",
                "  > block quote inside",
                "  > list that wraps",
            ]
        );
    }

    #[test]
    fn wraps_list_items_containing_blockquotes_preserving_codex_indent() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "1. item with quote\n   > quoted text that should wrap",
            "base16-ocean.dark",
            Some(24),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines),
            vec![
                "1. item with quote",
                "   > quoted text that",
                "   > should wrap",
            ]
        );
    }

    #[test]
    fn width_wrapping_does_not_wrap_code_blocks() {
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            "````\nfn main() { println!(\"hi from a long line\"); }\n````",
            "base16-ocean.dark",
            Some(10),
        );

        assert!(
            hyperlink_lines_to_text(&lines)
                .contains("fn main() { println!(\"hi from a long line\"); }")
        );
    }

    #[test]
    fn width_wrapping_does_not_split_long_url_like_token() {
        let url_like =
            "example.test/api/v1/projects/alpha-team/releases/2026-02-17/builds/1234567890";
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            url_like,
            "base16-ocean.dark",
            Some(24),
        );

        assert_eq!(
            hyperlink_lines_to_strings(&lines)
                .iter()
                .filter(|line| line.contains(url_like))
                .count(),
            1
        );
    }

    #[test]
    fn width_wrapping_preserves_hyperlink_destinations() {
        let destination = "https://example.com/docs";
        let lines = render_markdown_hyperlink_lines_with_theme_and_width(
            &format!("Before [docs]({destination}) after wrapping"),
            "base16-ocean.dark",
            Some(18),
        );

        assert!(
            lines
                .iter()
                .flat_map(|line| line.hyperlinks.iter())
                .any(
                    |link| link.destination == destination && link.columns.end > link.columns.start
                )
        );
        assert!(hyperlink_lines_to_text(&lines).contains("docs"));
    }

    #[test]
    fn warm_up_initializes_resources() {
        warm_up("base16-ocean.dark");
        assert!(
            crate::render::highlight::highlight_code_to_styled_spans_with_theme(
                "let x = 1;",
                "rust",
                "base16-ocean.dark"
            )
            .is_some()
        );
    }

    #[test]
    #[ignore = "manual performance benchmark"]
    fn active_markdown_streaming_benchmark() {
        let mut markdown = String::new();
        for idx in 0..400 {
            markdown.push_str(&format!(
                "## Section {idx}\n\n- item one\n- item two\n\n```rust\nfn sample_{idx}() -> usize {{\n    (0..128).sum()\n}}\n```\n\n"
            ));
        }

        warm_up("base16-ocean.dark");
        let started = std::time::Instant::now();
        let lines = render_markdown_with_theme(&markdown, "base16-ocean.dark");
        let elapsed = started.elapsed();

        eprintln!(
            "active_markdown_streaming_benchmark: {} input bytes, {} rendered lines, elapsed={elapsed:?}",
            markdown.len(),
            lines.len()
        );
        assert!(lines.len() > 400);
    }

    fn lines_to_text(lines: &[Line<'_>]) -> String {
        lines.iter().map(line_text).collect::<Vec<_>>().join("\n")
    }

    fn line_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    fn hyperlink_lines_to_text(lines: &[HyperlinkLine]) -> String {
        lines
            .iter()
            .map(hyperlink_line_text)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn hyperlink_lines_to_strings(lines: &[HyperlinkLine]) -> Vec<String> {
        lines.iter().map(hyperlink_line_text).collect()
    }

    fn hyperlink_line_text(line: &HyperlinkLine) -> String {
        line.line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    fn test_table_cell(text: &str) -> TableCell {
        let mut cell = TableCell::default();
        cell.spans.push(Span::raw(text.to_string()));
        cell
    }

    fn table_body_row(cells: Vec<TableCell>, has_table_pipe_syntax: bool) -> TableBodyRow {
        TableBodyRow {
            cells,
            has_table_pipe_syntax,
        }
    }

    fn text_column_range(text: &str, needle: &str) -> std::ops::Range<usize> {
        let start_byte = text.find(needle).expect("needle should be present");
        let start = unicode_width::UnicodeWidthStr::width(&text[..start_byte]);
        start..start + unicode_width::UnicodeWidthStr::width(needle)
    }
