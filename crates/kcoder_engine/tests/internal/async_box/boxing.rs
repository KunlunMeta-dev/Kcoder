use async_trait::async_trait;
use futures::{executor::block_on, task::noop_waker};
use kcoder_async_box::shared;
use std::{
    rc::Rc,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

#[async_trait]
trait Borrowed {
    async fn borrow<'a>(&self, value: &'a str) -> &'a str;
}

struct Host;

#[async_trait]
#[shared]
impl Borrowed for Host {
    async fn borrow<'a>(&self, value: &'a str) -> &'a str {
        std::future::ready(()).await;
        value
    }
}

#[test]
fn preserves_dyn_dispatch_borrowed_output_and_send() {
    fn require_send<T: Send>(_: &T) {}
    let host: &dyn Borrowed = &Host;
    let input = String::from("original borrowed value");
    let future = host.borrow(&input);
    require_send(&future);
    assert_eq!(block_on(future).as_ptr(), input.as_ptr());
}

struct Guard(Arc<Mutex<Vec<&'static str>>>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.lock().unwrap().push("guard dropped");
    }
}

#[async_trait]
trait Cancellable {
    async fn wait(&self, guard: Guard);
}

#[async_trait]
#[shared]
impl Cancellable for Host {
    async fn wait(&self, guard: Guard) {
        guard.0.lock().unwrap().push("body polled");
        std::future::pending::<()>().await;
        drop(guard);
    }
}

#[test]
fn cancellation_keeps_argument_ownership_before_and_after_first_poll() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let future = Host.wait(Guard(events.clone()));
    assert!(events.lock().unwrap().is_empty());
    drop(future);
    assert_eq!(*events.lock().unwrap(), ["guard dropped"]);

    events.lock().unwrap().clear();
    let mut future = Host.wait(Guard(events.clone()));
    let waker = noop_waker();
    let mut context = Context::from_waker(&waker);
    assert_eq!(future.as_mut().poll(&mut context), Poll::Pending);
    assert_eq!(*events.lock().unwrap(), ["body polled"]);
    drop(future);
    assert_eq!(*events.lock().unwrap(), ["body polled", "guard dropped"]);
}

#[async_trait(?Send)]
trait Local {
    async fn value(&self, value: Rc<str>) -> usize;
}

#[async_trait(?Send)]
#[shared]
impl Local for Host {
    async fn value(&self, value: Rc<str>) -> usize {
        std::future::ready(()).await;
        value.len()
    }
}

#[test]
fn preserves_explicit_local_future_contract() {
    let value: Rc<str> = Rc::from("local");
    assert_eq!(block_on(Host.value(value)), 5);
}
