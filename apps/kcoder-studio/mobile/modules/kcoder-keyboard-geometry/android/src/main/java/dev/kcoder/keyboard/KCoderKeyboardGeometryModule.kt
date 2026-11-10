package dev.kcoder.keyboard

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KCoderKeyboardGeometryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KCoderKeyboardGeometry")
    View(KeyboardGeometryView::class) {
      Events("onGeometryChange")
      Prop("legacyKeyboardVisible") { view: KeyboardGeometryView, visible: Boolean? ->
        view.legacyKeyboardVisible = visible
      }
      Prop("keyboardEpoch") { view: KeyboardGeometryView, epoch: Int -> view.keyboardEpoch = epoch }
    }
  }
}
