use super::*;
fn epoch(at: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(at)
        .unwrap()
        .timestamp_millis()
        .try_into()
        .unwrap()
}
#[test]
fn business_preview_reuses_native_calendar_dst_and_timezone_rules() -> Result<()> {
    let schedule = kcoder_types::CronSchedule::ZonedCron {
        expression: "30 2 * * *".into(),
        timezone: "Europe/Berlin".into(),
    };
    assert_eq!(
        next_fire(&schedule, epoch("2026-03-28T23:00:00Z"))?,
        Some(epoch("2026-03-30T00:30:00Z"))
    );
    assert_eq!(
        next_fire(&schedule, epoch("2026-10-24T23:00:00Z"))?,
        Some(epoch("2026-10-25T00:30:00Z"))
    );
    assert_eq!(
        next_fire(&schedule, epoch("2026-10-25T00:30:00Z"))?,
        Some(epoch("2026-10-25T01:30:00Z"))
    );
    let invalid = kcoder_types::CronSchedule::ZonedCron {
        expression: "30 2 * * *".into(),
        timezone: "Invented/Timezone".into(),
    };
    assert!(next_fire(&invalid, epoch("2026-10-24T00:00:00Z")).is_err());
    Ok(())
}
#[test]
fn one_time_preview_has_no_synthetic_future_after_the_time_has_passed() -> Result<()> {
    let schedule = kcoder_types::CronSchedule::At {
        at: "2026-10-24T09:00:00Z".into(),
    };
    assert_eq!(
        next_fire(&schedule, epoch("2026-10-24T08:00:00Z"))?,
        Some(epoch("2026-10-24T09:00:00Z"))
    );
    assert_eq!(next_fire(&schedule, epoch("2026-10-24T10:00:00Z"))?, None);
    Ok(())
}
