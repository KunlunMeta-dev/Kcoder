//! Explicit browser/backup files use a private namespace and never execute uploaded content.
pub mod manifest;
pub mod package;
pub use crate::source_transfer::uploads::{
    SOURCE_UPLOAD_PART_BYTES, SourceUploadMaterialization, SourceUploadVerification, SourceUploads,
};
