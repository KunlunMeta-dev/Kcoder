//! Retain the original bounded queue without exposing its recursive payload graph.
use std::sync::Arc;
use tokio::sync::mpsc::{Sender, error::TrySendError};

type Submit<T> = dyn Fn(T) -> Result<(), TrySendError<T>> + Send + Sync;

/// A sender capability over one existing queue. It creates no queue or task.
/// The callable boundary keeps recursive host request types out of client fields.
pub struct ControlSender<T> {
    submit: Arc<Submit<T>>,
}

impl<T> Clone for ControlSender<T> {
    fn clone(&self) -> Self {
        Self {
            submit: self.submit.clone(),
        }
    }
}

impl<T: Send + 'static> ControlSender<T> {
    pub fn new(sender: Sender<T>) -> Self {
        Self {
            submit: Arc::new(move |request| sender.try_send(request)),
        }
    }
}

impl<T> ControlSender<T> {
    /// Preserve Tokio's original Full/Closed result and the exact owned request.
    pub fn try_send(&self, request: T) -> Result<(), TrySendError<T>> {
        (self.submit)(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{mpsc, oneshot};

    struct Request {
        id: u8,
        receipt: oneshot::Sender<u8>,
    }
    fn request(id: u8) -> (Box<Request>, oneshot::Receiver<u8>) {
        let (receipt, response) = oneshot::channel();
        (Box::new(Request { id, receipt }), response)
    }

    #[test]
    fn full_queue_returns_original_request_and_receipt_without_reordering() {
        let (raw, mut incoming) = mpsc::channel(1);
        let sender = ControlSender::new(raw);
        let (first, mut first_receipt) = request(1);
        assert!(sender.try_send(first).is_ok());
        let (second, mut second_receipt) = request(2);
        let original = std::ptr::from_ref(second.as_ref());
        let returned = match sender.try_send(second) {
            Err(TrySendError::Full(request)) => request,
            _ => panic!("the original bounded queue must report Full"),
        };
        assert_eq!(std::ptr::from_ref(returned.as_ref()), original);
        assert!(matches!(
            first_receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            second_receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let first = incoming.try_recv().unwrap();
        assert_eq!(first.id, 1);
        first.receipt.send(first.id).unwrap();
        assert_eq!(first_receipt.try_recv().unwrap(), 1);
        assert!(sender.try_send(returned).is_ok());
        let second = incoming.try_recv().unwrap();
        assert_eq!(std::ptr::from_ref(second.as_ref()), original);
        second.receipt.send(second.id).unwrap();
        assert_eq!(second_receipt.try_recv().unwrap(), 2);
    }

    #[test]
    fn clones_hold_the_same_queue_and_closed_errors_return_the_original_owner() {
        let (raw, mut incoming) = mpsc::channel(1);
        let sender = ControlSender::new(raw);
        let held = sender.clone();
        drop(sender);
        let (message, _receipt) = request(3);
        assert!(held.try_send(message).is_ok());
        assert_eq!(incoming.try_recv().unwrap().id, 3);
        drop(held);
        assert!(matches!(
            incoming.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));

        let (raw, incoming) = mpsc::channel(1);
        let sender = ControlSender::new(raw);
        drop(incoming);
        let (message, mut receipt) = request(4);
        let original = std::ptr::from_ref(message.as_ref());
        let returned = match sender.try_send(message) {
            Err(TrySendError::Closed(message)) => message,
            _ => panic!("closing the original receiver must report Closed"),
        };
        assert_eq!(std::ptr::from_ref(returned.as_ref()), original);
        assert!(matches!(
            receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        returned.receipt.send(returned.id).unwrap();
        assert_eq!(receipt.try_recv().unwrap(), 4);
    }
}
