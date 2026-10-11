//! Keep the headless driver alive after SIGINT so cancellation can finish cleanup.
use anyhow::{Context, Result};
use std::future::Future;
use std::time::Duration;

pub(super) struct Completion<T> {
    pub result: Option<T>,
    pub interrupted: bool,
    pub cleanup_complete: bool,
}

pub(super) async fn run_until_interrupt<R, S, C, CF>(
    run: R,
    signal: S,
    cancel: C,
    budget: Duration,
) -> Result<Completion<R::Output>>
where
    R: Future,
    S: Future<Output = std::io::Result<()>>,
    C: FnOnce() -> CF,
    CF: Future<Output = ()>,
{
    tokio::pin!(run, signal);
    tokio::select! {
        biased;
        received = &mut signal => {
            received.context("failed to listen for headless interruption")?;
            // Poll owned-job cleanup first: claim its handles before the
            // cancelled tool driver drops foreground guards and aborts them.
            let cleanup = cancel();
            let drained = tokio::time::timeout(budget, async {
                let (_, result) = tokio::join!(biased; cleanup, &mut run);
                result
            }).await;
            let cleanup_complete = drained.is_ok();
            Ok(Completion {
                result: drained.ok(),
                interrupted: true,
                cleanup_complete,
            })
        }
        result = &mut run => Ok(Completion {
            result: Some(result), interrupted: false, cleanup_complete: true,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[tokio::test]
    async fn interrupt_cancels_and_drains_both_driver_and_owned_cleanup() {
        let token = tokio_util::sync::CancellationToken::new();
        let cleanup_done = Arc::new(AtomicBool::new(false));
        let done = cleanup_done.clone();
        let signal = async { Ok(()) };
        let completion = run_until_interrupt(
            async {
                token.cancelled().await;
                7
            },
            signal,
            || {
                token.cancel();
                async move {
                    tokio::task::yield_now().await;
                    done.store(true, Ordering::SeqCst);
                }
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(completion.interrupted && completion.cleanup_complete);
        assert_eq!(completion.result, Some(7));
        assert!(cleanup_done.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stuck_cleanup_is_bounded_and_never_reported_complete() {
        let completion = run_until_interrupt(
            std::future::pending::<()>(),
            async { Ok(()) },
            std::future::pending::<()>,
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        assert!(completion.interrupted);
        assert!(!completion.cleanup_complete);
        assert!(completion.result.is_none());
    }

    #[tokio::test]
    async fn normal_completion_does_not_cancel_the_session() {
        let completion = run_until_interrupt(
            async { 3 },
            std::future::pending::<std::io::Result<()>>(),
            || async { panic!("unexpected interruption") },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(!completion.interrupted);
        assert_eq!(completion.result, Some(3));
    }
}
