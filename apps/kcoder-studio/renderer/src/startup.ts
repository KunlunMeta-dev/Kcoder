import { applyAppearance } from './features/appearance/applyAppearance'
import { readStoredAppearance } from './features/appearance/storage'

// This small entry can initialize the placeholder while Vite loads the app graph.
applyAppearance(readStoredAppearance())
