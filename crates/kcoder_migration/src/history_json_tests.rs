use super::*;
use std::io::Cursor;

struct Fragmented<'a> {
    bytes: &'a [u8],
    maximum: usize,
}
impl Read for Fragmented<'_> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = self.bytes.len().min(output.len()).min(self.maximum);
        output[..count].copy_from_slice(&self.bytes[..count]);
        self.bytes = &self.bytes[count..];
        Ok(count)
    }
}

#[test]
fn strings_decode_utf8_escapes_and_surrogates_across_input_fragments() {
    for encoded in [
        r#"{"payload":{"content":[{"type":"text","text":"hello 中文 👩‍💻 é"}]}}"#,
        r#"{"payload":{"content":[{"type":"text","text":"\u4e2d\u6587 \ud83d\ude00 \"\\\/\b\f\n\r\t\u0000"}]}}"#,
    ] {
        for maximum in 1..=17 {
            let mut text = None;
            walk(
                Fragmented {
                    bytes: encoded.as_bytes(),
                    maximum,
                },
                |path, node| {
                    if matches!(path.last(), Some(Segment::Key(key)) if key == "text") {
                        let Value::String(value) = node.value else {
                            panic!("expected string");
                        };
                        let expected: String = serde_json::from_slice(
                            &encoded.as_bytes()[node.span.start as usize..node.span.end as usize],
                        )
                        .unwrap();
                        assert_eq!(value.preview, expected);
                        assert_eq!(value.bytes, expected.len() as u64);
                        assert_eq!(
                            value.sha256,
                            format!("{:x}", Sha256::digest(expected.as_bytes()))
                        );
                        text = Some(path.to_vec());
                    }
                    Ok(())
                },
                |_| true,
            )
            .unwrap();
            assert_eq!(
                text.unwrap(),
                [
                    Segment::Key("payload".into()),
                    Segment::Key("content".into()),
                    Segment::Index(0),
                    Segment::Key("text".into())
                ]
            );
        }
    }
}

#[test]
fn trimmed_edges_are_bounded_exact_utf8_slices_across_whitespace_and_escapes() {
    for text in [
        "  short body  ".into(),
        format!(
            "{}short body{}",
            "\u{2003}".repeat(3000),
            "\u{2003}".repeat(3000)
        ),
        format!("a{}z", " ".repeat(600)),
        format!(
            "{}<environment_context>{}</environment_context>{}",
            "\u{2003}".repeat(3000),
            "😀".repeat(3000),
            "\u{2003}".repeat(3000)
        ),
        format!("ab{}cd", "\t\n\u{2003}".repeat(3000)),
        format!("{}😀YZ", "x".repeat(511)),
        format!("😀{}", "x".repeat(511)),
        " \t\n\u{2003}".repeat(3000),
    ] {
        let raw = serde_json::to_string(&text).unwrap();
        for encoded in [
            raw.clone(),
            raw.replace('😀', "\\ud83d\\ude00")
                .replace('\u{2003}', "\\u2003"),
        ] {
            for maximum in [1, 3, 17, 65536] {
                walk(
                    Fragmented {
                        bytes: encoded.as_bytes(),
                        maximum,
                    },
                    |_, node| {
                        let Value::String(value) = node.value else {
                            panic!("string expected")
                        };
                        let trimmed = text.trim();
                        assert!(trimmed.starts_with(&value.trimmed_head));
                        assert!(trimmed.ends_with(&value.trimmed_tail));
                        assert!(value.trimmed_head.len() <= 512 && value.trimmed_tail.len() <= 512);
                        if trimmed.len() <= 512 {
                            assert_eq!(value.trimmed_head, trimmed);
                            assert_eq!(value.trimmed_tail, trimmed);
                        } else {
                            assert!(value.trimmed_head.len() >= 509);
                            assert!(value.trimmed_tail.len() >= 509);
                        }
                        assert!(text.starts_with(&value.preview));
                        assert_eq!(value.bytes, text.len() as u64);
                        assert_eq!(
                            value.sha256,
                            format!("{:x}", Sha256::digest(text.as_bytes()))
                        );
                        Ok(())
                    },
                    |_| true,
                )
                .unwrap();
            }
        }
    }
}

struct LargeString {
    prefix: Cursor<&'static [u8]>,
    remaining: usize,
    suffix: Cursor<&'static [u8]>,
    maximum_read: usize,
}

