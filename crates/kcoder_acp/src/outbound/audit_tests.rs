use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FailedJournal {
    dispatched: AtomicUsize,
    unknown: AtomicUsize,
}

impl OutboundHost for FailedJournal {
    fn verify_runner(&self, _: &InstalledOutboundRunner) -> Result<()> {
        Ok(())
    }
    fn check_current(&self) -> Result<()> {
        Ok(())
    }
    fn deadline(&self) -> tokio::time::Instant {
        tokio::time::Instant::now() + Duration::from_secs(5)
    }
    fn before_effect(&self, _: OutboundEffect, _: &Value) -> Result<()> {
        ensure!(
            self.dispatched.fetch_add(1, Ordering::SeqCst) == 0,
            "Original fixture dispatch already recorded"
        );
        Ok(())
    }
    fn record_receipt(&self, _: OutboundEffect, _: &Value) -> Result<()> {
        bail!("Unexpected fixture receipt")
    }
    fn record_unknown(&self, _: OutboundEffect) -> Result<()> {
        self.unknown.fetch_add(1, Ordering::SeqCst);
        bail!("PRIVATE_JOURNAL_DETAIL")
    }
}

#[tokio::test]
async fn launch_outcome_is_fixed_when_its_unknown_receipt_cannot_be_recorded() {
    let owned = tempfile::tempdir().unwrap();
    let config = InstalledOutboundRunner::from_native_installation(
        PathBuf::from("/usr/bin/false"),
        Vec::new(),
        BTreeMap::new(),
        owned.path().to_owned(),
        owned.path().join("missing-owner"),
        "owned-fixture".into(),
        "1".into(),
    )
    .unwrap();
    let host = Arc::new(FailedJournal {
        dispatched: AtomicUsize::new(0),
        unknown: AtomicUsize::new(0),
    });
    let error = OutboundAcp::spawn(&config, host.clone())
        .err()
        .expect("the missing owned launcher must fail");
    assert_eq!(
        error.to_string(),
        "Outbound ACP launch outcome and unknown receipt are unconfirmed"
    );
    assert!(!format!("{error:#}").contains("PRIVATE_JOURNAL_DETAIL"));
    assert_eq!(host.unknown.load(Ordering::SeqCst), 1);
    assert!(OutboundAcp::spawn(&config, host.clone()).is_err());
    assert_eq!(
        host.unknown.load(Ordering::SeqCst),
        1,
        "the original dispatch cannot be replayed"
    );
}
