use crate::search_rank::{bm25f_rank, tokenize};
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

/// Search for relevant skills by describing what you want to do.
#[derive(Debug, Default)]
pub struct DiscoverSkillsTool;

const MAX_DISCOVER_SKILLS_LIMIT: usize = 20;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DiscoverSkillsInput {
    /// Description of what you want to do. Be specific — e.g. "deploy a Next.js app to Cloudflare Workers" rather than just "deploy".
    pub description: String,
    /// Maximum number of results to return. Defaults to 5; values above 20 are capped.
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    5
}

#[async_trait]
impl Tool for DiscoverSkillsTool {
    fn name(&self) -> String {
        "DiscoverSkills".to_string()
    }

    fn description(&self) -> String {
        r#"Search installed skills for a task when the catalog does not cover it, when pivoting to a different kind of work, or for a specialized workflow. Ranking is BM25 keyword matching (names first, then tags/category, then descriptions and when-to-use guidance); CJK text matches by character pairs and Feishu/飞书 match Lark. Results only name candidates: a selected skill must still be loaded before its workflow applies. Updates local skill-view telemetry, so calls are serialized. This searches skills, not deferred tools."#
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(DiscoverSkillsInput))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: DiscoverSkillsInput = parse_input(&input)?;

        let registry = ctx
            .skill_registry
            .as_ref()
            .ok_or_else(|| ToolError::Execution("skill registry is not available".to_string()))?;

        let registry = registry.read().unwrap();
        let skills: Vec<_> = registry
            .list()
            .into_iter()
            .filter(|skill| !ctx.is_skill_blocked(&skill.name))
            .filter(|skill| ctx.managed_widgets_authorized() || !skill.requires_inline_widgets())
            .cloned()
            .collect();
        drop(registry);
        if skills.is_empty() {
            return Ok(ToolOutput::text(
                "No matching skills found for that description.",
            ));
        }

        let description = input.description.trim();
        if description.is_empty() {
            return Ok(ToolOutput::text(
                "No matching skills found for that description. Provide a concrete task description such as \"review a pull request\" or \"write a release note\".",
            ));
        }

        let query_terms = tokenize(description);
        if query_terms.is_empty() {
            return Ok(ToolOutput::text(
                "No matching skills found for that description. Use words that describe the workflow, technology, or artifact you need.",
            ));
        }

        let skill_refs: Vec<_> = skills.iter().collect();
        let scored = score_skills(&skill_refs, &query_terms);
        let limit = input.limit.clamp(1, MAX_DISCOVER_SKILLS_LIMIT);
        let results: Vec<_> = scored.into_iter().take(limit).collect();

        if results.is_empty() {
            return Ok(ToolOutput::text(
                "No matching skills found for that description.",
            ));
        }
        if ctx.record_project_skill_telemetry {
            for (skill, _) in &results {
                crate::skill_telemetry::record_skill_view_for_source(
                    &ctx.state.cwd(),
                    &ctx.configuration_directory()?.join("skills"),
                    &skill.name,
                    &skill.source,
                );
            }
        }

        let mut lines = vec![format!("Found {} relevant skill(s):", results.len())];
        if input.limit > MAX_DISCOVER_SKILLS_LIMIT {
            lines.push(format!(
                "Requested limit {} was capped at {}.",
                input.limit, MAX_DISCOVER_SKILLS_LIMIT
            ));
        }
        for (i, (skill, score)) in results.iter().enumerate() {
            lines.push(String::new());
            lines.push(format!(
                "{}. **{}** (score: {:.2})",
                i + 1,
                skill.name,
                score
            ));
            if !skill.description.is_empty() {
                lines.push(format!("   {}", skill.description));
            }
        }

        Ok(ToolOutput::text(lines.join("\n")))
    }
}

/// BM25F weight of the skill `name` field (vs description / when-to-use). The
/// name is the strongest signal of topical relevance, so it gets a 3x boost.
const NAME_WEIGHT: f64 = 3.0;
/// Author-declared tags and category are curated keywords, stronger than prose.
const TAG_WEIGHT: f64 = 2.0;

