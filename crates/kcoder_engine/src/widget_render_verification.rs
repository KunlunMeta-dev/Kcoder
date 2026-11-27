//! First-frame observations are bounded feedback, never content or business verification.
use super::*;
use kcoder_state::widgets::WidgetStore;
use kcoder_types::widgets::{WidgetRef, WidgetRenderObservation, WidgetRenderStatus};

impl QueryEngine {
    pub(super) async fn widget_render_feedback(
        &self,
        output: &ToolOutput,
        repairs_remaining: &mut u8,
    ) -> Vec<ContentBlock> {
        if !self.inline_widgets_enabled() {
            return Vec::new();
        }
        let Some(reference) =
            output
                .execution_metadata
                .iter()
                .find_map(|metadata| match metadata {
                    kcoder_tools::ToolExecutionMetadata::Widget(reference) => {
                        Some(reference.clone())
                    }
                    _ => None,
                })
        else {
            return Vec::new();
        };
        let Some(project) = self.state.session_artifact_project_dir() else {
            return Vec::new();
        };
        if reference.identity.thread_id != self.state.session_id() {
            return Vec::new();
        }
        let directory = kcoder_state::session_dir_path(&project, &reference.identity.thread_id);
        let cancel = self.cancel_token();
        let wait = async {
            loop {
                let directory = directory.clone();
                let reference = reference.clone();
                let created_at_ms = reference.created_at_ms;
                let observed = tokio::task::spawn_blocking(
                    move || -> anyhow::Result<Option<WidgetRenderObservation>> {
                        WidgetStore::open_existing(&directory, &reference.identity.thread_id)?
                            .map(|store| store.render_observation(&reference))
                            .transpose()
                            .map(Option::flatten)
                    },
                )
                .await;
                match observed {
                    Ok(Ok(Some(observation))) if observation.observed_at_ms >= created_at_ms => {
                        return Some(observation);
                    }
                    Ok(Ok(_)) => {}
                    _ => return None,
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let observation = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            result = tokio::time::timeout(Duration::from_secs(3), wait) => result.ok().flatten(),
        };
        vec![ContentBlock::Text {
            text: observation_feedback(&reference, observation, repairs_remaining).to_string(),
        }]
    }
}

fn observation_feedback(
    reference: &WidgetRef,
    observation: Option<WidgetRenderObservation>,
    repairs_remaining: &mut u8,
) -> Value {
    let mut feedback = serde_json::json!({"widget_id":reference.widget_id,"revision":reference.revision,
        "render_status":"unconfirmed","note":"No current client rendering observation was received. Do not claim visually verified. Keep the accessible summary; do not regenerate merely because a client was offline or offscreen."});
    if let Some(observation) = observation {
        match observation.status {
            WidgetRenderStatus::Rendered => {
                feedback["render_status"] = serde_json::json!("rendered");
                feedback["note"] = serde_json::json!(
                    "Client first-frame observation only. Verify data, calculations and external outcomes separately."
                );
            }
            WidgetRenderStatus::Failed => {
                let permitted = *repairs_remaining > 0;
                *repairs_remaining = repairs_remaining.saturating_sub(1);
                feedback["render_status"] = serde_json::json!("failed");
                feedback["error_code"] = serde_json::json!(observation.error_code);
                feedback["repair_allowed"] = serde_json::json!(permitted);
                feedback["repairs_remaining"] = serde_json::json!(*repairs_remaining);
                feedback["note"] = serde_json::json!(if permitted {
                    "Repair only this widget using its ID and expected_revision. Preserve older revisions. Never replay external operations to recreate a view."
                } else {
                    "The current task's two automatic rendering repairs are exhausted. Do not regenerate again automatically. Explain the rendering limitation and preserve the accessible summary."
                });
            }
        }
    }
    feedback
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_is_not_success_and_only_two_explicit_failures_offer_a_repair() {
        let reference: WidgetRef = serde_json::from_value(serde_json::json!({
            "widgetId":"fixture","threadId":"thread","turnId":"turn","attemptId":"attempt","toolCallId":"call",
            "revision":1,"title":"Chart","summary":"One value","format":"svg","executionMode":"managed",
            "libraries":[],"sha256":"fixture","bytes":1,"createdAtMs":1
        })).unwrap();
        let mut budget = 2;
        assert_eq!(
            observation_feedback(&reference, None, &mut budget)["render_status"],
            "unconfirmed"
        );
        assert_eq!(budget, 2);
        for expected in [true, true, false] {
            let feedback = observation_feedback(
                &reference,
                Some(WidgetRenderObservation {
                    status: WidgetRenderStatus::Failed,
                    error_code: Some("render_failed".into()),
                    observed_at_ms: 2,
                }),
                &mut budget,
            );
            assert_eq!(feedback["repair_allowed"], expected);
        }
        assert_eq!(budget, 0);
        assert_eq!(
            observation_feedback(
                &reference,
                Some(WidgetRenderObservation {
                    status: WidgetRenderStatus::Rendered,
                    error_code: None,
                    observed_at_ms: 3,
                }),
                &mut budget
            )["render_status"],
            "rendered"
        );
    }
}
