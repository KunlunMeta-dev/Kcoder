//! Decode stored Excel booleans and date/time serials without evaluating formulas.
use super::{attr, error, text_event};
use crate::ToolError;
use chrono::{Duration, NaiveDate};
use quick_xml::{Reader, events::Event};
use std::collections::HashMap;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum Format {
    #[default]
    Number,
    Date,
    DateTime,
    Time,
    Duration,
}

pub(super) fn styles(xml: &str) -> Result<Vec<Format>, ToolError> {
    let mut reader = Reader::from_str(xml);
    let mut custom = HashMap::new();
    let mut formats = Vec::new();
    let mut cells = false;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| error("Malformed Excel styles"))?;
        text_event(&event)?;
        match event {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"numFmt" => {
                let id = attr(&e, b"numFmtId")?
                    .parse::<u32>()
                    .map_err(|_| error("Invalid Excel number format"))?;
                custom.insert(id, classify(&attr(&e, b"formatCode")?));
            }
            Event::Start(e) if e.local_name().as_ref() == b"cellXfs" => cells = true,
            Event::End(e) if e.local_name().as_ref() == b"cellXfs" => cells = false,
            Event::Start(e) | Event::Empty(e) if cells && e.local_name().as_ref() == b"xf" => {
                if formats.len() >= 200_000 {
                    return Err(error("Excel styles exceed limit"));
                }
                let number_format = attr(&e, b"numFmtId")?;
                let id = if number_format.is_empty() {
                    0
                } else {
                    number_format
                        .parse::<u32>()
                        .map_err(|_| error("Invalid Excel cell format"))?
                };
                formats.push(custom.get(&id).copied().unwrap_or(match id {
                    14..=17 | 27..=36 | 50..=58 => Format::Date,
                    18..=21 | 45 | 47 => Format::Time,
                    22 => Format::DateTime,
                    46 => Format::Duration,
                    _ => Format::Number,
                }));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(formats)
}

fn classify(code: &str) -> Format {
    let mut date = false;
    let mut time = false;
    let mut elapsed = false;
    let mut month = false;
    let mut chars = code.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                for c in chars.by_ref() {
                    if c == '"' {
                        break;
                    }
                }
            }
            '\\' | '_' | '*' => {
                chars.next();
            }
            '[' => {
                let mut text = String::new();
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                    text.push(c);
                }
                if matches!(
                    text.to_ascii_lowercase().as_str(),
                    "h" | "hh" | "m" | "mm" | "s" | "ss"
                ) {
                    elapsed = true;
                }
            }
            'y' | 'Y' | 'd' | 'D' => date = true,
            'h' | 'H' | 's' | 'S' => time = true,
            'm' | 'M' => month = true,
            _ => {}
        }
    }
    if elapsed {
        Format::Duration
    } else if date && time {
        Format::DateTime
    } else if date || (month && !time) {
        Format::Date
    } else if time {
        Format::Time
    } else {
        Format::Number
    }
}

pub(super) fn render(value: &str, format: Format, epoch_1904: bool) -> Result<String, ToolError> {
    if format == Format::Number || value.is_empty() {
        return Ok(value.into());
    }
    let serial = value
        .parse::<f64>()
        .map_err(|_| error("Invalid Excel date/time serial"))?;
    if !serial.is_finite() || !(0.0..=2_958_465.999_999).contains(&serial) {
        return Err(error("Excel date/time serial out of range"));
    }
    let seconds = (serial * 86400.0).round() as i64;
    if format == Format::Duration {
        return Ok(format!(
            "{}:{:02}:{:02}",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        ));
    }
    let days = seconds / 86400;
    let time = format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    );
    if format == Format::Time {
        return Ok(time);
    }
    // Excel's serial 60 deliberately represents a nonexistent leap day.
    let day = if !epoch_1904 && days == 60 {
        "1900-02-29 [Excel compatibility date]".into()
    } else {
        let base = if epoch_1904 {
            NaiveDate::from_ymd_opt(1904, 1, 1)
        } else {
            NaiveDate::from_ymd_opt(1899, 12, 31)
        }
        .unwrap();
        let offset = if !epoch_1904 && days > 60 {
            days - 1
        } else {
            days
        };
        base.checked_add_signed(Duration::days(offset))
            .ok_or_else(|| error("Excel date out of range"))?
            .format("%Y-%m-%d")
            .to_string()
    };
    Ok(if format == Format::Date && seconds % 86400 == 0 {
        day
    } else {
        format!("{day}T{time}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_both_epochs_leap_day_and_quoted_currency_labels() {
        assert_eq!(render("46297", Format::Date, false).unwrap(), "2026-10-02");
        assert_eq!(render("0", Format::Date, true).unwrap(), "1904-01-01");
        assert_eq!(render("61", Format::Date, false).unwrap(), "1900-03-01");
        assert!(
            render("60", Format::Date, false)
                .unwrap()
                .contains("compatibility date")
        );
        assert_eq!(
            render("46297.5", Format::DateTime, false).unwrap(),
            "2026-10-02T12:00:00"
        );
        assert_eq!(render("1.5", Format::Duration, false).unwrap(), "36:00:00");
        assert!(classify("0.00 \"days\"") == Format::Number);
        assert!(classify("[Red]yyyy-mm-dd hh:mm:ss") == Format::DateTime);
    }
}
