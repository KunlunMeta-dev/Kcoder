//! Bound SSE frames before UTF-8 decoding and partial-frame accumulation.
pub(super) struct FrameBudget {
	bytes: usize,
	line_empty: bool,
	previous_cr: bool,
	completed_on_cr: bool,
	limit: usize,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn unfinished_frame_is_bounded_before_the_next_small_fragment() {
		let mut budget = FrameBudget::new(32);
		for _ in 0..4 {
			budget.accept(b"12345678").unwrap();
		}
		assert!(matches!(
			budget.accept(b"x"),
			Err(crate::Error::ResponseLimit {
				resource: "wire_frame_bytes",
				limit: 32,
			})
		));
		let mut budget = FrameBudget::new(32);
		for _ in 0..1025 {
			budget.accept(b"data: x\r\n\r\n").unwrap();
		}
	}
}

impl FrameBudget {
	pub(super) fn new(limit: usize) -> Self {
		Self {
			bytes: 0,
			line_empty: true,
			previous_cr: false,
			completed_on_cr: false,
			limit,
		}
	}

	pub(super) fn accept(&mut self, bytes: &[u8]) -> crate::Result<()> {
		for byte in bytes {
			// CRLF is one line ending, even when split across transport chunks.
			if self.previous_cr && *byte == b'\n' {
				self.previous_cr = false;
				if !self.completed_on_cr {
					self.bytes += 1;
					if self.bytes > self.limit {
						return Err(crate::Error::ResponseLimit {
							resource: "wire_frame_bytes",
							limit: self.limit,
						});
					}
				}
				continue;
			}
			self.previous_cr = *byte == b'\r';
			self.completed_on_cr = false;
			self.bytes += 1;
			if self.bytes > self.limit {
				return Err(crate::Error::ResponseLimit {
					resource: "wire_frame_bytes",
					limit: self.limit,
				});
			}
			if matches!(byte, b'\n' | b'\r') {
				if self.line_empty {
					self.bytes = 0;
					self.completed_on_cr = self.previous_cr;
				}
				self.line_empty = true;
			} else {
				self.line_empty = false;
			}
		}
		Ok(())
	}
}
