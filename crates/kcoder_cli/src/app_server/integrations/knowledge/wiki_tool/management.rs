//! Restrict the original current-UUID writer; this never writes a legacy data scope.
use super::*;
use crate::app_server::integrations::knowledge::authorize_observed_wiki_write;
use kcoder_config::PrivateDirectory;
use kcoder_tools::wiki::NativeWikiManagementGuard;

struct Guard {
    call: Call,
    engine: QueryEngine,
    knowledge: std::sync::Mutex<Option<PrivateDirectory>>,
    needs_read: bool,
    create_projection: Option<Value>,
}

impl Reader {
    pub(super) fn management(
        &self,
        input: &Value,
        actual: &ToolContext,
    ) -> Result<Box<dyn NativeWikiManagementGuard>, ToolError> {
        let result = (|| -> Result<Box<dyn NativeWikiManagementGuard>> {
            ensure!(
                matches!(
                    input.get("action").and_then(Value::as_str),
                    Some(
                        "create"
                            | "set_default"
                            | "rename"
                            | "import_text"
                            | "allocate_ids"
                            | "propose_pages"
                            | "pause"
                    )
                ),
                "WIKI_NATIVE_MANAGEMENT_UNAVAILABLE"
            );
            let call = self.capture_call(actual, true)?;
            let needs_read = input["action"] != "create";
            let create_projection =
                (!needs_read && call.observed.owner().organization_id.is_some()).then(|| {
                    json!({"status":"created_or_existing",
                    "requestKey":input["request_key"],
                    "name":input["name"].as_str().unwrap_or_default().trim(),
                    "purpose":input.get("purpose").and_then(Value::as_str).unwrap_or_default()})
                });
            if needs_read {
                authorize_observed_wiki_read(&call.observed).map_err(|error| {
                    if error.to_string() == "ORGANIZATION_RESOURCE_DENIED" {
                        anyhow::anyhow!("WIKI_ORGANIZATION_READ_DENIED")
                    } else {
                        error
                    }
                })?;
            }
            authorize_observed_wiki_write(&call.observed)?;
            let knowledge = match call
                .observed
                .profile()?
                .open_child(OsStr::new("knowledge"), false)
            {
                Ok(directory) => Some(directory),
                Err(error) if missing(&error) => None,
                Err(error) => return Err(error),
            };
            Ok(Box::new(Guard {
                call,
                engine: self.engine.clone(),
                knowledge: std::sync::Mutex::new(knowledge),
                needs_read,
                create_projection,
            }))
        })();
        result.map_err(|error| {
            ToolError::Execution(match error.to_string().as_str() {
                "ORGANIZATION_RESOURCE_DENIED" => "WIKI_ORGANIZATION_WRITE_DENIED".into(),
                "WIKI_ORGANIZATION_READ_DENIED" => "WIKI_ORGANIZATION_READ_DENIED".into(),
                "Wiki organization is disabled for this target" => error.to_string(),
                "WIKI_CANCELLED" => "WIKI_CANCELLED".into(),
                _ => "WIKI_NATIVE_WRITE_UNAVAILABLE".into(),
            })
        })
    }
}

impl NativeWikiManagementGuard for Guard {
    fn execute(&self, input: Value, actual: &ToolContext) -> Result<Value, ToolError> {
        // Capture performs no schema/object initialization. The tool checks its
        // settings and sandbox before this actual execution path can create data.
        self.finish(actual)?;
        let result = (|| -> Result<Value> {
            let directory = {
                let mut original = self
                    .knowledge
                    .lock()
                    .map_err(|_| anyhow::anyhow!("WIKI_NATIVE_WRITE_UNAVAILABLE"))?;
                if original.is_none() {
                    *original = Some(
                        self.call
                            .observed
                            .profile()?
                            .open_child(OsStr::new("knowledge"), true)?,
                    );
                }
                original
                    .as_ref()
                    .context("Wiki directory unavailable")?
                    .duplicate_handle()?
            };
            let scope = KnowledgeScope::from_authenticated_host(
                self.call.observed.principal(),
                "execution-host",
            )?;
            kcoder_knowledge::DirectoryKnowledgeWriter::open(directory)?.with_catalog(|catalog| {
                kcoder_tools::wiki_manage::execute_native_catalog(input, catalog, &scope)
            })
        })();
        result.map_err(|error| ToolError::Execution(format!("{error:#}")))
    }
    fn finish(&self, actual: &ToolContext) -> Result<(), ToolError> {
        let result = (|| -> Result<()> {
            let execution = self.engine.native_tool_execution_witness();
            ensure!(
                execution.matches_state(&actual.state),
                "WIKI_NATIVE_EXECUTION_CHANGED"
            );
            ensure!(
                actual.state.session_id() == self.call.identity.thread_id
                    && actual.state.current_history_attempt_identity().as_ref()
                        == Some(&self.call.identity),
                "WIKI_NATIVE_EXECUTION_CHANGED"
            );
            self.call.verify(&self.engine)?;
            let knowledge = self
                .knowledge
                .lock()
                .map_err(|_| anyhow::anyhow!("WIKI_NATIVE_SOURCE_CHANGED"))?;
            if let Some(knowledge) = knowledge.as_ref() {
                ensure!(
                    knowledge.directory_identity()?
                        == self
                            .call
                            .observed
                            .profile()?
                            .open_child(OsStr::new("knowledge"), false)?
                            .directory_identity()?,
                    "WIKI_NATIVE_SOURCE_CHANGED"
                );
            }
            if self.needs_read {
                authorize_observed_wiki_read(&self.call.observed)?;
            }
            authorize_observed_wiki_write(&self.call.observed)
        })();
        result.map_err(|_| ToolError::Execution("WIKI_WRITE_RESULT_NEEDS_RECONCILIATION".into()))
    }
    fn project_result(&self, result: Value) -> Result<Value, ToolError> {
        if let Some(projection) = &self.create_projection {
            let id = result.get("id").and_then(Value::as_str).ok_or_else(|| {
                ToolError::Execution("WIKI_WRITE_RESULT_NEEDS_RECONCILIATION".into())
            })?;
            let mut projection = projection.clone();
            projection["id"] = json!(id);
            Ok(projection)
        } else {
            Ok(result)
        }
    }
}
