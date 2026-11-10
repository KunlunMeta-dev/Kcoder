//! Streaming representation decoding, without vendor protocols or source execution.
use std::io::{BufReader, Read};

pub const ZSTD_MAX_WINDOW_LOG: u32 = 27;

/// All concatenated frames are consumed. The caller separately bounds output and
/// checks its expected digest; native back-reference allocation is bounded here.
pub fn zstd_decoder<R: Read>(
    reader: R,
) -> std::io::Result<zstd::stream::read::Decoder<'static, BufReader<R>>> {
    let mut decoder = zstd::stream::read::Decoder::new(reader)?;
    decoder.window_log_max(ZSTD_MAX_WINDOW_LOG)?;
    Ok(decoder)
}
