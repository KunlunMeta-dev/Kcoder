//! Read-only original private Runtime provenance. This is not execution authority.
use super::*;

pub struct NativeRuntimeSourceIntent {
    storage: Arc<RuntimeStorage>,
    operation: String,
    intent: String,
}
impl NativeRuntimeDriver {
    pub fn observe_source_intent(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<NativeRuntimeSourceIntent>> {
        let Some(storage) = Self::observe_storage(context)? else {
            return Ok(None);
        };
        NativeRuntimeSourceIntent::read(storage, context, operation)
    }

    pub fn source_intent(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<NativeRuntimeSourceIntent>> {
        self.check(context)?;
        NativeRuntimeSourceIntent::read(self.storage.clone(), context, operation)
    }
}
impl NativeRuntimeSourceIntent {
    fn read(
        storage: Arc<RuntimeStorage>,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<Self>> {
        let Some(binding) = storage.bindings.get(operation)? else {
            ensure!(
                storage.ledger.read(operation)?.is_none(),
                "RUNTIME_ORIGINAL_INTENT_UNCONFIRMED"
            );
            return Ok(None);
        };
        let source = Self {
            storage,
            operation: operation.into(),
            intent: binding.intent_sha256,
        };
        source.original(context)?;
        Ok(Some(source))
    }
    pub fn prepared(&self, context: &NativeIntegrationContext) -> Result<PreparedRuntimeTask> {
        self.original(context)?;
        Ok(self
            .storage
            .bindings
            .get(&self.operation)?
            .context("RUNTIME_ORIGINAL_INTENT_UNCONFIRMED")?
            .spec)
    }
    pub fn original(&self, context: &NativeIntegrationContext) -> Result<IntegrationRequest> {
        context.verify()?;
        self.storage.verify()?;
        let binding = self
            .storage
            .bindings
            .get(&self.operation)?
            .context("RUNTIME_ORIGINAL_INTENT_UNCONFIRMED")?;
        context.validate_scope(&binding.source_scope)?;
        ensure!(
            binding.operation_id == self.operation && binding.intent_sha256 == self.intent,
            "RUNTIME_ORIGINAL_INTENT_CHANGED"
        );
        Ok(binding.original_request)
    }
}
