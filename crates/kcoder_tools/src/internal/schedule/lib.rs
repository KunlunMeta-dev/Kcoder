//! Calendar calculations for previews and durable scheduler consumers.

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Offset, TimeZone, Timelike, Utc};
use kcoder_types::CronSchedule;

/// Host-controlled clock for deterministic previews; never creates or fires a job.
pub fn preview_schedule_after(
    schedule: &CronSchedule,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    match schedule {
        CronSchedule::At { at } => {
            let at = DateTime::parse_from_rfc3339(at)
                .map_err(|_| "at must be an RFC3339 timestamp".to_string())?
                .with_timezone(&Utc);
            if at > after {
                Ok(at)
            } else {
                Err("scheduled time must be in the future".to_string())
            }
        }
        CronSchedule::Every { every_seconds } if *every_seconds > 0 => {
            let interval = i64::try_from(*every_seconds)
                .ok()
                .and_then(ChronoDuration::try_seconds)
                .ok_or_else(|| "every_seconds is out of range".to_string())?;
            after
                .checked_add_signed(interval)
                .ok_or_else(|| "scheduled time is out of range".to_string())
        }
        CronSchedule::Every { .. } => Err("every_seconds must be greater than zero".to_string()),
        CronSchedule::Cron { expression } => next_cron_minute(expression, after),
        CronSchedule::ZonedCron {
            expression,
            timezone,
        } => {
            let timezone = timezone
                .parse::<chrono_tz::Tz>()
                .map_err(|_| "invalid IANA timezone".to_string())?;
            next_cron_minute_in_zone(expression, after, timezone)
        }
    }
}

fn next_cron_minute(expression: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    next_cron_minute_in_zone(expression, after, chrono_tz::UTC)
}

fn next_cron_minute_in_zone(
    expression: &str,
    after: DateTime<Utc>,
    timezone: chrono_tz::Tz,
) -> Result<DateTime<Utc>, String> {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(
            "cron expression must have 5 fields: minute hour day month weekday".to_string(),
        );
    }
    let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
    let masks = fields
        .iter()
        .zip(bounds)
        .map(|(field, (min, max))| cron_field_mask(field, min, max))
        .collect::<Result<Vec<_>, _>>()?;
    let mut cursor = after
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(after)
        .checked_add_signed(ChronoDuration::minutes(1))
        .ok_or_else(|| "scheduled time is out of range".to_string())?;
    // Scan absolute instants: nonexistent local minutes are skipped, and both
    // occurrences of a repeated local minute can match. Keep the existing
    // all-fields (AND), jitter, idle and missed-run semantics unchanged.
    for _ in 0..(366 * 24 * 60) {
        let offset = timezone
            .offset_from_utc_datetime(&cursor.naive_utc())
            .fix()
            .local_minus_utc();
        let local = cursor
            .naive_utc()
            .checked_add_signed(ChronoDuration::seconds(i64::from(offset)))
            .ok_or_else(|| "scheduled local time is out of range".to_string())?;
        let values = [
            local.minute(),
            local.hour(),
            local.day(),
            local.month(),
            local.weekday().num_days_from_sunday(),
        ];
        if masks
            .iter()
            .zip(values)
            .all(|(mask, value)| mask & (1u64 << value) != 0)
        {
            return Ok(cursor);
        }
        cursor = cursor
            .checked_add_signed(ChronoDuration::minutes(1))
            .ok_or_else(|| "scheduled time is out of range".to_string())?;
    }
    Err("cron expression has no trigger in the next 366 days".to_string())
}

fn cron_field_mask(field: &str, min: u32, max: u32) -> Result<u64, String> {
    let mut mask = 0u64;
    let number = |text: &str| -> Result<u32, String> {
        let value = text
            .parse::<u32>()
            .map_err(|_| "invalid cron field".to_string())?;
        if value < min || value > max {
            return Err("cron field is out of range".to_string());
        }
        Ok(value)
    };
    for part in field.split(',') {
        let (range, step) = if let Some((range, step)) = part.split_once('/') {
            let step = step
                .parse::<u32>()
                .map_err(|_| "invalid cron step".to_string())?;
            if step == 0 {
                return Err("cron step must be greater than zero".to_string());
            }
            (range, step)
        } else {
            (part, 1)
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (number(start)?, number(end)?)
        } else {
            let start = number(range)?;
            (start, if part.contains('/') { max } else { start })
        };
        if start > end {
            return Err("cron range is reversed".to_string());
        }
        for value in (start..=end).step_by(step as usize) {
            let value = if max == 7 && value == 7 { 0 } else { value };
            mask |= 1u64 << value;
        }
    }
    Ok(mask)
}

