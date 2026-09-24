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
        "Search for skills relevant to a task description. Use this when auto-surfaced \
         skills do not cover the task, when pivoting to a different kind of work, or \
         when looking for specialized skills for an unusual workflow. Results are \
         ranked by TF-IDF-style keyword matching over registered skill names, \
         descriptions, and when-to-use guidance. Matching results update local \
         skill-view telemetry, so this tool is stateful and serialized. Activate a matching skill before applying its workflow when an activation control is attached."
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

/// Common English stopwords filtered out so verbose descriptions do not rack
/// up score on filler words like "a", "to", "use", "when".
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "in", "on", "at", "by", "to", "of", "for", "with", "from", "into", "and",
    "or", "is", "are", "be", "been", "as", "it", "its", "this", "that", "use", "when", "how",
    "what", "which", "you", "your", "i", "we", "they", "them", "do", "does", "can", "will", "if",
    "then", "than", "so", "not", "no",
];

/// Weight applied to tokens sourced from the skill `name` (vs description /
/// when-to-use). The name is the strongest signal of topical relevance, so it
/// gets a 3x boost.
const NAME_WEIGHT: f64 = 3.0;

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(stem)
        .filter(|s| !STOPWORDS.contains(&s.as_str()))
        .filter(|s| !s.is_empty())
        .collect()
}

/// Very small suffix stemmer: strips a few common English suffixes so that
/// "testing" -> "test", "patterns" -> "pattern", "runs" -> "run", "running"
/// -> "run". This is not a full Porter stemmer; it only collapses the most
/// frequent inflections that break exact-match TF-IDF.
fn stem(word: &str) -> String {
    // Order matters: try longer suffixes first.
    for suffix in ["ingly", "edly", "ing", "ed", "es", "s"] {
        if let Some(stripped) = word.strip_suffix(suffix) {
            // Keep at least 3 chars so we don't reduce "is" -> "" etc.
            if stripped.len() >= 3 {
                // Collapse a doubled final consonant left by stripping "ing"/"ed"
                // (e.g. "running" -> "runn" -> "run", "stopped" -> "stopp" -> "stop").
                let collapsed = strip_doubled_final_consonant(stripped);
                return collapsed;
            }
        }
    }
    word.to_string()
}

/// If `word` ends with the same consonant twice, drop one copy. Used to tidy
/// up after suffix stripping (running->runn->run). Only applies when the
/// result stays at least 3 chars.
fn strip_doubled_final_consonant(word: &str) -> String {
    let chars: Vec<char> = word.chars().collect();
    if chars.len() >= 4 {
        let last = chars[chars.len() - 1];
        let prev = chars[chars.len() - 2];
        // Only collapse actual letter doubles, and only consonants (vowels like
        // "ee"/"oo" are usually meaningful, e.g. "feed" -> "fee" would be wrong).
        if last == prev && !is_vowel(last) {
            let trimmed: String = chars[..chars.len() - 1].iter().collect();
            return trimmed;
        }
    }
    word.to_string()
}

fn is_vowel(c: char) -> bool {
    matches!(c, 'a' | 'e' | 'i' | 'o' | 'u')
}

fn score_skills<'a>(
    skills: &'a [&'a kcoder_skills::Skill],
    query_terms: &[String],
) -> Vec<(&'a kcoder_skills::Skill, f64)> {
    let n = skills.len() as f64;

    // Deduplicate query terms (after stemming/stopword filtering in tokenize).
    let query_set: std::collections::HashSet<&str> =
        query_terms.iter().map(String::as_str).collect();

    // Compute document frequency for each query term (skill has the term if any
    // weighted token matches).
    let mut df: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for skill in skills {
        let terms = skill_terms(skill);
        let term_set: std::collections::HashSet<&str> =
            terms.iter().map(|(t, _)| t.as_str()).collect();
        for term in &query_set {
            if term_set.contains(term) {
                *df.entry(term).or_insert(0) += 1;
            }
        }
    }

    let mut scored: Vec<(&kcoder_skills::Skill, f64)> = skills
        .iter()
        .map(|skill| {
            let terms = skill_terms(skill);
            let mut score = 0.0;
            for term in &query_set {
                // Weighted term frequency: sum of weights for each matching token.
                let tf: f64 = terms
                    .iter()
                    .filter(|(t, _)| t == term)
                    .map(|(_, w)| *w)
                    .sum();
                if tf == 0.0 {
                    continue;
                }
                let idf = df
                    .get(term)
                    .map(|df| (n / (*df as f64)).ln() + 1.0)
                    .unwrap_or(1.0);
                score += tf * idf;
            }
            (*skill, score)
        })
        .filter(|(_, score)| *score > 0.0)
        .collect();

    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.name.cmp(&b.0.name))
    });
    scored
}

/// Returns (token, weight) pairs for a skill. Name tokens are weighted higher
/// than description / when-to-use tokens.
fn skill_terms(skill: &kcoder_skills::Skill) -> Vec<(String, f64)> {
    let mut terms = Vec::new();
    for token in tokenize(&skill.name) {
        terms.push((token, NAME_WEIGHT));
    }
    for token in tokenize(&skill.description) {
        terms.push((token, 1.0));
    }
    if let Some(when) = &skill.when_to_use {
        for token in tokenize(when) {
            terms.push((token, 1.0));
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_skills::Skill;
    use std::path::PathBuf;

    fn make_skill(name: &str, description: &str) -> Skill {
        Skill {
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
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
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
    fn discover_skills_description_points_to_skill_tool() {
        assert!(DiscoverSkillsTool.description().contains("when an activation control is attached"));
        assert!(DiscoverSkillsTool.description().contains("TF-IDF"));
    }
}
