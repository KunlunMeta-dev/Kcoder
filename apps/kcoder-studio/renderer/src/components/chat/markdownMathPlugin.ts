import { createMathPlugin } from '@streamdown/math'
import 'katex/dist/katex.min.css'

export const math = createMathPlugin({ singleDollarTextMath: true })
