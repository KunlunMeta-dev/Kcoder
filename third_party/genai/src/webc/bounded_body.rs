//! Bound HTTP failure bodies before buffering them; preserve the HTTP status separately.
use futures::{Stream, StreamExt};

const ERROR_BODY_LIMIT: usize = 64 * 1024;

pub(super) async fn read_error_body(response: reqwest::Response) -> String {
	read_chunks(response.bytes_stream(), ERROR_BODY_LIMIT).await
}

async fn read_chunks<S, B, E>(mut chunks: S, limit: usize) -> String
where
	S: Stream<Item = Result<B, E>> + Unpin,
	B: AsRef<[u8]>,
{
	let mut bytes = Vec::new();
	while let Some(chunk) = chunks.next().await {
		let Ok(chunk) = chunk else { return String::new() };
		let chunk = chunk.as_ref();
		if chunk.len() > limit.saturating_sub(bytes.len()) {
			return String::new();
		}
		bytes.extend_from_slice(chunk);
	}
	String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	};

	#[tokio::test]
	async fn overflow_drops_the_reader_without_polling_the_remaining_body() {
		let polled = Arc::new(AtomicUsize::new(0));
		let calls = Arc::clone(&polled);
		let chunks =
			futures::stream::iter([b"12345678".as_slice(), b"abcdefgh", b"!", b"UNREAD_PRIVATE"]).map(move |chunk| {
				calls.fetch_add(1, Ordering::Relaxed);
				Ok::<_, ()>(chunk)
			});
		assert!(read_chunks(chunks, 16).await.is_empty());
		assert_eq!(polled.load(Ordering::Relaxed), 3);
		let exact = futures::stream::iter([Ok::<_, ()>(b"12345678"), Ok(b"abcdefgh")]);
		assert_eq!(read_chunks(exact, 16).await, "12345678abcdefgh");
	}
}
