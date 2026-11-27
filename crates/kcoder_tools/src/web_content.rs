//! Bounded HTML parsing and strict text decoding; never executes page content.
use crate::DocumentParseError;
use html5ever::{
    tendril::StrTendril,
    tokenizer::{
        BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
        states::RawKind,
    },
};
use std::cell::RefCell;
use url::Url;

pub const PARSER_VERSION: u32 = 2;
const MAX_CONTENT: usize = 100_000;
const MAX_NODES: usize = 100_000;

#[derive(Clone, Debug)]
pub struct PageContent {
    pub title: String,
    pub markdown: String,
    pub state: &'static str,
    pub truncated: bool,
    pub encoding: String,
}

#[derive(Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<usize>,
}
#[derive(Default)]
struct Tree {
    nodes: Vec<Node>,
    stack: Vec<usize>,
    truncated: bool,
    charset: Option<String>,
}
struct Sink(RefCell<Tree>);
impl Default for Sink {
    fn default() -> Self {
        Self(RefCell::new(Tree {
            nodes: vec![Node::default()],
            stack: vec![0],
            ..Tree::default()
        }))
    }
}
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let mut tree = self.0.borrow_mut();
        if tree.nodes.len() >= MAX_NODES {
            tree.truncated = true;
            return TokenSinkResult::Continue;
        }
        match token {
            Token::CharacterTokens(text) => {
                let parent = *tree.stack.last().unwrap();
                let index = tree.nodes.len();
                tree.nodes.push(Node {
                    text: text.to_string(),
                    ..Node::default()
                });
                tree.nodes[parent].children.push(index);
            }
            Token::TagToken(tag) => {
                let name = tag.name.to_string();
                if tag.kind == TagKind::EndTag {
                    if let Some(index) =
                        tree.stack.iter().rposition(|i| tree.nodes[*i].name == name)
                    {
                        tree.stack.truncate(index.max(1));
                    }
                    return TokenSinkResult::Continue;
                }
                if matches!(name.as_str(), "p" | "li" | "tr" | "td" | "th" | "body")
                    && let Some(index) = tree.stack.iter().rposition(|i| {
                        tree.nodes[*i].name == name
                            || (name == "body" && tree.nodes[*i].name == "head")
                    })
                {
                    tree.stack.truncate(index.max(1));
                }
                let attrs: Vec<_> = tag
                    .attrs
                    .iter()
                    .map(|a| (a.name.local.to_string(), a.value.to_string()))
                    .collect();
                if name == "meta" && tree.charset.is_none() {
                    tree.charset = attrs
                        .iter()
                        .find(|(n, _)| n == "charset")
                        .map(|(_, v)| v.clone())
                        .or_else(|| {
                            if attrs.iter().any(|(n, v)| {
                                n == "http-equiv" && v.eq_ignore_ascii_case("content-type")
                            }) {
                                attrs
                                    .iter()
                                    .find(|(n, _)| n == "content")
                                    .and_then(|(_, v)| charset(v))
                            } else {
                                None
                            }
                        });
                }
                let parent = *tree.stack.last().unwrap();
                let index = tree.nodes.len();
                tree.nodes.push(Node {
                    name: name.clone(),
                    attrs,
                    ..Node::default()
                });
                tree.nodes[parent].children.push(index);
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
                if !(void || tag.self_closing && matches!(name.as_str(), "svg" | "math" | "path")) {
                    if tree.stack.len() >= 128 {
                        tree.truncated = true;
                        return TokenSinkResult::Continue;
                    }
                    tree.stack.push(index);
                }
                return match name.as_str() {
                    "script" => TokenSinkResult::RawData(RawKind::ScriptData),
                    "style" | "iframe" | "noembed" | "noframes" => {
                        TokenSinkResult::RawData(RawKind::Rawtext)
                    }
                    "title" | "textarea" => TokenSinkResult::RawData(RawKind::Rcdata),
                    _ => TokenSinkResult::Continue,
                };
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

fn parse(text: &str) -> Tree {
    let tokenizer = Tokenizer::new(Sink::default(), TokenizerOpts::default());
    let queue = BufferQueue::default();
    queue.push_back(StrTendril::from_slice(text));
    let _ = tokenizer.feed(&queue);
    tokenizer.end();
    tokenizer.sink.0.into_inner()
}

fn charset(content_type: &str) -> Option<String> {
    content_type
        .split(';')
        .skip(1)
        .filter_map(|p| p.trim().split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("charset"))
        .map(|(_, v)| v.trim().trim_matches(['\'', '"']).to_owned())
}
fn decode(bytes: &[u8], content_type: &str) -> Result<(String, String), DocumentParseError> {
    let (bom, skip) = encoding_rs::Encoding::for_bom(bytes)
        .map(|(e, n)| (Some(e), n))
        .unwrap_or((None, 0));
    let metadata = if bom.is_none() && charset(content_type).is_none() {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
        parse(&head).charset
    } else {
        None
    };
    let label = charset(content_type).or(metadata);
    let encoding = match bom {
        Some(encoding) => encoding,
        None => match label {
            Some(label) => encoding_rs::Encoding::for_label(label.as_bytes())
                .ok_or_else(|| DocumentParseError("Unsupported page character encoding".into()))?,
            None => encoding_rs::UTF_8,
        },
    };
    let text = encoding.decode_without_bom_handling_and_without_replacement(&bytes[skip..]).ok_or_else(||DocumentParseError("Page character decoding failed; source bytes were not replaced with fabricated text".into()))?;
    Ok((text.into_owned(), encoding.name().to_owned()))
}
fn hidden(node: &Node) -> bool {
    matches!(
        node.name.as_str(),
        "script"
            | "style"
            | "template"
            | "noscript"
            | "iframe"
            | "object"
            | "svg"
            | "math"
            | "canvas"
            | "head"
            | "nav"
            | "footer"
            | "aside"
    ) || node.attrs.iter().any(|(name, value)| {
        name == "hidden"
            || (name == "aria-hidden" && value.eq_ignore_ascii_case("true"))
            || (name == "style" && {
                let value = value
                    .split_whitespace()
                    .collect::<String>()
                    .to_ascii_lowercase();
                value.contains("display:none") || value.contains("visibility:hidden")
            })
    })
}

fn visible_path(tree: &Tree, root: usize, matches: &impl Fn(&Node) -> bool) -> Option<Vec<usize>> {
    fn visit(
        tree: &Tree,
        index: usize,
        matches: &impl Fn(&Node) -> bool,
        path: &mut Vec<usize>,
    ) -> bool {
        let node = &tree.nodes[index];
        if hidden(node) {
            return false;
        }
        path.push(index);
        if matches(node) {
            return true;
        }
        for &child in &node.children {
            if visit(tree, child, matches, path) {
                return true;
            }
        }
        path.pop();
        false
    }
    let mut path = Vec::new();
    visit(tree, root, matches, &mut path).then_some(path)
}

fn heading_level(node: &Node) -> Option<u8> {
    match node.name.as_bytes() {
        [b'h', level @ b'1'..=b'6'] => Some(*level - b'0'),
        _ => None,
    }
}

/// Select only visible document content; matching a hidden descendant must not
/// reveal text that ordinary rendering deliberately excluded.
fn fragment_nodes(tree: &Tree, root: usize, fragment: &str) -> Option<Vec<usize>> {
    let decoded = percent_encoding::percent_decode_str(fragment)
        .decode_utf8()
        .ok()?;
    let path = visible_path(tree, root, &|node| {
        node.attrs.iter().any(|(key, value)| {
            (key == "id" || node.name == "a" && key == "name") && value == decoded.as_ref()
        })
    })?;
    let matched = *path.last()?;
    if matches!(
        tree.nodes[matched].name.as_str(),
        "section" | "article" | "div" | "dl" | "li"
    ) {
        return Some(vec![matched]);
    }
    if let Some(&section) = path
        .iter()
        .rev()
        .skip(1)
        .find(|&&index| matches!(tree.nodes[index].name.as_str(), "section" | "dl" | "li"))
    {
        return Some(vec![section]);
    }
    if let Some(position) = path
        .iter()
        .rposition(|&index| heading_level(&tree.nodes[index]).is_some())
        && position > 0
    {
        let heading = path[position];
        let level = heading_level(&tree.nodes[heading])?;
        let siblings = &tree.nodes[path[position - 1]].children;
        let start = siblings.iter().position(|&index| index == heading)?;
        let end = siblings
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, index)| {
                heading_level(&tree.nodes[**index]).is_some_and(|next| next <= level)
            })
            .map_or(siblings.len(), |(index, _)| index);
        return Some(siblings[start..end].to_vec());
    }
    Some(vec![matched])
}
fn plain(tree: &Tree, index: usize) -> String {
    let node = &tree.nodes[index];
    if matches!(node.name.as_str(), "script" | "style" | "template") {
        return String::new();
    }
    let mut text = node.text.clone();
    for &child in &node.children {
        text.push_str(&plain(tree, child));
    }
    text
}
fn block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "section"
            | "article"
            | "main"
            | "header"
            | "dl"
            | "dt"
            | "dd"
            | "ul"
            | "ol"
            | "blockquote"
    )
}
fn inline_text(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            if matches!(c, '\\' | '*' | '_' | '[' | ']' | '`' | '|' | '#') {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out
}
fn children(tree: &Tree, index: usize, base: &Url, out: &mut String) {
    for &child in &tree.nodes[index].children {
        if out.len() > MAX_CONTENT {
            break;
        }
        render(tree, child, base, out);
    }
}
fn render(tree: &Tree, index: usize, base: &Url, out: &mut String) {
    if out.len() > MAX_CONTENT {
        return;
    }
    let node = &tree.nodes[index];
    if hidden(node) {
        return;
    }
    if node.name.is_empty() {
        out.push_str(&inline_text(&node.text));
        children(tree, index, base, out);
        return;
    }
    match node.name.as_str() {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            out.push_str("\n\n");
            out.push_str(&"#".repeat(node.name.as_bytes()[1] as usize - b'0' as usize));
            out.push(' ');
            children(tree, index, base, out);
            out.push_str("\n\n");
        }
        "pre" => {
            let text = plain(tree, index);
            let mut fence = "```".to_string();
            while text.contains(&fence) {
                fence.push('`');
            }
            out.push_str(&format!(
                "\n\n{fence}\n{}\n{fence}\n\n",
                text.trim_matches('\n')
            ));
        }
        "code" => {
            let text = plain(tree, index);
            let mut fence = "`".to_owned();
            while text.contains(&fence) {
                fence.push('`');
            }
            out.push_str(&format!("{fence} {} {fence}", text.trim()));
        }
        "li" => {
            out.push_str("\n- ");
            children(tree, index, base, out);
        }
        "br" => out.push_str("  \n"),
        "hr" => out.push_str("\n\n---\n\n"),
        "a" => {
            let href = node
                .attrs
                .iter()
                .find(|(n, _)| n == "href")
                .and_then(|(_, v)| base.join(v).ok())
                .filter(|u| {
                    matches!(u.scheme(), "http" | "https")
                        && u.username().is_empty()
                        && u.password().is_none()
                });
            if let Some(href) = href {
                out.push('[');
                children(tree, index, base, out);
                out.push_str("](<");
                out.push_str(href.as_str());
                out.push_str(">)");
            } else {
                children(tree, index, base, out);
            }
        }
        "img" => {
            if let Some((_, alt)) = node.attrs.iter().find(|(n, _)| n == "alt") {
                out.push_str(&inline_text(alt));
            }
        }
        "table" => render_table(tree, index, out),
        "input" | "button" | "select" | "textarea" => {}
        name if block(name) => {
            out.push_str("\n\n");
            children(tree, index, base, out);
            out.push_str("\n\n");
        }
        _ => children(tree, index, base, out),
    }
}
fn render_table(tree: &Tree, index: usize, out: &mut String) {
    fn rows(tree: &Tree, index: usize, found: &mut Vec<Vec<String>>) {
        if found.len() >= 200 {
            return;
        }
        let node = &tree.nodes[index];
        if node.name == "tr" {
            let cells = node
                .children
                .iter()
                .filter(|i| matches!(tree.nodes[**i].name.as_str(), "td" | "th"))
                .take(20)
                .map(|i| {
                    inline_text(&plain(tree, *i))
                        .replace('\n', " ")
                        .trim()
                        .to_owned()
                })
                .collect::<Vec<_>>();
            if !cells.is_empty() {
                found.push(cells);
            }
        } else {
            for &i in &node.children {
                rows(tree, i, found);
            }
        }
    }
    let mut found = Vec::new();
    rows(tree, index, &mut found);
    let cols = found.iter().map(Vec::len).max().unwrap_or(0);
    out.push_str("\n\n");
    for (i, row) in found.iter().enumerate() {
        out.push('|');
        for col in 0..cols {
            out.push(' ');
            out.push_str(row.get(col).map(String::as_str).unwrap_or(""));
            out.push_str(" |");
        }
        out.push('\n');
        if i == 0 {
            out.push('|');
            for _ in 0..cols {
                out.push_str(" --- |");
            }
            out.push('\n');
        }
        if out.len() > MAX_CONTENT {
            break;
        }
    }
    out.push('\n');
}

