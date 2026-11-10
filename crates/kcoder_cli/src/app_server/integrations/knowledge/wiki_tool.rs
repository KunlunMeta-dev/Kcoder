//! Ordinary account Wiki tools use the real execution owner and live read policy.
use super::{authorize_observed_wiki_read, turn_memory::AcceptedAttempt};
use crate::app_server::integrations::core::ObservedReadScope;
use anyhow::{Context, Result, ensure};
use kcoder_engine::{QueryEngine, integrations::knowledge::NativeWikiReadFactory};
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, integrations::knowledge::CatalogReadLimits,
};
use kcoder_tools::{ToolContext, ToolError, ToolOutput, wiki::NativeWikiReadAccess};
use serde_json::{Value, json};
use std::{ffi::OsStr, sync::Arc};
mod management;

struct Factory {
    profile_path: std::path::PathBuf,
    profile_identity: String,
}
struct Reader {
    engine: QueryEngine,
    profile_path: std::path::PathBuf,
    profile_identity: String,
}
struct Call {
    observed: ObservedReadScope,
    identity: kcoder_types::TurnAttemptIdentity,
    accepted: AcceptedAttempt,
    cancel: tokio_util::sync::CancellationToken,
}
impl Call {
    fn verify(&self, engine: &QueryEngine) -> Result<()> {
        self.observed.verify()?;
        self.accepted.verify(engine, &self.identity)?;
        ensure!(!self.cancel.is_cancelled(), "WIKI_CANCELLED");
        Ok(())
    }
}

pub(crate) fn install(engine: QueryEngine) -> Result<QueryEngine> {
    let Some(path) = engine.settings_persistence_path() else {
        return Ok(engine);
    };
    let Some(observed) = ObservedReadScope::capture(
        path.parent().context("Wiki profile unavailable")?,
        &engine.state.cwd(),
    )?
    else {
        return Ok(engine);
    };
    let factory = Factory {
        profile_path: path,
        profile_identity: observed.profile()?.directory_identity()?,
    };
    Ok(engine.with_native_wiki_read_factory(Arc::new(factory)))
}

impl NativeWikiReadFactory for Factory {
    fn current_knowledge_settings(&self) -> Option<kcoder_config::KnowledgeSettings> {
        let profile =
            kcoder_config::PrivateDirectory::open_existing(self.profile_path.parent()?).ok()?;
        if profile.directory_identity().ok()? != self.profile_identity {
            return None;
        }
        let document = kcoder_config::read_settings_file(&self.profile_path).ok()?;
        serde_json::from_value(
            document
                .get("knowledge")
                .cloned()
                .unwrap_or_else(|| json!({})),
        )
        .ok()
    }
    fn bind(&self, actual: &QueryEngine) -> Arc<dyn NativeWikiReadAccess> {
        Arc::new(Reader {
            engine: actual.clone(),
            profile_path: self.profile_path.clone(),
            profile_identity: self.profile_identity.clone(),
        })
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
    })
}

