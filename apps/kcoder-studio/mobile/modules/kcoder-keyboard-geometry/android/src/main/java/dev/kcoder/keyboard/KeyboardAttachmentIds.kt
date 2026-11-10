package dev.kcoder.keyboard

import java.util.concurrent.atomic.AtomicLong

/** Unique across native View replacement while a React wrapper remains mounted. */
internal object KeyboardAttachmentIds {
  private val next = AtomicLong(0)
  fun allocate(): Long = next.incrementAndGet()
}
