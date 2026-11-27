//! Offline retrieval eval for `tool_search` ranking over a realistic deferred catalog.
//!
//! The catalog and queries are fixed, so the eval is deterministic and runs in default
//! CI. It also replays the previous substring scorer to prove the shared BM25F ranker
//! is not a regression on the same set.
use super::*;
use crate::ToolSource;

fn mcp(server: &str) -> ToolSource {
    ToolSource::Mcp {
        server: server.into(),
        tool: String::new(),
    }
}

fn native(feature: &str) -> ToolSource {
    ToolSource::NativeFeature {
        feature: feature.into(),
        tool: String::new(),
        revision: "eval".into(),
    }
}

fn plugin(plugin: &str, server: &str) -> ToolSource {
    ToolSource::Plugin {
        plugin: plugin.into(),
        server: server.into(),
        tool: String::new(),
    }
}

fn catalog() -> Vec<(&'static str, ToolSource, String)> {
    let zapier = "Run any Zapier action across 6000+ connected apps such as Gmail, Slack, \
        Google Sheets, Google Calendar, Jira, GitHub, Notion and Google Drive. Use it to send \
        email, post messages, create issues and tickets, add spreadsheet rows, create calendar \
        events, upload or download files, read data, list records, search anything and \
        automate workflows. The action id and its fields come from the Zapier configuration; \
        each call may read or write data in the connected account. "
        .repeat(2);
    let filesystem = "Read the complete contents of a file from the file system. Handles \
        various text encodings and provides detailed error messages if the file cannot be \
        read. Use this tool when you need to examine the contents of a single file. Only \
        works within allowed directories; use list_directory to list files first.";
    [
        ("mcp__gmail__search_messages", mcp("gmail"), "Search Gmail messages in the user's mailbox using Gmail query syntax and list matching message ids, subjects and senders."),
        ("mcp__gmail__send_message", mcp("gmail"), "Send an email message from the user's Gmail account with recipients, subject, body and optional file attachments."),
        ("mcp__gmail__read_message", mcp("gmail"), "Read a Gmail message by id, including headers, body text and attachment file metadata."),
        ("mcp__outlook__create_draft", mcp("outlook"), "Create a draft email in Outlook mail with recipients, subject and body; the draft is not sent."),
        ("mcp__feishu_sheet__read_range", mcp("feishu_sheet"), "读取飞书电子表格指定范围的单元格数据。Read cell values from a Lark spreadsheet range."),
        ("mcp__feishu_sheet__write_range", mcp("feishu_sheet"), "写入飞书电子表格的单元格。Write values into a Lark spreadsheet range."),
        ("mcp__feishu_doc__create_document", mcp("feishu_doc"), "创建飞书云文档并写入 Markdown 内容。Create a Lark cloud document."),
        ("mcp__feishu_im__send_message", mcp("feishu_im"), "向飞书群聊或用户发送消息。Send a Lark chat message to a user or group."),
        ("mcp__feishu_calendar__create_event", mcp("feishu_calendar"), "创建飞书日历日程并邀请参与人。Create a Lark calendar event."),
        ("mcp__feishu_base__add_record", mcp("feishu_base"), "在飞书多维表格中新增记录。Add a record to a Lark Base table."),
        ("mcp__github__create_issue", mcp("github"), "Create a new issue in a GitHub repository with title, body, labels and assignees."),
        ("mcp__github__search_code", mcp("github"), "Search code across GitHub repositories and return matching file paths and snippets."),
        ("mcp__github__create_pull_request", mcp("github"), "Open a pull request in a GitHub repository from a head branch to a base branch."),
        ("mcp__github__list_commits", mcp("github"), "List commits on a branch of a GitHub repository."),
        ("mcp__jira__create_ticket", mcp("jira"), "Create a Jira ticket (issue) in a project with summary, description, type and priority."),
        ("mcp__jira__search_issues", mcp("jira"), "Search Jira issues with JQL and list keys, status and assignees."),
        ("mcp__slack__post_message", mcp("slack"), "Post a message to a Slack channel or thread."),
        ("mcp__slack__list_channels", mcp("slack"), "List public and private Slack channels the bot can read."),
        ("mcp__google_calendar__create_event", mcp("google_calendar"), "Create a calendar event with title, start and end time, attendees and a video meeting link."),
        ("mcp__google_calendar__list_events", mcp("google_calendar"), "List upcoming events from the user's Google Calendar for a time range."),
        ("mcp__google_drive__search_files", mcp("google_drive"), "Search files and folders in Google Drive by name, type or full text."),
        ("mcp__google_drive__upload_file", mcp("google_drive"), "Upload a local file to a Google Drive folder."),
        ("mcp__google_drive__download_file", mcp("google_drive"), "Download a file from Google Drive into the workspace."),
        ("office_document", native("office"), "Create, read and edit Word (.docx) documents: paragraphs, headings, tables, comments and tracked changes."),
        ("office_spreadsheet", native("office"), "Create, read and edit Excel (.xlsx) workbooks: sheets, cells, formulas and charts."),
        ("office_presentation", native("office"), "Create and edit PowerPoint (.pptx) slide decks with layouts, images and speaker notes."),
        ("mcp__browser__navigate", mcp("playwright"), "Open a URL in a headless browser page and return the page title and visible text."),
        ("mcp__browser__screenshot", mcp("playwright"), "Capture a screenshot of the current browser page as a PNG image."),
        ("mcp__browser__click", mcp("playwright"), "Click an element on the current web page by CSS selector."),
        ("plugin__imagegen__generate_image", plugin("creative-suite", "imagegen"), "Generate an image from a text prompt with a diffusion model; returns a PNG file."),
        ("plugin__imagegen__edit_image", plugin("creative-suite", "imagegen"), "Edit an existing picture with a text instruction, such as inpainting or background removal."),
        ("mcp__notion__search_pages", mcp("notion"), "Search Notion pages and databases in the workspace."),
        ("mcp__notion__create_page", mcp("notion"), "Create a Notion page with Markdown content under a parent page."),
        ("mcp__postgres__run_query", mcp("postgres"), "Run a read-only SQL query against the configured PostgreSQL database and return rows."),
        ("mcp__filesystem__read_file", mcp("filesystem"), filesystem),
        ("mcp__filesystem__list_directory", mcp("filesystem"), "List files and subdirectories in a directory."),
        ("mcp__deepl__translate_text", mcp("deepl"), "Translate text between languages with DeepL."),
        ("mcp__weather__get_forecast", mcp("weather"), "Get the weather forecast for a city."),
        ("mcp__charts__render_chart", mcp("charts"), "Render a chart or diagram (bar, line, pie, flowchart) as an interactive widget."),
        ("mcp__zapier__run_action", mcp("zapier"), zapier.as_str()),
    ]
    .into_iter()
    .map(|(name, source, description)| (name, source, description.to_string()))
    .collect()
}