impl Reader {
    fn capture_call(&self, actual: &ToolContext, organization: bool) -> Result<Call> {
        let execution = self.engine.native_tool_execution_witness();
        ensure!(
            execution.matches_state(&actual.state)
                && execution.session_id() == actual.state.session_id()
                && execution.attempt() == actual.state.current_history_attempt_identity().as_ref(),
            "WIKI_NATIVE_EXECUTION_CHANGED"
        );
        let identity = execution
            .attempt()
            .context("WIKI_NATIVE_ACCEPTED_REQUIRED")?;
        let accepted = AcceptedAttempt::capture(&self.engine, identity)?;
        let path = &self.profile_path;
        // The original factory owns this read profile. A rebuilt child does not
        // inherit a settings write target merely to use that same reader.
        ensure!(
            actual
                .settings_persistence_path()
                .is_none_or(|actual| actual == path)
                && self
                    .engine
                    .settings_persistence_path()
                    .is_none_or(|actual| actual == *path),
            "WIKI_NATIVE_PROFILE_CHANGED"
        );
        let observed = ObservedReadScope::capture(
            path.parent().context("Wiki profile unavailable")?,
            &self.engine.state.cwd(),
        )?
        .context("WIKI_NATIVE_SOURCE_AUTHORITY_REQUIRED")?;
        ensure!(
            observed.profile()?.directory_identity()? == self.profile_identity,
            "WIKI_NATIVE_PROFILE_CHANGED"
        );
        let document = kcoder_config::read_settings_file(path)?;
        let settings: kcoder_config::KnowledgeSettings = serde_json::from_value(
            document
                .get("knowledge")
                .cloned()
                .unwrap_or_else(|| json!({})),
        )?;
        if organization {
            ensure!(
                settings.can_organize(),
                "Wiki organization is disabled for this target"
            );
        } else {
            ensure!(
                settings.can_retrieve(),
                "Wiki retrieval is disabled for this target"
            );
        }
        let cancel = actual.abort_token.clone().unwrap_or_default();
        ensure!(!cancel.is_cancelled(), "WIKI_CANCELLED");
        Ok(Call {
            observed,
            identity: identity.clone(),
            accepted,
            cancel,
        })
    }
    fn read_current(
        &self,
        input: Value,
        actual: &ToolContext,
        organization: bool,
        jobs: bool,
    ) -> Result<ToolOutput> {
        let call = self.capture_call(actual, organization)?;
        let observed = &call.observed;
        authorize_observed_wiki_read(observed)?;
        let cancel = &call.cancel;
        let profile = observed.profile()?;
        let directory = match profile.open_child(OsStr::new("knowledge"), false) {
            Ok(directory) => Some(directory),
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        let exists = match &directory {
            Some(directory) => match directory.entry_metadata(OsStr::new("state.sqlite")) {
                Ok(_) => true,
                Err(error) if missing(&error) => false,
                Err(error) => return Err(error),
            },
            None => false,
        };
        let result = if exists {
            let directory = directory.context("Wiki source missing")?;
            let directory_identity = directory.directory_identity()?;
            let reader = KnowledgeCatalog::open_existing_native_directory(
                directory,
                OsStr::new("state.sqlite"),
                OsStr::new("state.objects"),
                cancel,
                CatalogReadLimits::default(),
            )?;
            let current =
                KnowledgeScope::from_authenticated_host(observed.principal(), "execution-host")?;
            let original = KnowledgeScope::from_authenticated_host(
                &format!("profile:{}", observed.canonical_profile_path().display()),
                "execution-host",
            )?;
            let (value, _) = reader.with_catalog(|catalog| {
                if jobs {
                    kcoder_tools::wiki_manage::read_jobs_observed(
                        input, catalog, &current, &original,
                    )
                } else {
                    kcoder_tools::wiki::read_observed_catalog(input, catalog, &current, &original)
                }
            })?;
            ensure!(
                profile
                    .open_child(OsStr::new("knowledge"), false)?
                    .directory_identity()?
                    == directory_identity,
                "WIKI_NATIVE_SOURCE_CHANGED"
            );
            value
        } else {
            ToolOutput::text(
                json!({"status":"empty","libraries":[],"next_cursor":null}).to_string(),
            )
        };
        authorize_observed_wiki_read(observed)?;
        call.verify(&self.engine)?;
        Ok(result)
    }
}

impl NativeWikiReadAccess for Reader {
    fn read(&self, input: Value, actual: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.read_for_mode(input, actual, false)
    }
    fn read_for_organization(
        &self,
        input: Value,
        actual: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        self.read_for_mode(input, actual, true)
    }
    fn read_jobs(&self, input: Value, actual: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.read_current(input, actual, true, true)
            .map_err(read_error)
    }
    fn begin_management(
        &self,
        input: &Value,
        actual: &ToolContext,
    ) -> Result<Box<dyn kcoder_tools::wiki::NativeWikiManagementGuard>, ToolError> {
        self.management(input, actual)
    }
}
impl Reader {
    fn read_for_mode(
        &self,
        input: Value,
        actual: &ToolContext,
        organization: bool,
    ) -> Result<ToolOutput, ToolError> {
        self.read_current(input, actual, organization, false)
            .map_err(read_error)
    }
}
fn read_error(error: anyhow::Error) -> ToolError {
    let message = match error.to_string().as_str() {
        "ORGANIZATION_RESOURCE_DENIED" => "WIKI_ORGANIZATION_READ_DENIED".into(),
        "knowledge library not found" => "knowledge library not found".into(),
        "Wiki retrieval is disabled for this target" => error.to_string(),
        "Wiki organization is disabled for this target" => error.to_string(),
        "WIKI_CANCELLED" => "WIKI_CANCELLED".into(),
        _ => "WIKI_NATIVE_READ_UNAVAILABLE".into(),
    };
    ToolError::Execution(message)
}

#[cfg(test)]
mod factory_settings_tests {
    use super::*;
    #[test]
    fn inherited_reader_switches_follow_only_the_original_profile() -> Result<()> {
        let root = tempfile::tempdir()?;
        let path = root.path().join("profile");
        let original = kcoder_config::PrivateDirectory::open_or_create(&path)?;
        let settings = path.join("settings.json");
        std::fs::write(&settings, r#"{"knowledge":{"retrieval_enabled":true}}"#)?;
        let factory = Factory {
            profile_path: settings.clone(),
            profile_identity: original.directory_identity()?,
        };
        assert!(factory.current_knowledge_settings().unwrap().can_retrieve());
        std::fs::write(&settings, r#"{"knowledge":{"retrieval_enabled":false}}"#)?;
        assert!(!factory.current_knowledge_settings().unwrap().can_retrieve());
        std::fs::rename(&path, root.path().join("retained-original"))?;
        kcoder_config::PrivateDirectory::open_or_create(&path)?;
        std::fs::write(&settings, r#"{"knowledge":{"retrieval_enabled":true}}"#)?;
        assert!(factory.current_knowledge_settings().is_none());
        Ok(())
    }
}
