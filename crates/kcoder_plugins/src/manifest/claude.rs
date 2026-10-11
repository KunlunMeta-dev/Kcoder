use super::PluginManifestError;
use super::external;
use crate::model::{PluginManifest, PluginManifestFormat};
use std::path::Path;

pub(super) fn parse(root: &Path, contents: &str) -> Result<PluginManifest, PluginManifestError> {
    external::parse(root, contents, PluginManifestFormat::Claude)
}