pub fn extract(
    bytes: &[u8],
    content_type: &str,
    url: &Url,
) -> Result<PageContent, DocumentParseError> {
    let (text, encoding) = decode(bytes, content_type)?;
    let html = content_type.to_ascii_lowercase().contains("html")
        || text
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<!doctype html")
        || text.trim_start().to_ascii_lowercase().starts_with("<html");
    let script_shell = html && text.to_ascii_lowercase().contains("<script");
    let mut scope_note = None;
    let (title, mut markdown, mut truncated) = if html {
        let mut tree = parse(&text);
        tree.truncated |= tree.nodes.iter().filter(|n| n.name == "tr").count() > 200
            || tree.nodes.iter().filter(|n| n.name == "tr").any(|n| {
                n.children
                    .iter()
                    .filter(|i| matches!(tree.nodes[**i].name.as_str(), "td" | "th"))
                    .count()
                    > 20
            });
        let title = tree
            .nodes
            .iter()
            .position(|n| n.name == "title")
            .map(|i| {
                plain(&tree, i)
                    .chars()
                    .take(512)
                    .collect::<String>()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let root = visible_path(&tree, 0, &|node| node.name == "main")
            .or_else(|| visible_path(&tree, 0, &|node| node.name == "article"))
            .and_then(|path| path.last().copied())
            .unwrap_or(0);
        let mut out = String::new();
        if let Some(fragment) = url.fragment().filter(|value| !value.is_empty()) {
            if let Some(nodes) = fragment_nodes(&tree, root, fragment) {
                scope_note =
                    Some("Requested HTML section; other sections of this page are not included.");
                for node in nodes {
                    render(&tree, node, url, &mut out);
                }
            } else {
                scope_note =
                    Some("The requested HTML anchor was not found; full-page content follows.");
                render(&tree, root, url, &mut out);
            }
        } else {
            render(&tree, root, url, &mut out);
        }
        (title, out, tree.truncated)
    } else if content_type.to_ascii_lowercase().contains("json") {
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => (
                String::new(),
                format!(
                    "```json\n{}\n```",
                    serde_json::to_string_pretty(&value).unwrap_or(text)
                ),
                false,
            ),
            Err(_) => {
                return Err(DocumentParseError(
                    "The page declared JSON but did not contain valid JSON".into(),
                ));
            }
        }
    } else {
        (String::new(), text, false)
    };
    let body_limit = MAX_CONTENT - scope_note.map_or(0, |note: &str| note.len() + 4);
    if markdown.len() > body_limit {
        let marker = "\n[truncated]";
        let mut end = body_limit - marker.len();
        while !markdown.is_char_boundary(end) {
            end -= 1;
        }
        markdown.truncate(end);
        markdown.push_str(marker);
        truncated = true;
    }
    let markdown = markdown.trim().to_owned();
    let lower = format!("{title}\n{markdown}").to_ascii_lowercase();
    let blocked = markdown.chars().count() < 2000
        && [
            "verify you are human",
            "checking your browser",
            "enable javascript and cookies",
            "access denied",
            "just a moment...",
            "登录后查看",
            "请先登录",
            "验证码",
        ]
        .iter()
        .any(|s| lower.contains(s));
    let state = if blocked || markdown.is_empty() || (script_shell && markdown.chars().count() < 40)
    {
        "requires_browser_or_login"
    } else if truncated {
        "partial"
    } else {
        "read"
    };
    let markdown = match scope_note {
        Some(note) => format!("[{note}]\n\n{markdown}"),
        None => markdown,
    };
    Ok(PageContent {
        title,
        markdown,
        state,
        truncated,
        encoding,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_encoded_anchor_reads_the_visible_section_with_its_original_structure() {
        let html = r#"<html><head><title>Task reference</title></head><body><main>
        <section id="intro"><h2>Introduction</h2><p>UNRELATED_INTRO</p></section>
        <section id="取消"><h2>Task cancellation</h2><p>CancelledError reaches the awaited future.</p>
        <a href="exceptions.html">Original exception reference</a><pre>raise CancelledError</pre>
        <table><tr><th>API</th><th>Effect</th></tr><tr><td>cancel</td><td>request</td></tr></table></section>
        <section><h2>Other APIs</h2><p>UNRELATED_TRAILER</p></section></main></body></html>"#;
        let page = extract(
            html.as_bytes(),
            "text/html",
            &Url::parse("https://docs.example.com/api/tasks.html#%E5%8F%96%E6%B6%88").unwrap(),
        )
        .unwrap();
        assert_eq!(page.state, "read");
        assert!(page.markdown.contains("Requested HTML section"));
        assert!(page.markdown.contains("## Task cancellation"));
        assert!(
            page.markdown
                .contains("https://docs.example.com/api/exceptions.html")
        );
        assert!(page.markdown.contains("raise CancelledError"));
        assert!(page.markdown.contains("| cancel | request |"));
        assert!(!page.markdown.contains("UNRELATED_INTRO"));
        assert!(!page.markdown.contains("UNRELATED_TRAILER"));
    }

    #[test]
    fn a_heading_anchor_includes_subsections_and_a_definition_anchor_includes_its_description() {
        let url = Url::parse("https://example.com/docs#cancel").unwrap();
        let page=extract(b"<main><h2>Before</h2><p>NO_BEFORE</p><h2 id=cancel>Cancellation</h2><p>Propagates.</p><h3>Details</h3><p>Details retained.</p><h2>After</h2><p>NO_AFTER</p></main>","text/html",&url).unwrap();
        assert!(page.markdown.contains("Details retained"));
        assert!(!page.markdown.contains("NO_BEFORE"));
        assert!(!page.markdown.contains("NO_AFTER"));
        let page=extract(b"<main><section><dl><dt id=cancel>Task.cancel()</dt><dd>Cancel the awaited future.</dd></dl><dl><dt>Other API</dt><dd>NO_OTHER_METHOD</dd></dl></section></main>","text/html",&url).unwrap();
        assert!(page.markdown.contains("Cancel the awaited future"));
        assert!(!page.markdown.contains("NO_OTHER_METHOD"));
    }

    #[test]
    fn anchor_selection_does_not_reveal_hidden_ancestors_or_turn_a_script_shell_into_a_read() {
        let url = Url::parse("https://example.com/docs#secret").unwrap();
        let page=extract(b"<div hidden><main><p id=secret>PRIVATE_HIDDEN</p></main></div><main><h1>Visible document</h1><p>Only this content is visible.</p></main>","text/html",&url).unwrap();
        assert!(!page.markdown.contains("PRIVATE_HIDDEN"));
        assert!(page.markdown.contains("anchor was not found"));
        assert!(page.markdown.contains("Only this content is visible"));
        let url = Url::parse("https://example.com/docs#app").unwrap();
        let page = extract(
            b"<html><body><div id=app></div><script src=app.js></script></body></html>",
            "text/html",
            &url,
        )
        .unwrap();
        assert_eq!(page.state, "requires_browser_or_login");
    }

    #[test]
    fn section_notices_and_multibyte_content_stay_inside_the_existing_budget() {
        let html = format!(
            "<main><section id=large>{}</section></main>",
            "资料".repeat(100_000)
        );
        let page = extract(
            html.as_bytes(),
            "text/html",
            &Url::parse("https://example.com/docs#large").unwrap(),
        )
        .unwrap();
        assert!(page.truncated);
        assert!(page.markdown.len() <= MAX_CONTENT);
        assert!(page.markdown.ends_with("[truncated]"));
    }
    fn url() -> Url {
        Url::parse("https://example.com/a").unwrap()
    }
    #[test]
    fn preserves_structure_links_tables_and_code() {
        let html = r#"<html><head><title>中文 &amp; 文档</title></head><body><nav>REPEATED</nav><main><h1>正文</h1><p>来源 <a href='/source'>链接</a></p><ul><li>第一<li>第二</ul><table><tr><th>项目</th><th>值</th></tr><tr><td>A</td><td>42</td></tr></table><pre><code>let x = 1;
  中文();</code></pre><script>evil()</script><div hidden>PRIVATE</div></main></body></html>"#;
        let page = extract(html.as_bytes(), "text/html", &url()).unwrap();
        assert_eq!(page.title, "中文 & 文档");
        for part in [
            "# 正文",
            "[链接](<https://example.com/source>)",
            "- 第一",
            "- 第二",
            "| 项目 | 值 |",
            "| --- | --- |",
            "```\nlet x = 1;\n  中文();\n```",
        ] {
            assert!(page.markdown.contains(part), "{part}: {}", page.markdown);
        }
        for absent in ["REPEATED", "PRIVATE", "evil()"] {
            assert!(!page.markdown.contains(absent));
        }
    }
    #[test]
    fn strictly_decodes_gb18030_bom_and_header_precedence() {
        let text = "<meta charset=gb18030><p>中文公告：测试𠀀</p>";
        let (bytes, _, bad) = encoding_rs::GB18030.encode(text);
        assert!(!bad);
        assert!(
            extract(&bytes, "text/html", &url())
                .unwrap()
                .markdown
                .contains("中文公告：测试𠀀")
        );
        assert!(extract(&bytes, "text/html; charset=utf-8", &url()).is_err());
        assert!(extract(b"\xff", "text/plain", &url()).is_err());
        let bytes = [0xff, 0xfe]
            .into_iter()
            .chain("中文".encode_utf16().flat_map(u16::to_le_bytes))
            .collect::<Vec<_>>();
        assert_eq!(
            extract(&bytes, "text/plain; charset=utf-8", &url())
                .unwrap()
                .markdown,
            "中文"
        );
        assert!(extract(b"<meta charset=bogus>x", "text/html", &url()).is_err());
    }
    #[test]
    fn distinguishes_shells_login_and_partial_content() {
        for html in [
            "<div id=app></div><script src=x></script>",
            "<h1>Just a moment...</h1><p>Verify you are human</p>",
        ] {
            assert_eq!(
                extract(html.as_bytes(), "text/html", &url()).unwrap().state,
                "requires_browser_or_login"
            );
        }
        let page = extract("中文".repeat(60_000).as_bytes(), "text/plain", &url()).unwrap();
        assert!(page.truncated);
        assert!(page.markdown.ends_with("[truncated]"));
        assert!(page.markdown.len() <= MAX_CONTENT);
    }
}
