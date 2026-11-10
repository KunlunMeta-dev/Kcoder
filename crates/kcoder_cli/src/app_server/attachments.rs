use anyhow::Result;
use kcoder_app_protocol::{
    AttachmentReadChunkParams, AttachmentReadChunkResult, AttachmentReadParams,
    AttachmentReadResult,
};
use kcoder_engine::QueryEngine;
use kcoder_types::Message;
use std::ops::{Deref, DerefMut};

pub(super) use kcoder_attachments::{
    AttachmentCleanupSweep, attachment_save, attachment_upload_cancel, attachment_upload_chunk,
    attachment_upload_finish, attachment_upload_start, open_owned_staged_attachment,
};

#[derive(Default)]
pub(super) struct AttachmentDirectories {
    files: kcoder_attachments::AttachmentDirectories,
    pub(super) wiki_archives: super::knowledge_archive::ArchiveTransfers,
}

impl Deref for AttachmentDirectories {
    type Target = kcoder_attachments::AttachmentDirectories;

    fn deref(&self) -> &Self::Target {
        &self.files
    }
}

impl DerefMut for AttachmentDirectories {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.files
    }
}

pub(super) fn attachment_read(
    engine: &QueryEngine,
    params: &AttachmentReadParams,
    staged: &AttachmentDirectories,
) -> Result<AttachmentReadResult> {
    let root = engine
        .session_storage_dir_for(&params.thread_id)
        .join("attachments");
    kcoder_attachments::attachment_read(&root, params, staged)
}

pub(super) fn attachment_read_chunk(
    engine: &QueryEngine,
    params: &AttachmentReadChunkParams,
    staged: &AttachmentDirectories,
) -> Result<AttachmentReadChunkResult> {
    let root = engine
        .session_storage_dir_for(&params.thread_id)
        .join("attachments");
    kcoder_attachments::attachment_read_chunk(&root, params, staged)
}

pub(super) fn clone_fork_attachments(
    engine: &QueryEngine,
    source_thread_id: &str,
    fork_thread_id: &str,
    messages: &mut [Message],
) -> Result<()> {
    clone_fork_attachments_between(engine, engine, source_thread_id, fork_thread_id, messages)
}

pub(super) fn clone_fork_attachments_between(
    engine: &QueryEngine,
    destination_engine: &QueryEngine,
    source_thread_id: &str,
    fork_thread_id: &str,
    messages: &mut [Message],
) -> Result<()> {
    let source = engine
        .session_storage_dir_for(source_thread_id)
        .join("attachments");
    let destination = destination_engine
        .session_storage_dir_for(fork_thread_id)
        .join("attachments");
    kcoder_attachments::clone_fork_attachments(
        &source,
        &destination,
        source_thread_id,
        fork_thread_id,
        messages,
    )
}