#[cfg(test)]
fn cron_field_matches(field: &str, value: u32, min: u32, max: u32) -> Result<bool, String> {
    Ok(cron_field_mask(field, min, max)? & (1u64 << value) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoned_calendar_keeps_weekdays_month_boundaries_and_dst_instants() {
        let next = |expression: &str, timezone: &str, after: &str| {
            preview_schedule_after(
                &CronSchedule::ZonedCron {
                    expression: expression.into(),
                    timezone: timezone.into(),
                },
                DateTime::parse_from_rfc3339(after)
                    .unwrap()
                    .with_timezone(&Utc),
            )
            .unwrap()
            .to_rfc3339()
        };
        assert_eq!(
            next("30 0 * * 1", "Asia/Tokyo", "2026-09-20T14:00:00Z"),
            "2026-09-20T15:30:00+00:00"
        );
        assert_eq!(
            next("30 0 * * 1-5", "Asia/Tokyo", "2026-09-20T14:00:00Z"),
            "2026-09-20T15:30:00+00:00"
        );
        assert_eq!(
            next("30 0 1 * *", "Asia/Tokyo", "2026-09-30T12:00:00Z"),
            "2026-09-30T15:30:00+00:00"
        );
        assert_eq!(
            next("30 23 1 * *", "America/New_York", "2026-03-01T00:00:00Z"),
            "2026-03-02T04:30:00+00:00"
        );
        assert_eq!(
            next("10 0 * * *", "Asia/Kathmandu", "2026-09-20T18:00:00Z"),
            "2026-09-20T18:25:00+00:00"
        );
        assert_eq!(
            next("30 2 * * *", "Europe/Berlin", "2026-03-28T23:00:00Z"),
            "2026-03-30T00:30:00+00:00"
        );
        assert_eq!(
            next("30 2 * * *", "Europe/Berlin", "2026-10-24T23:00:00Z"),
            "2026-10-25T00:30:00+00:00"
        );
        assert_eq!(
            next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:00Z"),
            "2026-10-25T01:30:00+00:00"
        );
        let legacy: CronSchedule =
            serde_json::from_value(serde_json::json!({"kind":"cron","expression":"30 0 * * 1"}))
                .unwrap();
        assert_eq!(
            preview_schedule_after(
                &legacy,
                DateTime::parse_from_rfc3339("2026-09-20T14:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
            .unwrap()
            .to_rfc3339(),
            "2026-09-21T00:30:00+00:00"
        );
        assert!(
            serde_json::from_value::<CronSchedule>(
                serde_json::json!({"kind":"cron","expression":"0 9 * * *","timezone":"Asia/Tokyo"})
            )
            .is_err()
        );
    }

    #[test]
    fn studio_weekday_expression_accepts_ranges_and_validates_every_field() {
        assert!(cron_field_matches("1-5", 1, 0, 7).unwrap());
        assert!(cron_field_matches("1-5", 5, 0, 7).unwrap());
        assert!(!cron_field_matches("1-5", 0, 0, 7).unwrap());
        assert!(cron_field_matches("10-20/5", 15, 0, 59).unwrap());
        assert!(!cron_field_matches("10-20/5", 16, 0, 59).unwrap());
        for invalid in ["5-1", "1-8", "*/0", "1,garbage"] {
            assert!(cron_field_matches(invalid, 1, 0, 7).is_err());
        }
    }

    #[test]
    fn cron_parser_supports_lists_steps_and_sunday_seven() {
        assert!(cron_field_matches("*/5", 10, 0, 59).unwrap());
        assert!(cron_field_matches("1,3,7", 3, 0, 7).unwrap());
        assert!(cron_field_matches("7", 0, 0, 7).unwrap());
    }
}
