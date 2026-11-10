package dev.kcoder.keyboard

import android.graphics.Rect
import android.view.View
import android.widget.LinearLayout
import expo.modules.kotlin.AppContext
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.mock
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Android View behavior only: this does not establish real-device IME geometry. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class KeyboardGeometryLayoutTest {
  private fun exact(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)

  @Test fun parentMeasureDoesNotRemeasureYogaChild() {
    val context = RuntimeEnvironment.getApplication()
    val parent = KeyboardGeometryView(context, mock(AppContext::class.java))
    val child = View(context)
    parent.addView(child, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))
    child.measure(exact(400), exact(744))
    parent.measure(exact(400), exact(800))
    assertEquals(400, parent.measuredWidth)
    assertEquals(800, parent.measuredHeight)
    assertEquals("Native parent must not remeasure a Yoga-owned child", 744, child.measuredHeight)
  }

  @Test fun parentLayoutPreservesYogaSafeAreaFrameAcrossResize() {
    val context = RuntimeEnvironment.getApplication()
    val parent = KeyboardGeometryView(context, mock(AppContext::class.java))
    val child = View(context)
    parent.addView(child, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))

    fun assertYogaFrame(width: Int, height: Int, safeTop: Int, safeBottom: Int) {
      parent.forceLayout()
      parent.measure(exact(width), exact(height))
      // Fabric places the parent first, then Yoga measures and places React children.
      // A later native layout pass must preserve the safe-area frame it receives.
      child.measure(exact(width), exact(height - safeTop - safeBottom))
      child.layout(0, safeTop, width, height - safeBottom)
      val expectedFrame = Rect(child.left, child.top, child.right, child.bottom)
      parent.forceLayout()
      parent.layout(0, 0, width, height)
      assertEquals(width, parent.measuredWidth)
      assertEquals(height, parent.measuredHeight)
      assertEquals("Native parent must not replace a Yoga-owned safe-area frame", expectedFrame, Rect(child.left, child.top, child.right, child.bottom))
    }

    assertYogaFrame(400, 800, 32, 24)
    assertYogaFrame(400, 800, 32, 24)
    assertYogaFrame(800, 400, 24, 16)
    assertYogaFrame(400, 800, 32, 24)
  }
}
