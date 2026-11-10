//! Search constraints are explicit capabilities, never best-effort silent widening.

use crate::search::SearchFailure;
use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use kcoder_tool_error::ToolError;
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchPageV1, WebSearchProvider};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const LANGUAGES: &[&str] = &[
    "ar", "de", "en", "en-GB", "en-US", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "pt-BR",
    "ru", "th", "vi", "zh", "zh-CN", "zh-TW", "zh-Hans", "zh-Hant",
];
const REGIONS: &[&str] = &[
    "AE", "AU", "BR", "CA", "CN", "DE", "ES", "FR", "GB", "HK", "ID", "IN", "IT", "JP", "KR", "PT",
    "RU", "SG", "TH", "TW", "US", "VN",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchTimeRange {
    Day,
    Week,
    Month,
    Year,
}
impl SearchTimeRange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
        }
    }
    fn days(self) -> i64 {
        match self {
            Self::Day => 1,
            Self::Week => 7,
            Self::Month => 30,
            Self::Year => 365,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchFreshness {
    #[default]
    Default,
    Live,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SearchConstraints {
    /// Rolling UTC publication windows: 24 hours, 7 days, 30 days or 365 days.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_range: Option<SearchTimeRange>,
    /// Supported language codes are validated independently of the backend's capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// This is a source search-market constraint, not evidence of a page's country of origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// Live bypasses result caches; it does not establish a publication date.
    #[serde(default)]
    pub freshness: SearchFreshness,
}

/// Only adapter code may opt in after implementing the exact parameter semantics.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderConstraintCapabilities {
    pub native_time_range: bool,
    pub language: bool,
    pub region: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintPlan {
    pub requested_time_range: Option<SearchTimeRange>,
    pub native_time_range: Option<SearchTimeRange>,
    pub broader_native_window: bool,
    pub required_publication_filter: bool,
    pub language: Option<String>,
    pub region: Option<String>,
    pub bypass_cache: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintFilterReport {
    pub applied: bool,
    pub retained: usize,
    pub dropped_unknown_date: usize,
    pub dropped_ambiguous_date: usize,
    pub dropped_outside_window: usize,
    pub dropped_future_date: usize,
}
impl ConstraintFilterReport {
    /// Unknown or insufficient date precision limits coverage, not the requested boundary.
    pub fn limited_by_date_evidence(&self) -> bool {
        self.dropped_unknown_date > 0 || self.dropped_ambiguous_date > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublicationWindow {
    pub since: DateTime<Utc>,
    pub until: DateTime<Utc>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicationDate {
    Timestamp(DateTime<Utc>),
    CalendarDate(NaiveDate),
}

impl SearchConstraints {
    /// Accept the full tool input while reading only this module's documented fields.
    pub fn parse(input: &Value) -> Result<Self, ToolError> {
        if !input.is_object() {
            return Err(invalid("input must be an object"));
        }
        let mut constraints: Self = serde_json::from_value(input.clone()).map_err(|_| invalid(
            "time_range must be day/week/month/year; language and region must be supported codes; freshness must be default/live"
        ))?;
        constraints.language = constraints
            .language
            .as_deref()
            .map(canonical_language)
            .transpose()?;
        constraints.region = constraints
            .region
            .as_deref()
            .map(canonical_region)
            .transpose()?;
        Ok(constraints)
    }
    pub fn validate(&self) -> Result<(), ToolError> {
        self.language
            .as_deref()
            .map(canonical_language)
            .transpose()?;
        self.region.as_deref().map(canonical_region).transpose()?;
        Ok(())
    }
    pub fn bypass_cache(&self) -> bool {
        self.freshness == SearchFreshness::Live
    }
    /// Cache identity includes all canonical constraints. A live request still bypasses cache reads/writes.
    pub fn cache_key_fragment(&self) -> Result<String, ToolError> {
        let normalized = Self::parse(
            &serde_json::to_value(self).map_err(|_| invalid("constraints could not be encoded"))?,
        )?;
        serde_json::to_string(&normalized).map_err(|_| invalid("constraints could not be encoded"))
    }
    pub fn plan(
        &self,
        provider: WebSearchProvider,
        capabilities: ProviderConstraintCapabilities,
    ) -> Result<ConstraintPlan, SearchFailure> {
        self.validate().map_err(|_| {
            SearchFailure::new(
                WebSearchErrorKind::InvalidInput,
                "Search constraints are invalid",
                false,
            )
        })?;
        if self.language.is_some() && !capabilities.language {
            return Err(unsupported(
                "The search source does not support the requested language constraint",
            ));
        }
        if self.region.is_some() && !capabilities.region {
            return Err(unsupported(
                "The search source does not support the requested region constraint",
            ));
        }
        let native_time_range = self
            .time_range
            .filter(|_| capabilities.native_time_range)
            .map(|range| {
                // SearXNG has no native week parameter. The broader month still requires strict local verification.
                if provider == WebSearchProvider::Searxng && range == SearchTimeRange::Week {
                    SearchTimeRange::Month
                } else {
                    range
                }
            });
        Ok(ConstraintPlan {
            requested_time_range: self.time_range,
            native_time_range,
            broader_native_window: native_time_range.is_some()
                && native_time_range != self.time_range,
            required_publication_filter: self.time_range.is_some(),
            language: self
                .language
                .as_deref()
                .map(canonical_language)
                .transpose()
                .map_err(|_| unsupported("Language constraint unavailable"))?,
            region: self
                .region
                .as_deref()
                .map(canonical_region)
                .transpose()
                .map_err(|_| unsupported("Region constraint unavailable"))?,
            bypass_cache: self.bypass_cache(),
        })
    }
    /// Rolling UTC windows are 24 hours, 7 days, 30 days and 365 days.
    pub fn publication_window(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<PublicationWindow>, ToolError> {
        self.time_range
            .map(|range| {
                let since = now
                    .checked_sub_signed(TimeDelta::days(range.days()))
                    .ok_or_else(|| {
                        ToolError::Execution(
                            "Target time cannot represent the publication window".into(),
                        )
                    })?;
                Ok(PublicationWindow { since, until: now })
            })
            .transpose()
    }
    /// Filter only recorded publication dates; URL, title and date strings remain unchanged.
    pub fn filter_page(
        &self,
        page: &mut WebSearchPageV1,
        now: DateTime<Utc>,
    ) -> Result<ConstraintFilterReport, ToolError> {
        self.validate()?;
        let Some(window) = self.publication_window(now)? else {
            return Ok(ConstraintFilterReport {
                retained: page.results.len(),
                ..Default::default()
            });
        };
        let mut report = ConstraintFilterReport {
            applied: true,
            ..Default::default()
        };
        page.results.retain(|hit| {
            let Some(date) = hit.published_at.as_deref().and_then(parse_publication_date) else {
                report.dropped_unknown_date += 1;
                return false;
            };
            let keep = match date {
                PublicationDate::Timestamp(date) if date > window.until => {
                    report.dropped_future_date += 1;
                    false
                }
                PublicationDate::Timestamp(date) if date < window.since => {
                    report.dropped_outside_window += 1;
                    false
                }
                PublicationDate::Timestamp(_) => true,
                PublicationDate::CalendarDate(date) => {
                    let start = date.and_hms_opt(0, 0, 0).expect("valid midnight").and_utc();
                    let end = date
                        .and_hms_nano_opt(23, 59, 59, 999_999_999)
                        .expect("valid final instant")
                        .and_utc();
                    if start > window.until {
                        report.dropped_future_date += 1;
                        false
                    } else if end < window.since {
                        report.dropped_outside_window += 1;
                        false
                    } else if start < window.since || end > window.until {
                        // A day is not an instant: either partial boundary intersection remains unknown.
                        report.dropped_ambiguous_date += 1;
                        false
                    } else {
                        true
                    }
                }
            };
            report.retained += usize::from(keep);
            keep
        });
        Ok(report)
    }
}

pub fn parse_publication_date(value: &str) -> Option<PublicationDate> {
    if value.len() > 128 || value.chars().any(char::is_control) {
        return None;
    }
    let value = value.trim();
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Some(PublicationDate::Timestamp(date.with_timezone(&Utc)));
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(value) {
        return Some(PublicationDate::Timestamp(date.with_timezone(&Utc)));
    }
    // Pinned SearXNG b00212a8 also exposes pubdate via "%Y-%m-%d %H:%M:%S%z".
    // Every accepted form still requires an explicit numeric offset; naive times remain unknown.
    for format in [
        "%Y-%m-%d %H:%M:%S%.f%:z",
        "%Y-%m-%d %H:%M:%S%.f%z",
        "%Y-%m-%d %H:%M:%S%.f %:z",
        "%Y-%m-%d %H:%M:%S%.f %z",
    ] {
        if let Ok(date) = DateTime::parse_from_str(value, format) {
            return Some(PublicationDate::Timestamp(date.with_timezone(&Utc)));
        }
    }
    if value.len() == 10 {
        let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
        if date.format("%Y-%m-%d").to_string() == value {
            return Some(PublicationDate::CalendarDate(date));
        }
    }
    None
}
fn canonical_language(value: &str) -> Result<String, ToolError> {
    LANGUAGES
        .iter()
        .find(|code| code.eq_ignore_ascii_case(value))
        .map(|code| (*code).to_owned())
        .ok_or_else(|| invalid("language is not a supported language code"))
}
fn canonical_region(value: &str) -> Result<String, ToolError> {
    REGIONS
        .iter()
        .find(|code| code.eq_ignore_ascii_case(value))
        .map(|code| (*code).to_owned())
        .ok_or_else(|| invalid("region is not a supported search-market code"))
}
fn invalid(message: &str) -> ToolError {
    ToolError::InvalidInput(format!("WebSearch: {message}"))
}
fn unsupported(message: &str) -> SearchFailure {
    SearchFailure::new(WebSearchErrorKind::Unsupported, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::web_search::WebSearchHitV1;
    use serde_json::json;
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-31T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }
    fn hit(id: &str, date: Option<&str>) -> WebSearchHitV1 {
        WebSearchHitV1 {
            source_id: id.into(),
            title: id.into(),
            url: format!("https://example.com/{id}?original=1#part"),
            published_at: date.map(str::to_owned),
            ..Default::default()
        }
    }
    #[test]
    fn constraint_codes_are_bounded_and_never_inferred_from_query_text() {
        let constraints = SearchConstraints::parse(
            &json!({"query":"中文公告", "language":"EN-us", "region":"us", "freshness":"live"}),
        )
        .unwrap();
        assert_eq!(constraints.language.as_deref(), Some("en-US"));
        assert_eq!(constraints.region.as_deref(), Some("US"));
        assert!(constraints.bypass_cache());
        assert!(
            SearchConstraints::parse(&json!({"query":"中文公告"}))
                .unwrap()
                .language
                .is_none()
        );
        for value in [
            json!([]),
            json!({"time_range":"all"}),
            json!({"freshness":"preferred"}),
            json!({"language":"en;execute"}),
            json!({"language":" auto "}),
            json!({"region":"ZZ"}),
            json!({"region":"US\n"}),
            json!({"language":23}),
        ] {
            assert!(
                matches!(
                    SearchConstraints::parse(&value),
                    Err(ToolError::InvalidInput(_))
                ),
                "{value}"
            );
        }
    }
    #[test]
    fn live_bypasses_cache_but_does_not_create_a_date() {
        let default = SearchConstraints::parse(&json!({})).unwrap();
        assert!(!default.bypass_cache());
        let live = SearchConstraints::parse(&json!({"freshness":"live"})).unwrap();
        assert!(live.bypass_cache());
        assert_ne!(
            default.cache_key_fragment().unwrap(),
            live.cache_key_fragment().unwrap()
        );
        let mut page = WebSearchPageV1 {
            results: vec![hit("unknown", None)],
            ..Default::default()
        };
        assert_eq!(live.filter_page(&mut page, now()).unwrap().retained, 1);
        assert!(page.results[0].published_at.is_none());
    }
    #[test]
    fn date_parser_requires_explicit_absolute_evidence_and_keeps_precision() {
        assert!(matches!(
            parse_publication_date("2026-10-31"),
            Some(PublicationDate::CalendarDate(_))
        ));
        assert_eq!(
            parse_publication_date("2026-10-31T20:00:00+08:00"),
            Some(PublicationDate::Timestamp(now()))
        );
        assert_eq!(
            parse_publication_date("Sat, 31 Oct 2026 12:00:00 +0000"),
            Some(PublicationDate::Timestamp(now()))
        );
        for explicit in [
            "2026-10-31 12:00:00+0000",
            "2026-10-31 12:00:00+00:00",
            "2026-10-31 20:00:00 +0800",
            "2026-10-31 20:00:00.000 +08:00",
        ] {
            assert_eq!(
                parse_publication_date(explicit),
                Some(PublicationDate::Timestamp(now())),
                "{explicit}"
            );
        }
        for unknown in [
            "yesterday",
            "2 hours ago",
            "2026",
            "2026-10",
            "2026-1-1",
            "2026-02-30",
            "2026-10-31T12:00:00",
            "2026-10-31 12:00:00",
            "2026-10-31 12:00:00 PST",
            "1730000000",
            "2026-10-31\n",
        ] {
            assert!(parse_publication_date(unknown).is_none(), "{unknown}");
        }
    }
    #[test]
    fn strict_publication_windows_drop_unknown_future_and_ambiguous_boundary_dates() {
        let constraints = SearchConstraints::parse(&json!({"time_range":"day"})).unwrap();
        let mut page = WebSearchPageV1 {
            results: vec![
                hit("exact-boundary", Some("2026-10-30T12:00:00Z")),
                hit("inside", Some("2026-10-31T08:00:00+08:00")),
                hit("today", Some("2026-10-31")),
                hit("ambiguous", Some("2026-10-30")),
                hit("old", Some("2026-10-30T11:59:59Z")),
                hit("future", Some("2026-11-01")),
                hit("future-instant", Some("2026-10-31T12:00:01Z")),
                hit("unknown", None),
                hit("relative", Some("1 hour ago")),
            ],
            ..Default::default()
        };
        let original = page.results[1].clone();
        let report = constraints.filter_page(&mut page, now()).unwrap();
        assert_eq!(
            page.results
                .iter()
                .map(|hit| hit.source_id.as_str())
                .collect::<Vec<_>>(),
            ["exact-boundary", "inside"]
        );
        assert_eq!(page.results[1], original);
        assert_eq!(report.retained, 2);
        assert_eq!(report.dropped_unknown_date, 2);
        assert_eq!(report.dropped_ambiguous_date, 2);
        assert_eq!(report.dropped_outside_window, 1);
        assert_eq!(report.dropped_future_date, 2);
        assert!(report.limited_by_date_evidence());
    }
    #[test]
    fn week_for_searxng_is_a_broader_native_month_with_mandatory_post_filter() {
        let constraints = SearchConstraints::parse(&json!({"time_range":"week"})).unwrap();
        let plan = constraints
            .plan(
                WebSearchProvider::Searxng,
                ProviderConstraintCapabilities {
                    native_time_range: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(plan.native_time_range, Some(SearchTimeRange::Month));
        assert!(plan.broader_native_window);
        assert!(plan.required_publication_filter);
        let local = constraints
            .plan(
                WebSearchProvider::Exa,
                ProviderConstraintCapabilities::default(),
            )
            .unwrap();
        assert_eq!(local.native_time_range, None);
        assert!(local.required_publication_filter);
        for range in [
            SearchTimeRange::Day,
            SearchTimeRange::Week,
            SearchTimeRange::Month,
            SearchTimeRange::Year,
        ] {
            let constraints = SearchConstraints {
                time_range: Some(range),
                ..Default::default()
            };
            assert!(["day", "week", "month", "year"].contains(&range.as_str()));
            assert_eq!(
                constraints
                    .publication_window(now())
                    .unwrap()
                    .unwrap()
                    .since,
                now() - TimeDelta::days(range.days())
            );
        }
    }
    #[test]
    fn language_and_region_require_implemented_provider_capabilities() {
        for input in [json!({"language":"zh-CN"}), json!({"region":"CN"})] {
            let constraints = SearchConstraints::parse(&input).unwrap();
            for provider in [
                WebSearchProvider::Exa,
                WebSearchProvider::Searxng,
                WebSearchProvider::Bing,
            ] {
                let failure = constraints
                    .plan(provider, ProviderConstraintCapabilities::default())
                    .unwrap_err();
                assert_eq!(failure.kind, WebSearchErrorKind::Unsupported);
                assert!(!failure.request_sent);
            }
        }
        let constraints =
            SearchConstraints::parse(&json!({"language":"zh-CN", "region":"CN"})).unwrap();
        let plan = constraints
            .plan(
                WebSearchProvider::Searxng,
                ProviderConstraintCapabilities {
                    language: true,
                    region: true,
                    native_time_range: false,
                },
            )
            .unwrap();
        assert_eq!(plan.language.as_deref(), Some("zh-CN"));
        assert_eq!(plan.region.as_deref(), Some("CN"));
    }
    #[test]
    fn impossible_target_clock_cannot_turn_a_strict_window_into_unfiltered_results() {
        let constraints = SearchConstraints {
            time_range: Some(SearchTimeRange::Year),
            ..Default::default()
        };
        let mut page = WebSearchPageV1 {
            results: vec![hit("unknown", None)],
            ..Default::default()
        };
        assert!(
            constraints
                .filter_page(&mut page, DateTime::<Utc>::MIN_UTC)
                .is_err()
        );
        assert_eq!(page.results.len(), 1);
    }
    #[test]
    fn calendar_days_must_fit_both_window_boundaries_and_unconstrained_dates_are_unchanged() {
        let constraints = SearchConstraints {
            time_range: Some(SearchTimeRange::Week),
            ..Default::default()
        };
        let original = WebSearchPageV1 {
            results: vec![
                hit("lower-ambiguous", Some("2026-10-24")),
                hit("inside-day", Some("2026-10-30")),
                hit("upper-ambiguous", Some("2026-10-31")),
            ],
            ..Default::default()
        };
        let mut constrained = original.clone();
        let report = constraints.filter_page(&mut constrained, now()).unwrap();
        assert_eq!(
            constrained
                .results
                .iter()
                .map(|hit| hit.source_id.as_str())
                .collect::<Vec<_>>(),
            ["inside-day"]
        );
        assert_eq!(report.dropped_ambiguous_date, 2);
        let mut unconstrained = original.clone();
        let report = SearchConstraints::default()
            .filter_page(&mut unconstrained, now())
            .unwrap();
        assert!(!report.applied);
        assert_eq!(unconstrained, original);
        let end_of_day = DateTime::parse_from_rfc3339("2026-10-31T23:59:59.999999999Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut exact = WebSearchPageV1 {
            results: vec![hit("complete-day", Some("2026-10-31"))],
            ..Default::default()
        };
        assert_eq!(
            constraints
                .filter_page(&mut exact, end_of_day)
                .unwrap()
                .retained,
            1
        );
    }
}
