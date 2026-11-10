import type { PropsWithChildren } from "react";

/** Native navigators own focus and accessibility for inactive screens. */
export function ScreenFocusBoundary({ children }: PropsWithChildren) { return children; }
