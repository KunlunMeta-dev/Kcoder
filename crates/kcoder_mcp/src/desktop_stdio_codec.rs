use anyhow::{Result, ensure};
use std::io::BufRead;

pub(crate) fn bounded_line(reader: &mut impl BufRead) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            ensure!(bytes.is_empty(), "truncated desktop MCP frame");
            return Ok(None);
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let count = newline.map_or(available.len(), |i| i + 1);
        ensure!(
            bytes.len().saturating_add(count) <= crate::sse::MAX_MCP_FRAME_BYTES,
            "desktop MCP frame exceeds limit"
        );
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(Some(String::from_utf8(bytes)?));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_small_reader_buffers_adjacent_lines_and_clean_eof() {
        let input = b"{\"id\":1}\r\n{\"id\":2}\n";
        let mut reader = std::io::BufReader::with_capacity(2, &input[..]);
        assert_eq!(bounded_line(&mut reader).unwrap().unwrap(), "{\"id\":1}");
        assert_eq!(bounded_line(&mut reader).unwrap().unwrap(), "{\"id\":2}");
        assert!(bounded_line(&mut reader).unwrap().is_none());
    }
    #[test]
    fn rejects_truncated_invalid_utf8_and_oversized_frames() {
        for bytes in [
            b"partial".to_vec(),
            vec![255, 10],
            vec![b'x'; crate::sse::MAX_MCP_FRAME_BYTES + 1],
        ] {
            assert!(bounded_line(&mut std::io::Cursor::new(bytes)).is_err());
        }
    }
}
