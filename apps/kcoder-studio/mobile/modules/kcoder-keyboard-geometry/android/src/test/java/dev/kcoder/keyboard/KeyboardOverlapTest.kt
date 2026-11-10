package dev.kcoder.keyboard

import org.junit.Assert.assertEquals
import org.junit.Test

class KeyboardOverlapTest {
  @Test fun overlayAddsTheReportedInset() {
    assertEquals(348, remainingImeOverlap(800, 800, 348, true))
  }
  @Test fun alreadyResizedContainerDoesNotAddSpace() {
    assertEquals(0, remainingImeOverlap(452, 800, 348, true))
    assertEquals(0, remainingImeOverlap(420, 800, 348, true))
  }
  @Test fun partialAvoidanceUsesOnlyRemainingOverlap() {
    assertEquals(100, remainingImeOverlap(552, 800, 348, true))
  }
  @Test fun windowBottomIsAbsoluteForOffsetMultiWindow() {
    assertEquals(240, remainingImeOverlap(940, 1000, 300, true))
  }
  @Test fun hiddenAndFloatingImeDoNotRetainPadding() {
    assertEquals(0, remainingImeOverlap(800, 800, 348, false))
    assertEquals(0, remainingImeOverlap(800, 800, 0, true))
  }
}