#[test]
fn bounded_previews_stay_a_true_prefix_when_a_multibyte_character_does_not_fit() {
    for (prefix, tail) in [("x".repeat(4095), "😀YZ"), ("x".repeat(4094), "中文YZ")] {
        let full = format!("{prefix}{tail}");
        let raw = serde_json::to_string(&full).unwrap();
        for encoded in [raw.clone(), raw.replace('😀', "\\ud83d\\ude00")] {
            for maximum in [1, 2, 3, 17, 65536] {
                walk(
                    Fragmented {
                        bytes: encoded.as_bytes(),
                        maximum,
                    },
                    |_, node| {
                        let Value::String(value) = node.value else {
                            panic!("expected string")
                        };
                        assert!(
                            value.preview == prefix,
                            "truncated previews must not skip a character and append later text"
                        );
                        assert_eq!(value.bytes, full.len() as u64);
                        assert_eq!(
                            value.sha256,
                            format!("{:x}", Sha256::digest(full.as_bytes()))
                        );
                        Ok(())
                    },
                    |_| true,
                )
                .unwrap();
            }
        }
    }
}
impl Read for LargeString {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.maximum_read = self.maximum_read.max(output.len());
        let count = self.prefix.read(output)?;
        if count > 0 {
            return Ok(count);
        }
        if self.remaining > 0 {
            let count = self.remaining.min(output.len());
            output[..count].fill(b'x');
            self.remaining -= count;
            return Ok(count);
        }
        self.suffix.read(output)
    }
}

#[test]
fn a_large_string_is_hashed_without_collecting_its_body() {
    let size = 8 * 1024 * 1024;
    let mut source = LargeString {
        prefix: Cursor::new(b"{\"text\":\""),
        remaining: size,
        suffix: Cursor::new(b"\"}"),
        maximum_read: 0,
    };
    let mut observed = None;
    walk(
        &mut source,
        |path, node| {
            if path == [Segment::Key("text".into())] {
                let Value::String(text) = node.value else {
                    panic!("expected string");
                };
                observed = Some((text, node.span));
            }
            Ok(())
        },
        |_| true,
    )
    .unwrap();
    let (text, span) = observed.unwrap();
    assert_eq!(text.bytes, size as u64);
    assert_eq!(text.preview.len(), PREVIEW_BYTES);
    assert_eq!(
        span,
        Span {
            start: 8,
            end: size as u64 + 10
        }
    );
    assert!(source.maximum_read <= 64 * 1024);
}

#[test]
fn malformed_or_ambiguous_json_is_rejected_without_source_excerpts() {
    let cases: &[&[u8]] = &[
        b"{",
        b"{\"a\":}",
        b"[1,]",
        b"{\"a\":1,}",
        b"{\"a\":0,\"\\u0061\":1}",
        b"\"\\uD800\"",
        b"\"\\uDC00\"",
        b"\"\\uD800\\u0041\"",
        b"\"\\x\"",
        b"\"\xff\"",
        b"\"\n\"",
        b"[01]",
        b"1.",
        b"1e",
        b"-.1",
        b"true false",
    ];
    for bytes in cases {
        assert!(
            walk(&bytes[..], |_, _| Ok(()), |_| true).is_err(),
            "{bytes:?}"
        );
    }
    let error = walk(
        &b"{\"PRIVATE-CANARY\":\"bad\\x\"}"[..],
        |_, _| Ok(()),
        |_| true,
    )
    .err()
    .unwrap();
    assert!(!format!("{error:#}").contains("PRIVATE-CANARY"));
    let nested = format!(
        "{}0{}",
        "[".repeat(MAX_DEPTH + 2),
        "]".repeat(MAX_DEPTH + 2)
    );
    assert!(walk(nested.as_bytes(), |_, _| Ok(()), |_| true).is_err());
    let key = format!("{{\"{}\":0}}", "x".repeat(KEY_BYTES as usize + 1));
    assert!(walk(key.as_bytes(), |_, _| Ok(()), |_| true).is_err());
}

#[test]
fn scalars_and_containers_retain_their_original_spans() {
    let source = br#"[null,true,false,-0,1.25e+3,{"key":[2]}]"#;
    let mut spans = Vec::new();
    walk(
        &source[..],
        |_, node| {
            spans.push((
                node.span,
                match node.value {
                    Value::Null => "null".into(),
                    Value::Bool(value) => value.to_string(),
                    Value::Number(value) => value,
                    Value::Object => "object".into(),
                    Value::Array => "array".into(),
                    Value::String(_) => "string".into(),
                },
            ));
            Ok(())
        },
        |_| true,
    )
    .unwrap();
    assert_eq!(
        spans.last().unwrap().0,
        Span {
            start: 0,
            end: source.len() as u64
        }
    );
    for (span, _) in spans {
        serde_json::from_slice::<serde_json::Value>(
            &source[span.start as usize..span.end as usize],
        )
        .unwrap();
    }
}

#[test]
fn cancellation_is_checked_while_scanning_one_unfinished_long_string() {
    let mut source = LargeString {
        prefix: Cursor::new(b"\""),
        remaining: 8 * 1024 * 1024,
        suffix: Cursor::new(b"\""),
        maximum_read: 0,
    };
    let result = walk(&mut source, |_, _| Ok(()), |bytes| bytes < 128 * 1024);
    assert!(format!("{:#}", result.err().unwrap()).contains("history_json_cancelled"));
    assert!(source.remaining > 7 * 1024 * 1024);
}
