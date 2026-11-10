//! Request-only summary views. Original messages still own retention and commit semantics.
use anyhow::Result;
use kcoder_types::Message;

#[async_trait::async_trait]
pub(crate) trait CompactionMessageProjection: Send + Sync {
    async fn project(&self, messages: &[Message]) -> Result<Vec<Message>>;
}
