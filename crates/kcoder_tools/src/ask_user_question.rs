use crate::{
    LifecycleHookResult, Tool, ToolContext, ToolError, ToolOutput, clean_schema, coerce_input,
    parse_input, validate_input_against_schema,
};
use async_trait::async_trait;
use kcoder_types::ContentBlock;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Ask the user one or more multiple-choice questions and return the answers.
#[derive(Debug, Default)]
pub struct AskUserQuestionTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AskUserQuestionInput {
    /// Questions to ask the user. Must be a JSON array with 1-4 question
    /// objects; use `[{...}]` even when asking only one question.
    pub questions: Vec<QuestionInput>,
    /// Optional pre-filled answers keyed by exact question text. This is
    /// normally omitted when asking a fresh question.
    #[serde(default)]
    pub answers: HashMap<String, String>,
    /// Optional per-question annotations, keyed by question text. Only include
    /// this when returning notes or preview metadata from a previous prompt.
    #[serde(default)]
    pub annotations: Option<Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QuestionInput {
    /// Single clear sentence shown to the user. Ask for a concrete decision or
    /// clarification; avoid asking whether to proceed with an invisible plan.
    pub question: String,
    /// Short UI chip label, preferably 1-3 words and 12 or fewer characters,
    /// such as `Library`, `Approach`, or `Auth`.
    pub header: String,
    /// Available choices. Must be a JSON array with 2-4 option objects; do not
    /// send a single option object, numeric-key object, or wrapper such as
    /// `{ "item": [...] }`. Do not include an `Other` option; the UI supplies
    /// it automatically.
    pub options: Vec<QuestionOptionInput>,
    /// Whether multiple options may be selected. Use a JSON boolean, normally
    /// `false`, not a string.
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QuestionOptionInput {
    /// Short user-facing option label, usually 1-5 words. If recommending an
    /// option, put it first and suffix the label with `(Recommended)`.
    pub label: String,
    /// One short sentence explaining the impact, trade-off, or consequence if
    /// this option is selected.
    pub description: String,
    /// Optional preview content shown when the option is focused. Use only for
    /// concrete artifacts that benefit from visual comparison.
    #[serde(default)]
    pub preview: Option<String>,
}

fn lifecycle_block_error(event: &str, result: &LifecycleHookResult) -> ToolError {
    ToolError::Execution(format!(
        "{event} hook blocked user question flow: {}",
        result.block_reason()
    ))
}

fn append_lifecycle_messages(output: &mut ToolOutput, event: &str, result: &LifecycleHookResult) {
    for (text, is_error) in &result.messages {
        let level = if *is_error { "error" } else { "message" };
        output.content.push(ContentBlock::Text {
            text: format!("[hook:{event}:{level}] {text}"),
        });
    }
}

#[async_trait]
impl Tool for AskUserQuestionTool {
    fn name(&self) -> String {
        "AskUserQuestion".to_string()
    }

    fn description(&self) -> String {
        "Ask the user one or more multiple-choice questions and return their answers. \
         Use this only when progress depends on a user decision that cannot be safely inferred.\n\
         Input must be one JSON object with this shape: \
         {\"questions\":[{\"question\":\"...\",\"header\":\"short_label\",\"options\":[{\"label\":\"Option A\",\"description\":\"What happens if selected\"},{\"label\":\"Option B\",\"description\":\"What happens if selected\"}],\"multi_select\":false}]}.\n\
         Critical shape rules: `questions` is always an array, even for one question; \
         each question's `options` is always an array with 2-4 option objects; \
         every option must include both `label` and `description`; \
         `multi_select` is a boolean, usually false.\n\
         Do not send `questions` as a single object. Do not send `options` as \
         {\"item\":[...]}, {\"items\":[...]}, or a single option object. Do not use \
         string booleans like \"false\" when valid JSON boolean false is available."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(AskUserQuestionInput))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let schema = self.input_schema();
        let mut input = input;
        coerce_input(&mut input, &schema);
        validate_input_against_schema(&input, &schema)
            .map_err(|detail| ToolError::InvalidInput(ask_user_question_error(detail)))?;
        let input: AskUserQuestionInput = parse_input(&input)
            .map_err(|error| ToolError::InvalidInput(ask_user_question_error(error.to_string())))?;

        if input.questions.is_empty() {
            return Err(ToolError::InvalidInput(ask_user_question_error(
                "$.questions: expected 1-4 question objects, but got an empty array".to_string(),
            )));
        }
        if input.questions.len() > 4 {
            return Err(ToolError::InvalidInput(ask_user_question_error(format!(
                "$.questions: expected at most 4 question objects, but got {}",
                input.questions.len()
            ))));
        }
        for (question_index, q) in input.questions.iter().enumerate() {
            if q.question.trim().is_empty() {
                return Err(ToolError::InvalidInput(ask_user_question_error(format!(
                    "$.questions[{question_index}].question: question text cannot be empty"
                ))));
            }
            if q.header.trim().is_empty() {
                return Err(ToolError::InvalidInput(ask_user_question_error(format!(
                    "$.questions[{question_index}].header: header cannot be empty"
                ))));
            }
            if q.options.len() < 2 || q.options.len() > 4 {
                return Err(ToolError::InvalidInput(ask_user_question_error(format!(
                    "$.questions[{question_index}].options: expected an array with 2-4 option objects, but got {}. \
                     If you supplied a single option as an object, add at least one more option and wrap both in an array.",
                    q.options.len()
                ))));
            }
            for (option_index, option) in q.options.iter().enumerate() {
                if option.label.trim().is_empty() {
                    return Err(ToolError::InvalidInput(ask_user_question_error(format!(
                        "$.questions[{question_index}].options[{option_index}].label: label cannot be empty"
                    ))));
                }
                if option.description.trim().is_empty() {
                    return Err(ToolError::InvalidInput(ask_user_question_error(format!(
                        "$.questions[{question_index}].options[{option_index}].description: description cannot be empty"
                    ))));
                }
            }
        }

        let questioner = ctx
            .user_questioner
            .as_ref()
            .ok_or_else(|| ToolError::Execution("user questioner is not available".to_string()))?;

        let request = crate::user_question::UserQuestionRequest {
            questions: input
                .questions
                .into_iter()
                .map(|q| crate::user_question::Question {
                    question: q.question,
                    header: q.header,
                    options: q
                        .options
                        .into_iter()
                        .map(|o| crate::user_question::QuestionOption {
                            label: o.label,
                            description: o.description,
                            preview: o.preview,
                        })
                        .collect(),
                    multi_select: q.multi_select,
                })
                .collect(),
            answers: input.answers,
            annotations: input.annotations,
        };

        let elicitation_result = ctx
            .emit_lifecycle_hook(
                "Elicitation",
                "AskUserQuestion",
                serde_json::json!({
                    "request": request.clone(),
                    "source": "AskUserQuestion",
                }),
            )
            .await?;
        if elicitation_result.should_block() {
            return Err(lifecycle_block_error("Elicitation", &elicitation_result));
        }

        let response = questioner
            .ask(request.clone())
            .await
            .map_err(|e| ToolError::Execution(format!("failed to ask user: {}", e)))?;

        let elicitation_result_hook = ctx
            .emit_lifecycle_hook(
                "ElicitationResult",
                "AskUserQuestion",
                serde_json::json!({
                    "request": request.clone(),
                    "response": response.clone(),
                    "source": "AskUserQuestion",
                }),
            )
            .await?;
        if elicitation_result_hook.should_block() {
            return Err(lifecycle_block_error(
                "ElicitationResult",
                &elicitation_result_hook,
            ));
        }

        let decision_audit = record_orchestrate_human_decisions(ctx, &response);

        let output = serde_json::json!({
            "questions": response.questions,
            "answers": response.answers,
            "annotations": response.annotations,
            "decision_audit": decision_audit,
        });

        let mut output = ToolOutput::text(output.to_string());
        append_lifecycle_messages(&mut output, "Elicitation", &elicitation_result);
        append_lifecycle_messages(&mut output, "ElicitationResult", &elicitation_result_hook);
        Ok(output)
    }
}

fn record_orchestrate_human_decisions(
    ctx: &ToolContext,
    response: &crate::user_question::UserQuestionResponse,
) -> Value {
    if !ctx.state.session_mode().is_orchestrate() {
        return serde_json::json!({"status": "not_applicable"});
    }
    let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&ctx.state.cwd());
    let snapshot = match store.read_active_work() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return serde_json::json!({
                "status": "degraded",
                "error": format!("active work unavailable: {error:#}")
            });
        }
    };
    let mut recorded = Vec::new();
    let mut failures = Vec::new();
    let existing_decisions = match store.read_human_decisions(&snapshot.work.work_id) {
        Ok(decisions) => decisions,
        Err(error) => {
            return serde_json::json!({
                "status": "degraded",
                "error": format!("human decision audit unavailable: {error:#}"),
                "next_action": "The authenticated user answers remain valid. Do not ask again solely because the append-only audit is unavailable."
            });
        }
    };
    for question in &response.questions {
        let Some(answer) = response.answers.get(&question.question) else {
            continue;
        };
        let question_id = digest_id("question", &question.question);
        let option_id = question
            .options
            .iter()
            .find(|option| option.label == *answer)
            .map(|option| digest_id("option", &option.label));
        let answer_summary = redact_decision_summary(answer);
        let decision_material = format!(
            "{}\0{}\0{}\0{}\0{}",
            ctx.state.session_id(),
            snapshot.work.work_id,
            snapshot.work.revision,
            question_id,
            answer_summary
        );
        let decision_id = digest_id("decision", &decision_material);
        let supersedes = existing_decisions
            .iter()
            .rev()
            .find(|saved| saved.question_id == question_id && saved.decision_id != decision_id)
            .map(|saved| saved.decision_id.clone());
        let record = kcoder_state::orchestrate_store::HumanDecisionRecord {
            decision_id,
            work_id: snapshot.work.work_id.clone(),
            plan_revision: snapshot.work.revision,
            task_id: None,
            question_id,
            option_id,
            answer_summary,
            actor: kcoder_state::orchestrate_store::DecisionActor::User,
            recorded_at: chrono::Utc::now(),
            supersedes,
            stale: false,
        };
        match store.append_human_decision(&snapshot.work.work_id, record) {
            Ok(saved) => {
                ctx.state.record_orchestrate_runtime_event_after_commit(
                    "human_decision_recorded",
                    Some(&saved.work_id),
                    saved.task_id.as_deref(),
                    None,
                    None,
                    serde_json::json!({
                        "decision_id": saved.decision_id.clone(),
                        "plan_revision": saved.plan_revision,
                        "stale": saved.stale,
                        "actor": "user",
                    }),
                );
                recorded.push(saved.decision_id)
            }
            Err(error) => failures.push(format!("decision audit append failed: {error:#}")),
        }
    }
    if failures.is_empty() {
        serde_json::json!({"status": "recorded", "decision_ids": recorded})
    } else {
        serde_json::json!({
            "status": "degraded",
            "decision_ids": recorded,
            "errors": failures,
            "next_action": "The user answers are valid and returned above, but the append-only decision audit is degraded. Do not ask the same question again; report the infrastructure issue."
        })
    }
}

