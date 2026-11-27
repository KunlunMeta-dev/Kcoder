//! Bounded CSV reader for exact application export verification.
use anyhow::{Result, ensure};

pub(super) fn read(bytes: &[u8]) -> Result<Vec<Vec<String>>> {
    ensure!(bytes.len() <= 65536, "APPLICATION_BUSINESS_RESULT_LIMIT");
    let text = std::str::from_utf8(bytes)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut chars = text.chars().peekable();
    let (mut records, mut row, mut field) = (Vec::new(), Vec::new(), String::new());
    let (mut quoted, mut closed) = (false, false);
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                    closed = true;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        match ch {
            '"' => {
                ensure!(
                    field.is_empty() && !closed,
                    "APPLICATION_BUSINESS_CSV_INVALID"
                );
                quoted = true;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                closed = false;
            }
            '\n' | '\r' => {
                if ch == '\r' {
                    ensure!(
                        chars.next() == Some('\n'),
                        "APPLICATION_BUSINESS_CSV_INVALID"
                    );
                }
                row.push(std::mem::take(&mut field));
                ensure!(row.len() <= 32, "APPLICATION_BUSINESS_CSV_INVALID");
                records.push(std::mem::take(&mut row));
                closed = false;
                ensure!(records.len() <= 101, "APPLICATION_BUSINESS_CSV_INVALID");
            }
            _ => {
                ensure!(!closed, "APPLICATION_BUSINESS_CSV_INVALID");
                field.push(ch);
            }
        }
        ensure!(row.len() <= 32, "APPLICATION_BUSINESS_CSV_INVALID");
    }
    ensure!(!quoted, "APPLICATION_BUSINESS_CSV_INVALID");
    if closed || !field.is_empty() || !row.is_empty() {
        row.push(field);
        records.push(row);
    }
    ensure!(
        records.len() <= 101 && records.iter().all(|row| row.len() <= 32),
        "APPLICATION_BUSINESS_CSV_INVALID"
    );
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reader_keeps_quoted_delimiters_newlines_empty_fields_and_rejects_broken_quotes() {
        assert_eq!(
            read(b"a,b\r\n\"one,two\",\"three\"\"four\"\r\n").unwrap(),
            vec![vec!["a", "b"], vec!["one,two", "three\"four"]]
        );
        assert_eq!(
            read(b"a,b\n\"one\ntwo\",\n").unwrap(),
            vec![vec!["a", "b"], vec!["one\ntwo", ""]]
        );
        assert!(read(b"a\n\"unterminated").is_err());
        assert!(read(b"a\n\"closed\"extra\n").is_err());
    }
}
