//! Calendar helpers without a date-time dependency.

pub(crate) const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// UTC calendar month `YYYY-MM` of a Unix epoch millisecond timestamp.
pub fn month_key(unix_ms: u64) -> String {
    let days = (unix_ms / DAY_MS) as i64;
    let (year, month, _) = civil_from_days(days);
    format!("{year:04}-{month:02}")
}

/// RFC 3339 UTC timestamp (`YYYY-MM-DDTHH:MM:SS.mmmZ`) of Unix epoch ms.
pub fn rfc3339_from_unix_ms(unix_ms: u64) -> String {
    let days = (unix_ms / DAY_MS) as i64;
    let (year, month, day) = civil_from_days(days);
    let in_day = unix_ms % DAY_MS;
    let (hours, minutes) = (in_day / 3_600_000, in_day / 60_000 % 60);
    let (seconds, millis) = (in_day / 1000 % 60, in_day % 1000);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}
