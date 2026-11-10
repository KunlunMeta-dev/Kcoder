//! Decode JSON string windows before base64, without allocating the attachment string.
use super::*;
pub(super) struct StringReader<'a, C> {
    archive: &'a ExternalHistoryReader,
    content: HistoricalValueRef,
    callback: &'a RefCell<&'a mut C>,
    progress: &'a Cell<u64>,
    offset: Option<u64>,
    pending: Cursor<Vec<u8>>,
    prefix: usize,
}
impl<'a, C: FnMut(HistoricalAttachmentStage, u64) -> bool> StringReader<'a, C> {
    pub(super) fn new(
        archive: &'a ExternalHistoryReader,
        content: HistoricalValueRef,
        callback: &'a RefCell<&'a mut C>,
        progress: &'a Cell<u64>,
        prefix: usize,
    ) -> Self {
        Self {
            archive,
            content,
            callback,
            progress,
            offset: Some(0),
            pending: Cursor::new(Vec::new()),
            prefix,
        }
    }
}
impl<C: FnMut(HistoricalAttachmentStage, u64) -> bool> Read for StringReader<'_, C> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            let read = self.pending.read(output)?;
            if read > 0 {
                return Ok(read);
            }
            let Some(offset) = self.offset else {
                return Ok(0);
            };
            let chunk = crate::history_display::text::read(
                self.archive,
                self.content.record,
                &self.content,
                offset,
                |_| {
                    (self.callback.borrow_mut())(
                        HistoricalAttachmentStage::Extracting,
                        self.progress.get(),
                    )
                },
            )
            .map_err(|_| std::io::Error::other("history_attachment_string_read_failed"))?;
            self.offset = chunk.next_offset;
            let bytes = chunk.text.into_bytes();
            let skip = self.prefix.min(bytes.len());
            self.prefix -= skip;
            self.pending = Cursor::new(bytes);
            self.pending.set_position(skip as u64);
        }
    }
}
