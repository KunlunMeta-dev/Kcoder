package dev.kcoder.keyboard

import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardAttachmentIdsTest {
  @Test fun replacementAttachmentsHaveMonotonicDistinctIds() {
    val previous = KeyboardAttachmentIds.allocate()
    val replacement = KeyboardAttachmentIds.allocate()
    assertTrue(replacement > previous)
  }
}
