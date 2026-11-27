//! Exact 0.3.11 request compatibility. Frozen strings were copied from commit
//! 9751d4661; they are used only for private paid-cache lookup, never generation.
use super::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Frozen {
    pub generation_contract_template: String,
    pub generation_system_template: String,
    pub merge_rules: String,
    pub preferred_citation_format: String,
    pub limits: std::collections::BTreeMap<String, usize>,
}
pub(super) fn frozen() -> &'static Frozen {
    static FROZEN: OnceLock<Frozen> = OnceLock::new();
    FROZEN.get_or_init(|| {
        serde_json::from_str(include_str!("../prompts/llm_wiki/cache_contract_0311.json"))
            .expect("frozen 0.3.11 contract is valid")
    })
}
fn render(template: &str, shape: &str) -> String {
    let mut text = template.replace("{{", "{").replace("}}", "}");
    for (key, value) in &frozen().limits {
        text = text.replace(&format!("{{{key}}}"), &value.to_string());
    }
    text.replace("{shape}", shape)
}
pub(super) fn old_system(bindings: &Value, limit: usize) -> String {
    render(&frozen().generation_system_template, "")
        .replace("{initial_topic_limit}", &limit.to_string())
        .replace("{MERGE_RULES}", &frozen().merge_rules)
        .replace("{output_contract}", &old_contract(bindings))
}
const OLD_NEW: &str = "NEW citations must use {ref} chosen from citationSpans; only SAME read pageId prior literal citations may be retained EXACTLY unchanged";
const CURRENT_NEW: &str = "NEW citations should prefer {ref} from citationSpans or the explicit supplied-source locator/literal forms in the output contract; SAME read pageId prior literal citations must be retained EXACTLY unchanged";
pub(super) fn old_contract(bindings: &Value) -> String {
    render(
        &frozen().generation_contract_template,
        &serde_json::to_string(&bindings["exampleProposal"]).unwrap(),
    )
}

