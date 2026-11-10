package dev.kcoder.keyboard

/** All inputs share the owning window's screen coordinate system, in physical pixels. */
internal fun remainingImeOverlap(containerBottom: Int, windowBottom: Int, imeBottom: Int, visible: Boolean): Int {
  if (!visible || imeBottom <= 0) return 0
  val imeTop = windowBottom - imeBottom
  return (containerBottom - imeTop).coerceAtLeast(0)
}