fn digest_id(prefix: &str, value: &str) -> String {
    format!("{prefix}_{:x}", Sha256::digest(value.as_bytes()))
}

fn redact_decision_summary(answer: &str) -> String {
    let normalized = answer.trim();
    let lower = normalized.to_ascii_lowercase();
    if lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("authorization:")
        || lower.contains("bearer ")
        || lower.contains("token=")
        || normalized.starts_with("sk-")
    {
        return "[redacted sensitive answer; see authenticated session transcript]".to_string();
    }
    normalized.chars().take(512).collect()
}

fn ask_user_question_error(detail: String) -> String {
    format!(
        "{detail}\n\
         Expected shape: {{\"questions\":[{{\"question\":\"...\",\"header\":\"short_label\",\"options\":[{{\"label\":\"Option A\",\"description\":\"What happens if selected\"}},{{\"label\":\"Option B\",\"description\":\"What happens if selected\"}}],\"multi_select\":false}}]}}\n\
         Important: `questions` is always an array, even for one question. `options` is always an array with 2-4 option objects, even when there are only two choices."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user_question::{Question, QuestionOption, UserQuestionResponse};
    use kcoder_state::{AppState, orchestrate_store::PlanStore};

    fn plan() -> String {
        "# 决策测试\n\n## Context\n目标。\n\n## TODOs\n- [ ] 1. 实现动作\n  - artifacts: src/lib.rs\n  - write_scope: src/\n  - acceptance: focused test passes\n  - verify: cargo test\n\n## Final Verification Wave\n- [ ] F1. 工作区测试通过\n  - evidence: manual\n".to_string()
    }

    fn response(answer: &str) -> UserQuestionResponse {
        let question = Question {
            question: "选择运行策略？".to_string(),
            header: "策略".to_string(),
            options: vec![
                QuestionOption {
                    label: "保守".to_string(),
                    description: "保持现状".to_string(),
                    preview: None,
                },
                QuestionOption {
                    label: "积极".to_string(),
                    description: "继续推进".to_string(),
                    preview: None,
                },
            ],
            multi_select: false,
        };
        UserQuestionResponse {
            questions: vec![question.clone()],
            answers: HashMap::from([(question.question, answer.to_string())]),
            annotations: None,
        }
    }

    #[test]
    fn changed_authenticated_answer_appends_a_superseding_decision() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path());
        state.enter_orchestrate_before_first_message().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let work = store
            .create_work("decision", &plan(), &state.session_id(), true)
            .unwrap();
        let ctx = ToolContext::new(state);

        assert_eq!(
            record_orchestrate_human_decisions(&ctx, &response("保守"))["status"],
            "recorded"
        );
        assert_eq!(
            record_orchestrate_human_decisions(&ctx, &response("积极"))["status"],
            "recorded"
        );

        let decisions = store.read_human_decisions(&work.work.work_id).unwrap();
        assert_eq!(decisions.len(), 2);
        assert_eq!(
            decisions[1].supersedes.as_deref(),
            Some(decisions[0].decision_id.as_str())
        );
        assert_eq!(
            decisions[1].actor,
            kcoder_state::orchestrate_store::DecisionActor::User
        );
    }
}
