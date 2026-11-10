//! Host-owned Wiki observation; locators and native dispatch receipts are separate.
use super::*;
use std::sync::Arc;

pub trait NativeWikiManagementGuard: Send + Sync {
    /// Execute only on the catalog held by this actual host guard. Older hosts
    /// fail closed; the tool must never reopen settings paths as a fallback.
    fn execute(&self, _input: Value, _actual: &ToolContext) -> Result<Value, ToolError> {
        Err(ToolError::Execution("WIKI_NATIVE_WRITE_UNAVAILABLE".into()))
    }
    fn finish(&self, actual: &ToolContext) -> Result<(), ToolError>;
    fn project_result(&self, result: Value) -> Result<Value, ToolError> {
        Ok(result)
    }
}

pub trait NativeWikiReadAccess: Send + Sync {
    fn read(&self, input: Value, actual: &ToolContext) -> Result<ToolOutput, ToolError>;
    fn read_for_organization(
        &self,
        _input: Value,
        _actual: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Execution(
            "WIKI_NATIVE_ORGANIZATION_READ_UNAVAILABLE".into(),
        ))
    }
    fn read_jobs(&self, _input: Value, _actual: &ToolContext) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Execution("WIKI_NATIVE_JOBS_UNAVAILABLE".into()))
    }
    /// Capture host authority and original resources only. Writable catalog
    /// initialization belongs in execute, after the tool's sandbox/settings gate.
    fn begin_management(
        &self,
        _input: &Value,
        _actual: &ToolContext,
    ) -> Result<Box<dyn NativeWikiManagementGuard>, ToolError> {
        Err(ToolError::Execution("WIKI_NATIVE_WRITE_UNAVAILABLE".into()))
    }
}

impl ToolContext {
    pub fn settings_persistence_path(&self) -> Option<&Path> {
        self.settings_persistence_path.as_deref()
    }

    pub fn with_native_wiki_read_access(
        mut self,
        access: Option<Arc<dyn NativeWikiReadAccess>>,
    ) -> Self {
        self.native_wiki_read_access = access;
        self
    }
}

