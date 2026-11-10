use super::*;
use std::io::Write;
pub(super) fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
pub(super) fn optional(
    directory: &PrivateDirectory,
    name: &str,
    maximum: u64,
) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= maximum,
        "history_context_preparation_metadata_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= maximum,
        "history_context_preparation_metadata_budget_exceeded"
    );
    Ok(Some(bytes))
}
pub(super) fn read_json<T: serde::de::DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    maximum: u64,
) -> Result<T> {
    serde_json::from_slice(
        &optional(directory, name, maximum)?.context("history_context_preparation_missing")?,
    )
    .map_err(|_| anyhow::anyhow!("history_context_preparation_invalid_metadata"))
}
pub(super) fn exact(directory: &PrivateDirectory, name: &str, bytes: &[u8]) -> Result<()> {
    if let Some(previous) = optional(directory, name, bytes.len() as u64)? {
        ensure!(
            previous == bytes,
            "history_context_preparation_content_changed"
        );
        return Ok(());
    }
    directory.atomic_publish_from_reader(
        OsStr::new(name),
        &mut std::io::Cursor::new(bytes),
        false,
        || Ok(None),
    )?;
    Ok(())
}
struct Bounded {
    bytes: Vec<u8>,
    maximum: u64,
}
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.maximum.saturating_sub(self.bytes.len() as u64) {
            return Err(std::io::Error::other(
                "history_context_preparation_byte_budget_exceeded",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn encoded(value: &impl Serialize, maximum: u64) -> Result<Vec<u8>> {
    let mut output = Bounded {
        bytes: Vec::new(),
        maximum,
    };
    serde_json::to_writer(&mut output, value)
        .map_err(|_| anyhow::anyhow!("history_context_preparation_byte_budget_exceeded"))?;
    Ok(output.bytes)
}