const QUERIES: &[(&str, &str)] = &[
    (
        "search my gmail inbox for invoices",
        "mcp__gmail__search_messages",
    ),
    ("send an email to my boss", "mcp__gmail__send_message"),
    ("read an email message", "mcp__gmail__read_message"),
    ("draft an outlook email", "mcp__outlook__create_draft"),
    (
        "create a github issue for this bug",
        "mcp__github__create_issue",
    ),
    ("open a pull request", "mcp__github__create_pull_request"),
    (
        "search code in github repositories",
        "mcp__github__search_code",
    ),
    ("list recent commits", "mcp__github__list_commits"),
    ("create jira ticket", "mcp__jira__create_ticket"),
    (
        "find jira issues assigned to me",
        "mcp__jira__search_issues",
    ),
    ("post to a slack channel", "mcp__slack__post_message"),
    ("which slack channels exist", "mcp__slack__list_channels"),
    (
        "schedule a meeting on google calendar",
        "mcp__google_calendar__create_event",
    ),
    (
        "list events on my google calendar this week",
        "mcp__google_calendar__list_events",
    ),
    (
        "find a file in google drive",
        "mcp__google_drive__search_files",
    ),
    ("upload file to drive", "mcp__google_drive__upload_file"),
    ("edit a word document", "office_document"),
    (
        "build an excel workbook with formulas",
        "office_spreadsheet",
    ),
    ("make a powerpoint slide deck", "office_presentation"),
    (
        "take a screenshot of the web page",
        "mcp__browser__screenshot",
    ),
    ("open a url in the browser", "mcp__browser__navigate"),
    (
        "generate an image from a prompt",
        "plugin__imagegen__generate_image",
    ),
    (
        "remove the background of a picture",
        "plugin__imagegen__edit_image",
    ),
    ("run a sql query on postgres", "mcp__postgres__run_query"),
    (
        "translate this paragraph to French",
        "mcp__deepl__translate_text",
    ),
    ("weather forecast for Beijing", "mcp__weather__get_forecast"),
    ("draw a bar chart", "mcp__charts__render_chart"),
    ("search notion pages", "mcp__notion__search_pages"),
    ("mcp__github__create_issue", "mcp__github__create_issue"),
    ("office_spreadsheet", "office_spreadsheet"),
    (
        "MCP__FEISHU_SHEET__READ_RANGE",
        "mcp__feishu_sheet__read_range",
    ),
    ("帮我读取飞书表格里的数据", "mcp__feishu_sheet__read_range"),
    ("打开这个 Excel 报表", "office_spreadsheet"),
    ("发个邮件给张三", "mcp__gmail__send_message"),
    ("给飞书群发消息", "mcp__feishu_im__send_message"),
    ("建个 issue", "mcp__github__create_issue"),
    ("在飞书日历里建个日程", "mcp__feishu_calendar__create_event"),
    (
        "在飞书多维表格里新增一条记录",
        "mcp__feishu_base__add_record",
    ),
    ("创建一个飞书文档", "mcp__feishu_doc__create_document"),
    ("搜索 GitHub 上的代码", "mcp__github__search_code"),
    ("把文件上传到网盘", "mcp__google_drive__upload_file"),
    ("生成一张图片", "plugin__imagegen__generate_image"),
    ("网页截图", "mcp__browser__screenshot"),
    ("翻译成英文", "mcp__deepl__translate_text"),
    ("查一下北京天气", "mcp__weather__get_forecast"),
    ("做个 PPT 演示文稿", "office_presentation"),
    ("可视化一下销售数据", "mcp__charts__render_chart"),
    ("在 Jira 里搜索问题单", "mcp__jira__search_issues"),
];

