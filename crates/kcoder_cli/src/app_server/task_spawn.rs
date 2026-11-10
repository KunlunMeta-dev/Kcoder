//! Share Tokio task instantiations for app-server futures and blocking work.

use futures::{FutureExt, future::BoxFuture};
use std::future::Future;
use tokio::task::{AbortHandle, JoinHandle, JoinSet};

#[track_caller]
pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let future: BoxFuture<'static, F::Output> = future.boxed();
    tokio::spawn(future)
}

#[track_caller]
pub fn spawn_blocking<F, T>(work: F) -> JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let work: Box<dyn FnOnce() -> T + Send> = Box::new(work);
    tokio::task::spawn_blocking(work)
}

pub trait JoinSetExt<T> {
    #[track_caller]
    fn spawn_shared<F>(&mut self, future: F) -> AbortHandle
    where
        F: Future<Output = T> + Send + 'static;
}

impl<T: Send + 'static> JoinSetExt<T> for JoinSet<T> {
    #[track_caller]
    fn spawn_shared<F>(&mut self, future: F) -> AbortHandle
    where
        F: Future<Output = T> + Send + 'static,
    {
        self.spawn(future.boxed())
    }
}
