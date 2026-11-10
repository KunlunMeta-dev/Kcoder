use super::*;
use kcoder_tools::{UserQuestionRequest, UserQuestionResponse, UserQuestioner};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Default)]
struct InteractiveHost(Arc<AtomicUsize>);

#[async_trait::async_trait]
impl UserQuestioner for InteractiveHost {
    fn supports_agent_binding(&self) -> bool {
        true
    }

    fn bind_agent(
        &self,
        _: kcoder_types::SourceAgent,
        _: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Option<Arc<dyn UserQuestioner>> {
        Some(Arc::new(self.clone()))
    }

    async fn ask(&self, request: UserQuestionRequest) -> Result<UserQuestionResponse, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(UserQuestionResponse {
            questions: request.questions,
            answers: request.answers,
            annotations: request.annotations,
        })
    }
}

fn request() -> UserQuestionRequest {
    UserQuestionRequest {
        questions: vec![],
        answers: Default::default(),
        annotations: None,
    }
}

#[tokio::test]
async fn child_context_never_inherits_an_interactive_desktop_host() {
    let root = tempfile::tempdir().unwrap();
    let mut parent = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .build_with_profile_directory();
    let host = InteractiveHost::default();
    parent.set_user_questioner(Arc::new(host.clone()));
    assert!(parent.effective_user_questioner().supports_agent_binding());
    let child = SubagentContext::from_parent_with_agent_id(
        &parent,
        AppState::new(root.path()),
        SubagentContextOverrides::default(),
        "child".into(),
    );
    assert!(
        child
            .tool_context
            .user_questioner
            .as_ref()
            .unwrap()
            .ask(request())
            .await
            .is_err()
    );
    assert_eq!(host.0.load(Ordering::SeqCst), 0);
    assert!(
        parent
            .effective_user_questioner()
            .ask(request())
            .await
            .is_ok()
    );
    assert_eq!(host.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn child_engine_rejects_questions_even_when_host_is_reinjected() {
    let root = tempfile::tempdir().unwrap();
    let host = InteractiveHost::default();
    for depth in [1, 2] {
        let mut child = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
            .tool_registry(ToolRegistry::new().register(kcoder_tools::AskUserQuestionTool))
            .build_with_profile_directory()
            .with_agent_depth(depth);
        child.set_user_questioner(Arc::new(host.clone()));
        assert!(!child.effective_user_questioner().supports_agent_binding());
        child
            .permissions
            .write()
            .unwrap()
            .allow_for_session("AskUserQuestion");
        let (output, ..) = child.execute_tool(
            "forced-question", "AskUserQuestion",
            serde_json::json!({"questions": [{"question": "Choose a scope", "header": "Scope", "options": [
                {"label": "Small", "description": "Small scope"},
                {"label": "Large", "description": "Large scope"}
            ], "multi_select": false}]}),
            &AutoDenyPrompt,
        ).await.unwrap();
        assert!(output.is_error);
        assert!(
            serde_json::to_string(&output.content)
                .unwrap()
                .contains("interactive questions are not available")
        );
    }
    assert_eq!(host.0.load(Ordering::SeqCst), 0);
}
