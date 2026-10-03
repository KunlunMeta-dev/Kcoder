//! Offline HTML text extraction. Never renders markup, executes JS or follows URLs.
use super::{MAX_EXTRACTED_BYTES, decode_text, error};
use crate::ToolError;
use html5ever::{
    tendril::StrTendril,
    tokenizer::{
        BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
        states::RawKind,
    },
};
use std::cell::RefCell;

#[derive(Default)]
struct Output {
    text: String,
    stack: Vec<(String, bool)>,
    tokens: usize,
    failed: bool,
}
impl Output {
    fn visible(&self) -> bool {
        !self.stack.iter().any(|(_, hidden)| *hidden)
    }
    fn add(&mut self, text: &str) {
        if self.failed {
            return;
        }
        let pre = self.stack.iter().any(|(tag, _)| tag == "pre");
        for c in text.chars() {
            if self.text.len() + c.len_utf8() > MAX_EXTRACTED_BYTES {
                self.failed = true;
                break;
            }
            if pre || !c.is_whitespace() {
                self.text.push(c);
            } else if !self.text.is_empty() && !self.text.ends_with([' ', '\n', '\t']) {
                self.text.push(' ');
            }
        }
    }
    fn separator(&mut self, c: char) {
        if !self.text.ends_with(c) && !self.text.is_empty() {
            self.text.push(c);
        }
        self.failed |= self.text.len() > MAX_EXTRACTED_BYTES;
    }
}
#[derive(Default)]
struct Sink(RefCell<Output>);
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let mut out = self.0.borrow_mut();
        out.tokens += 1;
        if out.tokens > 1_000_000 {
            out.failed = true;
        }
        if out.failed {
            return TokenSinkResult::Continue;
        }
        match token {
            Token::CharacterTokens(text) if out.visible() => out.add(&text),
            Token::NullCharacterToken => out.failed = true,
            Token::TagToken(tag) => {
                let name = tag.name.to_string();
                let block = matches!(
                    name.as_str(),
                    "title"
                        | "p"
                        | "div"
                        | "section"
                        | "article"
                        | "header"
                        | "footer"
                        | "main"
                        | "nav"
                        | "aside"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                        | "ul"
                        | "ol"
                        | "li"
                        | "table"
                        | "tr"
                        | "pre"
                        | "blockquote"
                        | "dl"
                        | "dt"
                        | "dd"
                        | "br"
                        | "hr"
                );
                if tag.kind == TagKind::EndTag {
                    if let Some(index) = out.stack.iter().rposition(|(value, _)| *value == name) {
                        out.stack.truncate(index);
                    }
                    if out.visible() {
                        if block {
                            out.separator('\n');
                        } else if matches!(name.as_str(), "td" | "th") {
                            out.separator('\t');
                        }
                    }
                    return TokenSinkResult::Continue;
                }
                // Common optional end tags must not cause unbounded nesting.
                if matches!(name.as_str(), "p" | "li" | "tr" | "td" | "th" | "body") {
                    if let Some(index) = out.stack.iter().rposition(|(value, _)| {
                        *value == name || (name == "body" && value == "head")
                    }) {
                        out.stack.truncate(index);
                    }
                }
                if out.visible() && block {
                    out.separator('\n');
                }
                let hidden = matches!(
                    name.as_str(),
                    "script"
                        | "style"
                        | "template"
                        | "noscript"
                        | "iframe"
                        | "object"
                        | "svg"
                        | "canvas"
                        | "noembed"
                        | "noframes"
                ) || tag.attrs.iter().any(|a| {
                    a.name.local.as_ref() == "hidden"
                        || (a.name.local.as_ref() == "aria-hidden"
                            && a.value.eq_ignore_ascii_case("true"))
                        || (a.name.local.as_ref() == "style" && {
                            let style = a
                                .value
                                .chars()
                                .filter(|c| !c.is_whitespace())
                                .collect::<String>()
                                .to_ascii_lowercase();
                            style.contains("display:none") || style.contains("visibility:hidden")
                        })
                });
                if name == "img" && out.visible() && !hidden {
                    if let Some(alt) = tag.attrs.iter().find(|a| a.name.local.as_ref() == "alt") {
                        out.add(&alt.value);
                        out.add(" ");
                    }
                }
                if name == "li" && out.visible() && !hidden {
                    out.add("- ");
                }
                let void = matches!(
                    name.as_str(),
                    "area"
                        | "base"
                        | "br"
                        | "col"
                        | "embed"
                        | "hr"
                        | "img"
                        | "input"
                        | "link"
                        | "meta"
                        | "param"
                        | "source"
                        | "track"
                        | "wbr"
                );
                if !void {
                    if out.stack.len() >= 256 {
                        out.failed = true;
                        return TokenSinkResult::Continue;
                    }
                    out.stack.push((name.clone(), hidden));
                }
                match name.as_str() {
                    "script" => return TokenSinkResult::RawData(RawKind::ScriptData),
                    "style" | "iframe" | "noembed" | "noframes" => {
                        return TokenSinkResult::RawData(RawKind::Rawtext);
                    }
                    "title" | "textarea" => return TokenSinkResult::RawData(RawKind::Rcdata),
                    _ => {}
                }
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

#[derive(Default)]
struct CharsetSink(RefCell<Option<String>>);
impl TokenSink for CharsetSink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        if let Token::TagToken(tag) = token {
            if tag.kind == TagKind::StartTag {
                match tag.name.as_ref() {
                    "script" => return TokenSinkResult::RawData(RawKind::ScriptData),
                    "style" => return TokenSinkResult::RawData(RawKind::Rawtext),
                    "meta" if self.0.borrow().is_none() => {
                        if let Some(value) = tag
                            .attrs
                            .iter()
                            .find(|a| a.name.local.as_ref() == "charset")
                        {
                            *self.0.borrow_mut() = Some(value.value.to_string());
                        } else if tag.attrs.iter().any(|a| {
                            a.name.local.as_ref() == "http-equiv"
                                && a.value.eq_ignore_ascii_case("content-type")
                        }) {
                            if let Some(value) = tag
                                .attrs
                                .iter()
                                .find(|a| a.name.local.as_ref() == "content")
                            {
                                let value = value.value.to_ascii_lowercase();
                                if let Some((_, label)) = value.split_once("charset=") {
                                    *self.0.borrow_mut() = Some(
                                        label
                                            .trim()
                                            .split([';', ' ', '\t'])
                                            .next()
                                            .unwrap_or("")
                                            .to_owned(),
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        TokenSinkResult::Continue
    }
}
fn decode(bytes: &[u8]) -> Result<String, ToolError> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return decode_text(bytes);
    }
    // HTML metadata can declare legacy Chinese encodings without changing TXT rules.
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]);
    let queue = BufferQueue::default();
    queue.push_back(StrTendril::from_slice(&head));
    let tokenizer = Tokenizer::new(CharsetSink::default(), TokenizerOpts::default());
    let _ = tokenizer.feed(&queue);
    tokenizer.end();
    let charset = tokenizer.sink.0.into_inner();
    if !bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        if let Some(label) = charset {
            let encoding = encoding_rs::Encoding::for_label(label.trim().as_bytes())
                .ok_or_else(|| error("Unsupported HTML charset"))?;
            let (text, _, invalid) = encoding.decode(bytes);
            if invalid {
                return Err(error("Invalid HTML text encoding"));
            }
            return Ok(text.into_owned());
        }
    }
    decode_text(bytes)
}

pub(super) fn extract(bytes: &[u8]) -> Result<String, ToolError> {
    let text = decode(bytes)?;
    let tokenizer = Tokenizer::new(Sink::default(), TokenizerOpts::default());
    let queue = BufferQueue::default();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + 4096).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        queue.push_back(StrTendril::from_slice(&text[start..end]));
        let _ = tokenizer.feed(&queue);
        if tokenizer.sink.0.borrow().failed {
            return Err(error(
                "HTML extracted text or parsing complexity exceeds limit; document was not truncated",
            ));
        }
        start = end;
    }
    tokenizer.end();
    let output = tokenizer.sink.0.into_inner();
    if output.failed {
        return Err(error("HTML extraction exceeds limit"));
    }
    if output.text.trim().is_empty() {
        return Err(error(
            "HTML has no extractable text; scripts and external resources were not executed",
        ));
    }
    Ok(output.text.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_html_entities_structure_and_excludes_active_or_hidden_content() {
        let html = r#"<!doctype html><title>中文 &amp; 标题</title><style>.x{}</style><script>if(a<b){evil()}</script><h1>Heading</h1><ul><li>One<li>Two</ul><table><tr><td>A &lt; B</td><td>42</td></tr></table><div hidden>PRIVATE</div><span style='display: none'>HIDDEN</span><template>NO</template><img src='https://invalid.example/image' alt='diagram'><pre>a\n  b</pre>"#;
        let text = extract(html.as_bytes()).unwrap();
        for part in [
            "中文 & 标题",
            "Heading",
            "- One",
            "- Two",
            "A < B",
            "42",
            "diagram",
        ] {
            assert!(text.contains(part), "missing {part}: {text}");
        }
        for excluded in [
            "evil()",
            "PRIVATE",
            "HIDDEN",
            "NO",
            ".x{}",
            "invalid.example",
        ] {
            assert!(!text.contains(excluded));
        }
    }
    #[test]
    fn declared_gbk_and_bom_utf16_are_strictly_decoded() {
        let input = "<meta charset=gbk><p>中文资料</p>";
        let (bytes, _, invalid) = encoding_rs::GBK.encode(input);
        assert!(!invalid);
        assert_eq!(extract(&bytes).unwrap(), "中文资料");
        let bytes = [0xff, 0xfe]
            .into_iter()
            .chain("<p>正文</p>".encode_utf16().flat_map(u16::to_le_bytes))
            .collect::<Vec<_>>();
        assert_eq!(extract(&bytes).unwrap(), "正文");
        assert!(extract(b"<meta charset=unknown><p>x</p>").is_err());
        assert!(extract(b"<script>only code</script>").is_err());
        assert_eq!(
            extract(b"<!-- <meta charset=unknown> --><p>Evidence</p>").unwrap(),
            "Evidence"
        );
        assert_eq!(
            extract(b"<script>var tag='<meta charset=unknown>';</script><p>Evidence</p>").unwrap(),
            "Evidence"
        );
        assert!(extract("<p>x".repeat(300).as_bytes()).is_ok());
        assert!(extract("<div>".repeat(300).as_bytes()).is_err());
    }
}
