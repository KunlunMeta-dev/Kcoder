package dev.kcoder.keyboard

import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.view.ViewTreeObserver
import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsAnimationCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** Measures this outer container; React applies any avoidance to a separate inner child. */
class KeyboardGeometryView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onGeometryChange by EventDispatcher<Map<String, Any?>>()
  private var generation = 0L
  private var attached = false
  private var observedTree: ViewTreeObserver? = null
  private var lastGeometry: Map<String, Any?>? = null
  private var latestAppliedInsets: WindowInsetsCompat? = null
  private var measurementSequence = 0
  private val globalLayout = ViewTreeObserver.OnGlobalLayoutListener { scheduleMeasurement() }
  private var pendingMeasurement: Runnable? = null

  var legacyKeyboardVisible: Boolean? = null
    set(value) {
      if (field == value) return
      field = value
      latestAppliedInsets = null
      if (attached) ViewCompat.requestApplyInsets(this)
      scheduleMeasurement()
    }

  var keyboardEpoch: Int = 0
    set(value) {
      if (field == value) return
      field = value
      latestAppliedInsets = null
      if (attached) ViewCompat.requestApplyInsets(this)
      scheduleMeasurement()
    }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    generation = KeyboardAttachmentIds.allocate()
    attached = true
    lastGeometry = null
    latestAppliedInsets = ViewCompat.getRootWindowInsets(this)
    observedTree = viewTreeObserver.also { it.addOnGlobalLayoutListener(globalLayout) }
    val ownerGeneration = generation
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
      if (attached && ownerGeneration == generation) { latestAppliedInsets = insets; scheduleMeasurement() }
      insets
    }
    ViewCompat.setWindowInsetsAnimationCallback(this, object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
      override fun onProgress(insets: WindowInsetsCompat, runningAnimations: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat {
        // Applied insets own visibility; animation callbacks only request a fresh layout observation.
        if (attached && ownerGeneration == generation) scheduleMeasurement()
        return insets
      }
      override fun onEnd(animation: WindowInsetsAnimationCompat) {
        if (attached && ownerGeneration == generation) scheduleMeasurement()
      }
    })
    ViewCompat.requestApplyInsets(this)
    scheduleMeasurement()
  }

  override fun onDetachedFromWindow() {
    attached = false
    generation = KeyboardAttachmentIds.allocate()
    pendingMeasurement?.let { removeCallbacks(it) }
    pendingMeasurement = null
    observedTree?.takeIf { it.isAlive }?.removeOnGlobalLayoutListener(globalLayout)
    observedTree = null
    ViewCompat.setOnApplyWindowInsetsListener(this, null)
    ViewCompat.setWindowInsetsAnimationCallback(this, null)
    latestAppliedInsets = null
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    // Yoga owns every React child's frame. LinearLayout must not lay them out again.
    scheduleMeasurement()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // Fabric supplies the measured frame; do not remeasure React children through LinearLayout.
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  private fun scheduleMeasurement() {
    if (!attached || pendingMeasurement != null) return
    val ownerGeneration = generation
    val measurement = Runnable {
      pendingMeasurement = null
      if (attached && ownerGeneration == generation) publishGeometry()
    }
    pendingMeasurement = measurement
    post(measurement)
  }

  private fun publishGeometry() {
    if (height <= 0 || !isAttachedToWindow) return
    var overlap = 0
    var visible: Boolean? = null
    var source = "unknown"
    val location = IntArray(2)
    getLocationOnScreen(location)
    val containerBottom = location[1] + height
    val ownRoot = rootView
    // Dialog contexts do not guarantee a WindowManager associated with their own window.
    val activityRoot = appContext.currentActivity?.window?.decorView
    if (legacyKeyboardVisible == false) {
      visible = false
      source = "keyboard-event-hidden"
    } else if (ownRoot === activityRoot && display?.displayId == ownRoot.display?.displayId) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val manager = ownRoot.context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        val insets = latestAppliedInsets
        if (manager != null && insets != null) {
          val bounds = manager.currentWindowMetrics.bounds
          if (location[1] >= bounds.top && containerBottom <= bounds.bottom) {
            visible = insets.isVisible(WindowInsetsCompat.Type.ime())
            val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            overlap = remainingImeOverlap(containerBottom, bounds.bottom, imeBottom, visible)
            source = if (visible && imeBottom == 0) "unknown" else "insets"
          }
        }
      } else if (legacyKeyboardVisible != null) {
        visible = legacyKeyboardVisible
        if (visible == false) source = "legacy-event-hidden"
        else {
          val visibleFrame = Rect()
          getWindowVisibleDisplayFrame(visibleFrame)
          if (!visibleFrame.isEmpty && visibleFrame.bottom > 0) {
            overlap = (containerBottom - visibleFrame.bottom).coerceAtLeast(0)
            source = "legacy-visible-frame"
          }
        }
      }
    }
    val geometry = mapOf<String, Any?>(
      "overlap" to overlap / resources.displayMetrics.density,
      "imeVisible" to visible,
      "source" to source,
      "generation" to generation,
      "keyboardEpoch" to keyboardEpoch,
    )
    if (geometry != lastGeometry) {
      lastGeometry = geometry
      measurementSequence++
      onGeometryChange(geometry + ("sequence" to measurementSequence))
    }
  }
}
