#[derive(Debug)]
struct LifecycleExtension {
    inner: Extension,
    field: &'static str,
}
#[async_trait::async_trait]
impl Tool for LifecycleExtension {
    fn name(&self) -> String {
        self.inner.name()
    }
    fn source(&self) -> ToolSource {
        self.inner.source()
    }
    fn description(&self) -> String {
        self.inner.description()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{self.field:{"type":"integer"}},"required":[self.field],"additionalProperties":false})
    }
    async fn call(&self, input: Value, context: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.inner.call(input, context).await
    }
}

#[tokio::test]
async fn changed_deferred_schema_or_source_requires_rediscovery_while_original_object_stays_pinned()
{
    for change_source in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let name = "plugin__office__read_table";
        let original = office(
            TestEngineBuilder::new(root.path())
                .tool_registry(ToolRegistry::new().register(LifecycleExtension {
                    inner: extension(name, &calls),
                    field: "sheet",
                }))
                .build_with_profile_directory(),
        );
        let native = original.active_tool_registry();
        search(&original, name).await;
        let frozen = original.deferred_tools_snapshot();
        let mut replacement = extension(name, &calls);
        if change_source {
            replacement.provenance = Some(ToolSource::Plugin {
                plugin: "replacement-plugin".into(),
                server: "office".into(),
                tool: name.into(),
            });
        }
        let current = original
            .clone()
            .with_turn_tools(ToolRegistry::new().register(LifecycleExtension {
                inner: replacement,
                field: if change_source { "sheet" } else { "new_sheet" },
            }));
        assert!(current.deferred_tools_snapshot().tools.get(name).is_none());
        let (blocked, _, _, _) = current
            .execute_model_request_tool(
                "old-binding",
                "tool_execute",
                json!({"tool_name":name,"arguments":{"sheet":1}}),
                &kcoder_permissions::AutoAllowPrompt,
                crate::deferred_tool_dispatch::ModelToolRegistry {
                    native: &native,
                    deferred: &frozen,
                    arrangement_mode: false,
                },
            )
            .await
            .unwrap();
        assert!(blocked.is_error);
        assert!(tool_output_text(&blocked).contains("source/schema changed"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let new_receipt = search(&current, name).await;
        assert_eq!(new_receipt["tools"][0]["availability"], "discovered");
        assert_eq!(new_receipt["already_returned"], 0);
        let field = if change_source { "sheet" } else { "new_sheet" };
        let (accepted, _, _, _) = current
            .execute_tool(
                "rediscovered",
                "tool_execute",
                json!({"tool_name":name,"arguments":{field:1}}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(!accepted.is_error, "{accepted:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // A different registry cannot mutate the original session's registered object.
        let (pinned, _, _, _) = original
            .execute_model_request_tool(
                "original-object",
                "tool_execute",
                json!({"tool_name":name,"arguments":{"sheet":1}}),
                &kcoder_permissions::AutoAllowPrompt,
                crate::deferred_tool_dispatch::ModelToolRegistry {
                    native: &native,
                    deferred: &frozen,
                    arrangement_mode: false,
                },
            )
            .await
            .unwrap();
        assert!(!pinned.is_error, "{pinned:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