/// The substring scorer `tool_search` used before BM25F, kept only for comparison.
fn legacy_tool_search_score(query: &str, name: &str, description: &str) -> usize {
    let query = query.to_lowercase();
    let name = name.to_lowercase();
    if query == name {
        return 100_000;
    }
    let description = description.to_lowercase();
    let mut terms = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| term.len() > 1)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for word in terms.clone() {
        let chars = word.chars().collect::<Vec<_>>();
        for pair in chars.windows(2) {
            if pair.iter().all(|c| ('\u{3400}'..='\u{9fff}').contains(c)) {
                terms.push(pair.iter().collect());
            }
        }
    }
    for (chinese, english) in [
        ("表格", "spreadsheet excel sheet table"),
        ("邮件", "email mail message"),
        ("邮箱", "email mail"),
        ("文档", "document docx word"),
        ("幻灯", "presentation ppt slide"),
        ("演示", "presentation slide"),
        ("日历", "calendar event"),
        ("搜索", "search find"),
        ("查询", "search query list"),
        ("读取", "read get"),
        ("生成", "create generate"),
        ("图片", "image picture"),
        ("文件", "file document"),
        ("工作流", "workflow"),
        ("可视化", "widget chart diagram"),
    ] {
        if query.contains(chinese) {
            terms.extend(english.split_whitespace().map(str::to_owned));
        }
    }
    terms.sort_unstable();
    terms.dedup();
    terms.truncate(64);
    terms
        .iter()
        .filter(|term| {
            !matches!(
                term.as_str(),
                "the" | "for" | "and" | "with" | "tool" | "tools" | "please" | "want"
            )
        })
        .map(|term| {
            usize::from(name.contains(term)) * 12 + usize::from(description.contains(term)) * 3
        })
        .sum()
}

/// The runtime's exact-name mode: a registered name, or an `__` identifier.
fn exact_name_mode(query: &str, names: &[&str]) -> bool {
    names.iter().any(|name| name.eq_ignore_ascii_case(query))
        || (query.contains("__") && !query.chars().any(char::is_whitespace))
}

