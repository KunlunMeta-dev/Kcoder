const ACTIVATION_DISTANCE = 8;
const HORIZONTAL_INTENT_RATIO = 1.2;
const DISMISS_VELOCITY = -0.5;

export function shouldActivateDrawerDismiss(dx: number, dy: number): boolean {
  return dx < -ACTIVATION_DISTANCE && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_INTENT_RATIO;
}

export function shouldDismissDrawer(dx: number, velocityX: number, drawerWidth: number): boolean {
  return dx <= -drawerWidth / 3 || velocityX <= DISMISS_VELOCITY;
}

export function clampDrawerTranslation(dx: number, drawerWidth: number): number {
  return Math.max(-drawerWidth, Math.min(0, dx));
}
