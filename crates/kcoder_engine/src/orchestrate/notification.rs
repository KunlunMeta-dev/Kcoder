pub const ACCEPTANCE_REMINDER: &str = "Before accepting: four questions — (1) trusted evidence? (2) codebase patterns? (3) matches EXPECTED OUTCOME? (4) MUST/MUST NOT honored? Use PlanProgress for current evidence IDs; when one verification wave covers multiple tasks, record them atomically with RecordTaskAcceptances.";

pub fn enrich_completion_notification(notification: &str, acceptance_pending: bool) -> String {
    if !acceptance_pending || notification.contains(ACCEPTANCE_REMINDER) {
        notification.to_string()
    } else {
        format!("{}\n{}", notification.trim_end(), ACCEPTANCE_REMINDER)
    }
}

pub fn enrich_review_vote_summary(notification: &str, summary: Option<&str>) -> String {
    let Some(summary) = summary.filter(|summary| !summary.trim().is_empty()) else {
        return notification.to_string();
    };
    if notification.contains(summary) {
        notification.to_string()
    } else {
        format!("{}\n{}", notification.trim_end(), summary.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_enriches_existing_notification_without_duplication() {
        let once = enrich_completion_notification("<subagent_notification />", true);
        assert!(once.contains(ACCEPTANCE_REMINDER));
        assert_eq!(enrich_completion_notification(&once, true), once);
        assert_eq!(enrich_completion_notification("plain", false), "plain");
    }

    #[test]
    fn structured_review_summary_is_appended_once() {
        let once = enrich_review_vote_summary(
            "<subagent_notification />",
            Some("ReviewVote: Reject (2/3)"),
        );
        assert_eq!(once.matches("ReviewVote: Reject (2/3)").count(), 1);
        assert_eq!(
            enrich_review_vote_summary(&once, Some("ReviewVote: Reject (2/3)")),
            once
        );
    }
}