pub(super) fn requests(input: &WikiModelRequest) -> Result<Vec<WikiModelRequest>> {
    let mut compatible = input.clone();
    let mut changed = false;
    const BEGIN: &str = "Return a complete JSON page proposal. A complete shape with actual copyable IDs/binding is: ";
    const AFTER_SHAPE: &str =
        ". This is an unfinished template; write actual source-supported prose.";
    const END: &str = "All byte limits apply to decoded strings.";
    if let Some(start) = input.system.find(BEGIN) {
        let Some(end) = input.system[start..]
            .find(END)
            .map(|end| start + end + END.len())
        else {
            return Ok(vec![]);
        };
        let block = &input.system[start..end];
        let Some(shape_end) = block.find(AFTER_SHAPE) else {
            return Ok(vec![]);
        };
        let shape: Value = match serde_json::from_str(&block[BEGIN.len()..shape_end]) {
            Ok(shape) => shape,
            Err(_) => return Ok(vec![]),
        };
        let bindings = json!({"exampleProposal":shape});
        // The whole host contract must match, not merely a few coincidental
        // words in another system instruction or supplied source text.
        if block != generation_output_contract(&bindings) {
            return Ok(vec![]);
        }
        let current_main = (0..=6).find_map(|limit| {
            let current = render(&frozen().generation_system_template, "")
                .replace(OLD_NEW, CURRENT_NEW)
                .replace("{initial_topic_limit}", &limit.to_string())
                .replace("{MERGE_RULES}", MERGE_RULES)
                .replace("{output_contract}", block);
            input
                .system
                .starts_with(&current)
                .then_some((current.len(), limit))
        });
        if let Some((prefix, limit)) = current_main {
            let mut suffix = input.system[prefix..].to_owned();
            if suffix.starts_with(
                "\nCorrect the citation validation errors against originalInput.source.chunks.",
            ) {
                suffix=suffix.replacen("prefer an appropriate offered citationSpans ref or explicit supplied chunk coordinates that select real original text; new literal quotes still need exact source validation","select an appropriate offered citationSpans ref; never reconstruct or copy a new literal quote",1);
            } else if suffix.starts_with("\nThe previous response hit the provider output limit.") {
                suffix=suffix.replacen("NEW citations should prefer refs or explicit supplied chunk coordinates; SAME read pageId prior literal citations must be retained EXACTLY unchanged","NEW citations MUST use refs; only SAME read pageId prior literal citations may be retained EXACTLY unchanged",1);
            }
            compatible.system = old_system(&bindings, limit) + &suffix;
        } else {
            compatible
                .system
                .replace_range(start..end, &old_contract(&bindings));
        }
        changed = compatible.system != input.system;
    }
    let mut user: Value = serde_json::from_str(&input.user)?;
    if policy(&mut user, 0) {
        compatible.user = serde_json::to_string(&user)?;
        changed = true;
    }
    Ok(if changed { vec![compatible] } else { vec![] })
}
fn policy(user: &mut Value, depth: usize) -> bool {
    if depth >= 8 {
        return false;
    }
    let mut changed = false;
    if let Some(policy) = user.get_mut("outputPolicy").and_then(Value::as_object_mut) {
        const CURRENT: &str = "Prefer an offered citationSpans ref; explicit supplied chunk coordinates or validated literals are also accepted. Omitted/null sourceId/revisionId binds only to one uniquely supplied chunk. SAME read pageId prior literals remain EXACTLY unchanged.";
        if policy
            .get("preferredCitationFormat")
            .and_then(Value::as_str)
            == Some(CURRENT)
        {
            policy.insert(
                "preferredCitationFormat".into(),
                frozen().preferred_citation_format.clone().into(),
            );
            changed = true;
        }
    }
    // Only explicit host repair/support wrappers are traversed. Source text,
    // candidates and arbitrary model metadata are never searched or rewritten.
    if let Some(original) = user.get_mut("originalInput") {
        changed |= policy(original, depth + 1);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_0311_request_is_recovered_without_changing_source_or_user_data() -> Result<()> {
        // This literal request was rendered from git 9751d4661's actual frozen
        // source, independently of both compatibility methods under test.
        let old: Value =
            serde_json::from_str(include_str!("../tests/fixtures/cache_request_0311.json"))?;
        let old_user: Value = serde_json::from_str(old["user"].as_str().unwrap())?;
        let shape = &old_user["identityBindings"];
        let mut current_system = old["system"].as_str().unwrap().to_owned();
        current_system = current_system
            .replace(&frozen().merge_rules, MERGE_RULES)
            .replace(OLD_NEW, CURRENT_NEW)
            .replace(&old_contract(shape), &generation_output_contract(shape));
        let mut current_user = old_user.clone();
        current_user["outputPolicy"]["preferredCitationFormat"]="Prefer an offered citationSpans ref; explicit supplied chunk coordinates or validated literals are also accepted. Omitted/null sourceId/revisionId binds only to one uniquely supplied chunk. SAME read pageId prior literals remain EXACTLY unchanged.".into();
        let current = WikiModelRequest {
            stage: "generation",
            system: current_system,
            user: serde_json::to_string(&current_user)?,
            max_output_tokens: 8192,
        };
        let recent = current.recent_format_cache_requests()?;
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].system, old["system"].as_str().unwrap());
        assert_eq!(recent[0].user, old["user"].as_str().unwrap());
        assert_eq!(recent[0].max_output_tokens, 8192);
        assert!(recent[0].recent_format_cache_requests()?.is_empty());
        // Topic system retains the parent example shape, which can differ from
        // selectedTopic's user binding. Do not rebuild it from the wrong shape.
        let mut topic = current.clone();
        let mut body = current_user.clone();
        body["identityBindings"]["exampleProposal"]["pages"][0]["pageId"] =
            "different-selected-topic".into();
        topic.user = serde_json::to_string(&body)?;
        topic
            .system
            .push_str("\nThis is ONE independently recoverable topic.");
        assert_eq!(
            topic.recent_format_cache_requests()?[0].system,
            format!(
                "{}\nThis is ONE independently recoverable topic.",
                old["system"].as_str().unwrap()
            )
        );
        let mut changed = current.clone();
        changed
            .system
            .push_str("\nArbitrary source instruction says: ");
        changed.system.push_str(CURRENT_NEW);
        assert!(
            changed.recent_format_cache_requests()?[0]
                .system
                .ends_with(CURRENT_NEW)
        );
        let mut body = current_user;
        body["source"]["chunks"][0]["text"] = CURRENT_NEW.into();
        changed.user = serde_json::to_string(&body)?;
        let recent = changed.recent_format_cache_requests()?;
        assert_eq!(
            serde_json::from_str::<Value>(&recent[0].user)?["source"]["chunks"][0]["text"],
            CURRENT_NEW
        );
        assert_ne!(
            recent[0].user,
            old["user"].as_str().unwrap(),
            "changed source data cannot hit the literal old cache key"
        );
        let mut changed_limit = current.clone();
        changed_limit.max_output_tokens = 4096;
        assert_eq!(
            changed_limit.recent_format_cache_requests()?[0].max_output_tokens,
            4096
        );
        Ok(())
    }
}