fn legacy_rank(query: &str, catalog: &[(&'static str, ToolSource, String)]) -> Vec<&'static str> {
    let names = catalog.iter().map(|tool| tool.0).collect::<Vec<_>>();
    let exact = exact_name_mode(query, &names);
    let mut scored = catalog
        .iter()
        .filter(|tool| !exact || tool.0.eq_ignore_ascii_case(query))
        .map(|(name, _, description)| {
            let description = description.chars().take(1024).collect::<String>();
            (legacy_tool_search_score(query, name, &description), *name)
        })
        .filter(|(score, _)| *score > 0)
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
    scored.into_iter().map(|(_, name)| name).collect()
}

fn bm25f_rank_names(
    query: &str,
    catalog: &[(&'static str, ToolSource, String)],
) -> Vec<&'static str> {
    let names = catalog.iter().map(|tool| tool.0).collect::<Vec<_>>();
    let exact = exact_name_mode(query, &names);
    let candidates = catalog
        .iter()
        .filter(|tool| !exact || tool.0.eq_ignore_ascii_case(query))
        .collect::<Vec<_>>();
    let documents = candidates
        .iter()
        .map(|(name, source, description)| ToolSearchDocument {
            name,
            source,
            description,
        })
        .collect::<Vec<_>>();
    rank_tool_search(query, &documents)
        .into_iter()
        .map(|index| candidates[index].0)
        .collect()
}

struct Outcome {
    top1: usize,
    top3: usize,
    failures: Vec<String>,
}

fn evaluate(rank: impl Fn(&str) -> Vec<&'static str>) -> Outcome {
    let mut outcome = Outcome {
        top1: 0,
        top3: 0,
        failures: Vec::new(),
    };
    for (query, expected) in QUERIES {
        let ranked = rank(query);
        let position = ranked.iter().position(|name| name == expected);
        outcome.top1 += usize::from(position == Some(0));
        outcome.top3 += usize::from(position.is_some_and(|position| position < 3));
        if position != Some(0) {
            outcome.failures.push(format!(
                "| {query} | {expected} | {} | {} |",
                position.map_or("-".into(), |position| (position + 1).to_string()),
                ranked
                    .iter()
                    .take(3)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    outcome
}

#[test]
fn tool_search_bm25f_retrieval_eval_meets_targets_and_beats_legacy_scorer() {
    let catalog = catalog();
    let names = catalog.iter().map(|tool| tool.0).collect::<Vec<_>>();
    for (_, expected) in QUERIES {
        assert!(names.contains(expected), "{expected} is not in the catalog");
    }
    let total = QUERIES.len();
    let new = evaluate(|query| bm25f_rank_names(query, &catalog));
    let old = evaluate(|query| legacy_rank(query, &catalog));
    let percent = |hits: usize| hits as f64 * 100.0 / total as f64;
    let report = format!(
        "tool_search eval over {} tools, {total} queries\n\
         ranker | top-1 | top-3\n\
         bm25f  | {} ({:.1}%) | {} ({:.1}%)\n\
         legacy | {} ({:.1}%) | {} ({:.1}%)\n\n\
         bm25f misses (query | expected | rank | top-3):\n{}\n\n\
         legacy misses (query | expected | rank | top-3):\n{}",
        catalog.len(),
        new.top1,
        percent(new.top1),
        new.top3,
        percent(new.top3),
        old.top1,
        percent(old.top1),
        old.top3,
        percent(old.top3),
        new.failures.join("\n"),
        old.failures.join("\n"),
    );
    println!("{report}");
    assert!(new.top1 * 100 >= total * 85, "{report}");
    assert!(new.top3 * 100 >= total * 95, "{report}");
    assert!(new.top1 >= old.top1 && new.top3 >= old.top3, "{report}");
}

#[test]
fn tool_search_eval_ranking_is_independent_of_catalog_order() {
    let catalog = catalog();
    let mut reversed = catalog.clone();
    reversed.reverse();
    for (query, _) in QUERIES {
        assert_eq!(
            bm25f_rank_names(query, &catalog),
            bm25f_rank_names(query, &reversed),
            "{query}"
        );
    }
}