/// Ranks skills with the shared BM25F ranker over [`skill_fields`]; equal scores
/// fall back to ascending skill name.
fn score_skills<'a>(
    skills: &'a [&'a kcoder_skills::Skill],
    query_terms: &[String],
) -> Vec<(&'a kcoder_skills::Skill, f64)> {
    let documents = skills
        .iter()
        .map(|skill| skill_fields(skill))
        .collect::<Vec<_>>();
    bm25f_rank(&documents, FIELD_WEIGHTS, query_terms, |index| {
        skills[index].name.as_str()
    })
    .into_iter()
    .map(|(index, score)| (skills[index], score))
    .collect()
}

/// Field weights for [`skill_fields`]: name, then author tags/category, then prose.
const FIELD_WEIGHTS: [f64; 3] = [NAME_WEIGHT, TAG_WEIGHT, 1.0];

/// Tokens of a skill's name, its tags and category, and its description plus
/// when-to-use guidance, in [`FIELD_WEIGHTS`] order.
fn skill_fields(skill: &kcoder_skills::Skill) -> [Vec<String>; 3] {
    let tags = skill
        .tags
        .iter()
        .chain(&skill.category)
        .flat_map(|tag| tokenize(tag))
        .collect();
    let mut prose = tokenize(&skill.description);
    if let Some(when) = &skill.when_to_use {
        prose.extend(tokenize(when));
    }
    [tokenize(&skill.name), tags, prose]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolContext;
    use crate::search_rank::stem;
    use kcoder_skills::Skill;
    use std::path::PathBuf;

    fn make_skill(name: &str, description: &str) -> Skill {
        Skill {
            activation: None,
            name: name.into(),
            description: description.into(),
            content: String::new(),
            references: Vec::new(),
            source: PathBuf::from("."),
            when_to_use: None,
            allowed_tools: Vec::new(),
            arguments: Vec::new(),
            paths: None,
            user_invocable: true,
            version: None,
            author: None,
            license: None,
            platforms: Vec::new(),
            requires_tools: Vec::new(),
            fallback_for_tools: Vec::new(),
            requires_toolsets: Vec::new(),
            fallback_for_toolsets: Vec::new(),
            required_env_vars: Vec::new(),
            category: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn scores_relevant_skill_higher() {
        let deploy = make_skill("deploy", "Deploy a Next.js app to Cloudflare Workers");
        let test = make_skill("test", "Run unit tests for a Rust project");
        let skills: Vec<&Skill> = vec![&deploy, &test];
        let scored = score_skills(&skills, &tokenize("deploy project"));
        assert_eq!(scored.len(), 2);
        assert_eq!(scored[0].0.name, "deploy");
        assert!(scored[0].1 > scored[1].1);
    }

    #[test]
    fn stem_lets_testing_match_test_in_name() {
        // Reproduces the report's scenario: a skill named after "test" should
        // outrank a verbose skill whose description only says "understand",
        // even when the query uses the inflected form "testing".
        let tdd = make_skill(
            "test-driven-development",
            "Use when implementing any feature or bugfix",
        );
        let teach = make_skill(
            "teach-me",
            "Personalized tutor. Diagnoses level, builds learning path. \
             Use when user wants to understand a topic.",
        );
        let skills: Vec<&Skill> = vec![&tdd, &teach];
        let scored = score_skills(&skills, &tokenize("testing tools for a Rust project"));

        // teach-me's "understand" still matches, but tdd's name "test" (stemmed
        // from "testing" in the query, weighted 3x) must win.
        assert!(
            !scored.is_empty(),
            "expected at least one match: {scored:?}"
        );
        assert_eq!(
            scored[0].0.name, "test-driven-development",
            "test-named skill should outrank understand-heavy skill: {scored:?}"
        );
    }

    #[test]
    fn stem_collapses_common_inflections() {
        assert_eq!(stem("testing"), "test");
        assert_eq!(stem("tests"), "test");
        assert_eq!(stem("patterns"), "pattern");
        assert_eq!(stem("running"), "run");
        assert_eq!(stem("code"), "code");
        // Too-short results keep the original to avoid over-stemming.
        assert_eq!(stem("is"), "is");
        assert_eq!(stem("as"), "as");
    }

    #[test]
    fn empty_query_returns_no_results() {
        let skill = make_skill("demo", "A demo skill");
        let skills: Vec<&Skill> = vec![&skill];
        let scored = score_skills(&skills, &[]);
        assert!(scored.is_empty());
    }

    #[tokio::test]
    async fn discover_skills_caps_large_limit_and_mentions_cap() {
        use crate::{Tool, ToolContext};
        use kcoder_skills::SkillRegistry;
        use kcoder_state::AppState;
        use std::sync::{Arc, RwLock};

        let tmp = tempfile::tempdir().unwrap();
        for i in 0..25 {
            let dir = tmp
                .path()
                .join(".kcoder")
                .join("skills")
                .join(format!("skill-{i}"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("SKILL.md"),
                format!(
                    "---\nname: skill-{i}\ndescription: Rust workflow helper {i}\n---\n\n# Skill {i}"
                ),
            )
            .unwrap();
        }
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        let output = DiscoverSkillsTool
            .call(
                serde_json::json!({"description": "Rust workflow helper", "limit": 100}),
                &ctx,
            )
            .await
            .unwrap();

        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(text.contains("Found 20 relevant skill(s)"));
        assert!(text.contains("Requested limit 100 was capped at 20"));

        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(usage.skills.len(), 20);
        assert!(
            usage
                .skills
                .values()
                .all(|record| record.view_count == 1 && record.last_viewed_at.is_some()),
            "discovering skills should record one view for each displayed result: {usage:#?}"
        );
    }

    #[tokio::test]
    async fn discover_skills_hides_runtime_blocked_skills() {
        use crate::{Tool, ToolContext};
        use kcoder_skills::SkillRegistry;
        use kcoder_state::AppState;
        use std::sync::{Arc, RwLock};

        let tmp = tempfile::tempdir().unwrap();
        for name in ["using-specs", "using-superpowers"] {
            let dir = tmp.path().join(".kcoder").join("skills").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("SKILL.md"),
                format!(
                    "---\nname: {name}\ndescription: Superpowers workflow protocol\n---\n\n# {name}"
                ),
            )
            .unwrap();
        }
        let registry = Arc::new(RwLock::new(
            SkillRegistry::load_project_only(tmp.path()).unwrap(),
        ));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(registry)
            .with_blocked_skill_names(vec!["using-specs".to_string()]);

        let output = DiscoverSkillsTool
            .call(
                serde_json::json!({"description": "Superpowers workflow protocol"}),
                &ctx,
            )
            .await
            .unwrap();
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(text.contains("using-superpowers"));
        assert!(!text.contains("using-specs"));
    }

    #[tokio::test]
    async fn discover_inline_skill_requires_current_studio_authority() {
        use kcoder_skills::SkillRegistry;
        use kcoder_state::AppState;
        use std::sync::{Arc, RwLock};
        let tmp = tempfile::tempdir().unwrap();
        for (name, requirement) in [
            ("inline-visualization", ""),
            // The former bundled name stays gated for old copies without metadata.
            ("kworker-visualization", ""),
            ("custom-chart", "requires_tools: [show_widget]\n"),
            ("ordinary", ""),
        ] {
            let dir = tmp.path().join(".kcoder/skills").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), format!(
                "---\nname: {name}\ndescription: Visualization chart workflow\n{requirement}---\nBODY"
            )).unwrap();
        }
        let registry = Arc::new(RwLock::new(
            SkillRegistry::load_project_only(tmp.path()).unwrap(),
        ));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);
        let result = DiscoverSkillsTool
            .call(
                serde_json::json!({"description":"Visualization chart workflow"}),
                &ctx,
            )
            .await
            .unwrap();
        let text = serde_json::to_string(&result.content).unwrap();
        assert!(text.contains("ordinary"));
        assert!(!text.contains("inline-visualization"));
        assert!(!text.contains("kworker-visualization"));
        assert!(!text.contains("custom-chart"));
        let ctx = ctx.with_managed_widgets_authorized(true);
        let result = DiscoverSkillsTool
            .call(
                serde_json::json!({"description":"Visualization chart workflow"}),
                &ctx,
            )
            .await
            .unwrap();
        let text = serde_json::to_string(&result.content).unwrap();
        assert!(text.contains("inline-visualization"));
        assert!(text.contains("kworker-visualization"));
        assert!(text.contains("custom-chart"));
    }

    #[tokio::test]
    async fn client_discovery_does_not_materialize_project_metadata() {
        use crate::{Tool, ToolContext};
        use kcoder_skills::SkillRegistry;
        use kcoder_state::AppState;
        use std::sync::{Arc, RwLock};

        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let skill_dir = external.path().join("rust-helper");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: rust-helper\ndescription: Rust workflow helper\n---\n\n# Rust Helper",
        )
        .unwrap();
        let registry = Arc::new(RwLock::new(
            SkillRegistry::load_with_external_dirs(
                workspace.path(),
                [external.path().to_path_buf()].iter(),
            )
            .unwrap(),
        ));
        let ctx = ToolContext::new(AppState::new(workspace.path()))
            .with_skill_registry(registry)
            .with_project_skill_telemetry(false);

        let output = DiscoverSkillsTool
            .call(
                serde_json::json!({"description": "Rust workflow helper"}),
                &ctx,
            )
            .await
            .unwrap();
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(text.contains("rust-helper"));
        assert!(!workspace.path().join(".kcoder").exists());
    }

    #[test]
    fn cjk_text_tokenizes_into_character_pairs_beside_latin_words() {
        assert_eq!(
            tokenize("飞书审批：Lark OKR 日"),
            ["lark", "审批", "lark", "okr", "日"]
        );
        assert_eq!(tokenize("飞书OKR"), ["lark", "okr"]);
        assert_eq!(tokenize("Feishu 飞书"), ["lark", "lark"]);
        // Function words separate content; no pair spans a lexicon word.
        assert_eq!(tokenize("帮我在飞书里建一个日程"), ["lark", "里建", "日程"]);
        assert_eq!(tokenize("飞书文档的内容"), ["lark", "文档", "内容"]);
        assert_eq!(tokenize("审批"), ["审批"]);
    }

    #[test]
    fn scoring_saturates_repeats_and_ignores_input_order() {
        let focused = make_skill("calendar", "Manage calendar events");
        let verbose = make_skill(
            "notes",
            &format!(
                "{} calendar calendar calendar",
                "general workspace helper ".repeat(30)
            ),
        );
        let other = make_skill("deploy", "Deploy services");
        let forward: Vec<&Skill> = vec![&focused, &verbose, &other];
        let backward: Vec<&Skill> = vec![&other, &verbose, &focused];
        let query = tokenize("calendar calendar events");
        let ranked = score_skills(&forward, &query);
        assert_eq!(ranked[0].0.name, "calendar");
        let names = |scored: &[(&Skill, f64)]| {
            scored
                .iter()
                .map(|(skill, score)| (skill.name.clone(), score.to_bits()))
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&ranked), names(&score_skills(&backward, &query)));
    }

    /// Exact scores recorded before the BM25F scorer moved to `search_rank`; the
    /// shared implementation must keep DiscoverSkills bit-for-bit identical.
    #[test]
    fn shared_ranker_keeps_frozen_skill_scores() {
        let mut calendar = make_skill("lark-calendar", "飞书日历：查看和创建日程，管理会议");
        calendar.tags = vec!["calendar".into(), "Feishu".into()];
        calendar.category = Some("productivity".into());
        let mut base = make_skill("lark-base", "飞书多维表格：新增、查询和更新记录");
        base.when_to_use = Some("When the user edits Lark Base tables or records".into());
        let pdf = make_skill(
            "pdf",
            "Merge, split and extract text from PDF files; fill PDF forms",
        );
        let mut tdd = make_skill(
            "test-driven-development",
            "Use when implementing any feature or bugfix, before writing code",
        );
        tdd.tags = vec!["testing".into()];
        let verbose = make_skill(
            "notes",
            &format!(
                "{} calendar records files",
                "general workspace helper ".repeat(12)
            ),
        );
        let skills: Vec<&Skill> = vec![&calendar, &base, &pdf, &tdd, &verbose];
        let snapshot = [
            "飞书日历安排",
            "Feishu calendar meetings",
            "在飞书多维表格里新增一条记录",
            "merge pdf files",
            "testing tools for a Rust project",
            "records",
        ]
        .map(|query| {
            score_skills(&skills, &tokenize(query))
                .into_iter()
                .map(|(skill, score)| format!("{}={score:?}", skill.name))
                .collect::<Vec<_>>()
                .join(" ")
        });
        assert_eq!(
            snapshot,
            [
                "lark-calendar=3.1300759043785833 lark-base=1.5198963631884466",
                "lark-calendar=2.9201098965657666 lark-base=1.5198963631884466 notes=0.5640811271729785",
                "lark-base=8.383707381097668 lark-calendar=1.5218335261035387",
                "pdf=5.398183859065027 notes=0.5640811271729785",
                "test-driven-development=2.2704220312394114",
                "lark-base=0.8669229470760419 notes=0.5640811271729785",
            ]
        );
    }

    #[test]
    fn tags_and_category_contribute_to_matching() {
        let mut tagged = make_skill("notes", "General helper");
        tagged.tags = vec!["kanban".into()];
        tagged.category = Some("planning".into());
        let plain = make_skill("other", "General helper");
        let skills: Vec<&Skill> = vec![&tagged, &plain];
        for query in ["kanban", "planning"] {
            let scored = score_skills(&skills, &tokenize(query));
            assert_eq!(scored.len(), 1, "{query}");
            assert_eq!(scored[0].0.name, "notes");
        }
    }

    async fn discover_text(ctx: &ToolContext, description: &str, limit: usize) -> String {
        let output = DiscoverSkillsTool
            .call(
                serde_json::json!({"description": description, "limit": limit}),
                ctx,
            )
            .await
            .unwrap();
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn result_names(text: &str) -> Vec<String> {
        text.lines()
            .filter_map(|line| line.split_once(". **"))
            .filter_map(|(_, rest)| rest.split_once("**"))
            .map(|(name, _)| name.to_string())
            .collect()
    }

    #[tokio::test]
    async fn bundled_lark_and_office_skills_are_discoverable_in_english_and_chinese() {
        use kcoder_skills::SkillRegistry;
        use kcoder_state::AppState;
        use std::sync::{Arc, RwLock};

        let config = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        kcoder_skills::ensure_builtin_skills(config.path()).unwrap();
        let registry = SkillRegistry::load_for_profile(
            project.path(),
            std::iter::empty::<PathBuf>(),
            config.path(),
            true,
        )
        .unwrap();
        let lark_total = registry
            .names()
            .iter()
            .filter(|name| name.starts_with("lark-"))
            .count();
        assert_eq!(lark_total, 25);
        let ctx = ToolContext::new(AppState::new(project.path()))
            .with_skill_registry(Arc::new(RwLock::new(registry)))
            .with_project_skill_telemetry(false);

        for query in ["lark", "feishu", "飞书", "Feishu calendar"] {
            let names = result_names(&discover_text(&ctx, query, 20).await);
            assert_eq!(names.len(), 20, "{query}: {names:?}");
            assert!(
                names.iter().all(|name| name.starts_with("lark-")),
                "{query}: {names:?}"
            );
        }
        // Focused keywords and full sentences must both rank the intended skill
        // first, so a long description cannot outrank it by length alone.
        for (query, expected) in [
            ("飞书日历", "lark-calendar"),
            ("飞书日程", "lark-calendar"),
            ("帮我在飞书里建一个日程", "lark-calendar"),
            ("查看我明天的飞书日历安排", "lark-calendar"),
            ("飞书多维表格", "lark-base"),
            ("在飞书多维表格里新增一条记录", "lark-base"),
            ("飞书文档", "lark-doc"),
            ("帮我读取这篇飞书文档的内容", "lark-doc"),
            ("发飞书消息", "lark-im"),
            ("给同事发一条飞书消息", "lark-im"),
            ("Feishu calendar", "lark-calendar"),
            ("lark calendar", "lark-calendar"),
            ("merge pdf files", "pdf"),
            ("please merge these pdf files into one", "pdf"),
            ("make a powerpoint deck", "pptx"),
            ("powerpoint slide deck pptx", "pptx"),
            ("edit word document", "docx"),
            ("Word document docx", "docx"),
            ("spreadsheet formulas", "xlsx"),
            ("spreadsheet xlsx", "xlsx"),
        ] {
            let names = result_names(&discover_text(&ctx, query, 5).await);
            assert_eq!(
                names.first().map(String::as_str),
                Some(expected),
                "{query}: {names:?}"
            );
        }
        assert!(!project.path().join(".kcoder").exists());
    }

    #[test]
    fn discover_skills_description_points_to_skill_tool() {
        assert!(
            DiscoverSkillsTool
                .description()
                .contains("must still be loaded before its workflow applies")
        );
        assert!(DiscoverSkillsTool.description().contains("BM25"));
    }
}