/// Read rendering only. The owning host supplies a verified existing catalog
/// and both actual data scopes after current source authorization.
pub fn read_observed_catalog(
    input: Value,
    catalog: &KnowledgeCatalog,
    current: &KnowledgeScope,
    original: &KnowledgeScope,
) -> Result<ToolOutput> {
    let input = parse_input(input)?;
    let value = if input.action == "libraries" {
        let mut items = catalog.list(current, input.cursor.as_deref(), LIST_LIMIT + 1)?;
        items.extend(catalog.list(original, input.cursor.as_deref(), LIST_LIMIT + 1)?);
        items.sort_by(|left, right| left.id.cmp(&right.id));
        items.dedup_by(|left, right| left.id == right.id);
        let next = (items.len() > LIST_LIMIT).then(|| items[LIST_LIMIT - 1].id.clone());
        let rows: Vec<_> = items.into_iter().take(LIST_LIMIT)
            .map(|item| json!({"id":item.id,"name":item.name,"revision":item.revision,"archived":item.archived})).collect();
        json!({"libraries":rows,"next_cursor":next})
    } else {
        let selected = if let Some(library) = &input.library {
            match catalog.read(current, library) {
                Ok(_) => current,
                Err(error) if error.to_string() == "knowledge library not found" => {
                    catalog.read(original, library)?;
                    original
                }
                Err(error) => return Err(error),
            }
        } else if catalog.list(current, None, 1)?.is_empty() {
            original
        } else {
            current
        };
        run(catalog, selected, &input)?
    };
    Ok(ToolOutput::text(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn value(output: ToolOutput) -> Result<Value> {
        let crate::ContentBlock::Text { text, .. } = &output.content[0] else {
            anyhow::bail!("text output required")
        };
        Ok(serde_json::from_str(text)?)
    }

    #[test]
    fn observed_data_selection_preserves_current_priority_and_exact_original_owner() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
        let current = KnowledgeScope::from_authenticated_host("current-account", "execution-host")?;
        let original =
            KnowledgeScope::from_authenticated_host("profile:/actual-profile", "execution-host")?;
        let foreign =
            KnowledgeScope::from_authenticated_host("profile:/other-profile", "execution-host")?;
        let now = catalog.create(&current, "current", "Current UUID library", "")?;
        let old = catalog.create(&original, "original", "Original profile library", "")?;
        let other = catalog.create(&foreign, "foreign", "Other profile library", "")?;
        let selected = value(read_observed_catalog(
            json!({"action":"pages"}),
            &catalog,
            &current,
            &original,
        )?)?;
        assert_eq!(selected["library"], now.id);
        let fixed = value(read_observed_catalog(
            json!({"action":"pages","library":old.id}),
            &catalog,
            &current,
            &original,
        )?)?;
        assert_eq!(fixed["library"], old.id);
        assert!(
            read_observed_catalog(
                json!({"action":"pages","library":other.id}),
                &catalog,
                &current,
                &original
            )
            .is_err()
        );
        assert_eq!(catalog.read(&original, &old.id)?, old);
        assert!(catalog.read(&current, &old.id).is_err());
        assert!(
            read_observed_catalog(
                json!({"action":"libraries","claimedScope":"other"}),
                &catalog,
                &current,
                &original
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn merged_library_pages_keep_original_limit_and_raw_id_cursor() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
        let current = KnowledgeScope::from_authenticated_host("current-account", "execution-host")?;
        let original =
            KnowledgeScope::from_authenticated_host("profile:/actual-profile", "execution-host")?;
        let mut expected = Vec::new();
        for number in 0..12 {
            let scope = if number % 2 == 0 { &current } else { &original };
            expected.push(
                catalog
                    .create(scope, &format!("library-{number}"), "Owned library", "")?
                    .id,
            );
        }
        expected.sort();
        let first = value(read_observed_catalog(
            json!({"action":"libraries"}),
            &catalog,
            &current,
            &original,
        )?)?;
        assert_eq!(first["libraries"].as_array().unwrap().len(), LIST_LIMIT);
        let second = value(read_observed_catalog(
            json!({"action":"libraries","cursor":first["next_cursor"]}),
            &catalog,
            &current,
            &original,
        )?)?;
        assert_eq!(second["libraries"].as_array().unwrap().len(), 2);
        assert!(second["next_cursor"].is_null());
        let actual = first["libraries"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second["libraries"].as_array().unwrap())
            .map(|item| item["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
        Ok(())
    }

    struct CountedAccess(Arc<AtomicUsize>);
    impl NativeWikiReadAccess for CountedAccess {
        fn read(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(ToolOutput::text("owned adapter unit"))
        }
    }

    #[tokio::test]
    async fn host_reader_requires_same_native_object_state_call_and_final_input() -> Result<()> {
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let tool: Arc<dyn Tool> = Arc::new(WikiTool);
        let other = WikiTool;
        let context = ToolContext::new(kcoder_state::AppState::new(root.path()))
            .with_tool_call_id("actual-owned-wiki-call")
            .with_native_wiki_read_access(Some(Arc::new(CountedAccess(calls.clone()))));
        let input = json!({"action":"libraries"});
        assert!(tool.call(input.clone(), &context).await.is_err());
        assert!(
            tool.call(json!({"action":"libraries","approved":true}), &context)
                .await
                .is_err()
        );
        let actual = context.with_native_tool_invocation(&tool, &input)?;
        assert!(other.call(input.clone(), &actual).await.is_err());
        assert!(
            tool.call(json!({"action":"libraries","query":"changed"}), &actual)
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tool.call(input, &actual).await?;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        Ok(())
    }

    #[tokio::test]
    async fn read_only_host_does_not_grant_management_or_job_metadata() -> Result<()> {
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let tool: Arc<dyn Tool> = Arc::new(crate::wiki_manage::WikiManageTool);
        let context = ToolContext::new(kcoder_state::AppState::new(root.path()))
            .with_tool_call_id("actual-owned-management-call")
            .with_native_wiki_read_access(Some(Arc::new(CountedAccess(calls.clone()))));
        for input in [
            json!({"action":"create","request_key":"owned-key","name":"Owned library"}),
            json!({"action":"jobs","library":"owned-library"}),
        ] {
            let actual = context.clone().with_native_tool_invocation(&tool, &input)?;
            let error = tool.call(input, &actual).await.unwrap_err();
            assert!(error.to_string().contains("UNAVAILABLE"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(root.path().read_dir()?.count(), 0);
        Ok(())
    }
}
