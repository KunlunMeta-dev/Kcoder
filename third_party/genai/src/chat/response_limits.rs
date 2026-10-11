use crate::{Error, Result};
use std::collections::HashMap;

/// Local decoded-response memory limits; never serialized into a model request.
#[derive(Debug, Clone, Copy)]
pub struct StreamResponseLimits {
	pub total_decoded_bytes: usize,
	pub tool_arguments_bytes: usize,
	pub content_blocks: usize,
	pub active_tool_calls: usize,
}

pub(crate) struct ResponseBudget {
	limits: StreamResponseLimits,
	bytes: usize,
	blocks: usize,
	tools: HashMap<usize, usize>,
	open_kind: Option<bool>,
}

impl ResponseBudget {
	pub fn new(limits: Option<StreamResponseLimits>) -> Self {
		Self {
			limits: limits.unwrap_or(StreamResponseLimits {
				total_decoded_bytes: usize::MAX,
				tool_arguments_bytes: usize::MAX,
				content_blocks: usize::MAX,
				active_tool_calls: usize::MAX,
			}),
			bytes: 0,
			blocks: 0,
			tools: HashMap::new(),
			open_kind: None,
		}
	}

	fn check_bytes(&self, bytes: usize) -> Result<()> {
		if bytes > self.limits.total_decoded_bytes.saturating_sub(self.bytes) {
			return Err(Error::ResponseLimit {
				resource: "total_decoded_bytes",
				limit: self.limits.total_decoded_bytes,
			});
		}
		Ok(())
	}

	fn check_block(&self) -> Result<()> {
		if self.blocks >= self.limits.content_blocks {
			return Err(Error::ResponseLimit {
				resource: "content_blocks",
				limit: self.limits.content_blocks,
			});
		}
		Ok(())
	}

	pub fn text(&mut self, reasoning: bool, bytes: usize) -> Result<()> {
		let seen = self.open_kind == Some(reasoning);
		if !seen {
			self.check_block()?;
		}
		self.check_bytes(bytes)?;
		if !seen {
			self.blocks += 1;
			self.open_kind = Some(reasoning);
		}
		self.bytes += bytes;
		Ok(())
	}

	pub fn tool(&mut self, index: usize, identity_bytes: usize, arguments_bytes: usize) -> Result<()> {
		let previous = self.tools.get(&index).copied();
		if previous.is_none() {
			self.check_block()?;
			if self.tools.len() >= self.limits.active_tool_calls {
				return Err(Error::ResponseLimit {
					resource: "active_tool_calls",
					limit: self.limits.active_tool_calls,
				});
			}
		}
		if arguments_bytes > self.limits.tool_arguments_bytes.saturating_sub(previous.unwrap_or(0)) {
			return Err(Error::ResponseLimit {
				resource: "tool_arguments_bytes",
				limit: self.limits.tool_arguments_bytes,
			});
		}
		let bytes = identity_bytes
			.checked_add(arguments_bytes)
			.ok_or(Error::ResponseLimit {
				resource: "total_decoded_bytes",
				limit: self.limits.total_decoded_bytes,
			})?;
		self.check_bytes(bytes)?;
		if previous.is_none() {
			self.blocks += 1;
		}
		self.tools.insert(index, previous.unwrap_or(0) + arguments_bytes);
		self.bytes += bytes;
		Ok(())
	}
}
