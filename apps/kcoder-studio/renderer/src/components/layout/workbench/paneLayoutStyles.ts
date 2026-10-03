export const DESKTOP_CHAT_CONTENT_BASE_CLASS =
  'mx-auto min-w-0 px-0 transition-[width,max-width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'

export const DESKTOP_CHAT_CONTENT_WIDTH_CLASS = `${DESKTOP_CHAT_CONTENT_BASE_CLASS} w-[min(46rem,calc(100%_-_2rem))] max-w-[calc(100%_-_2rem)]`

export const DESKTOP_MESSAGE_LIST_WIDTH_CLASS = `${DESKTOP_CHAT_CONTENT_BASE_CLASS} w-[min(46rem,calc(100%_-_6rem))] max-w-[calc(100%_-_6rem)]`

export const DESKTOP_MESSAGE_LIST_CLASS = `${DESKTOP_MESSAGE_LIST_WIDTH_CLASS} px-0`

export const DESKTOP_STICKY_COMPOSER_FOOTER_CLASS = 'pt-6 pb-2 bg-gradient-to-t to-transparent'

export const DESKTOP_STICKY_COMPOSER_LAYER_CLASS = `${DESKTOP_CHAT_CONTENT_WIDTH_CLASS} relative`

export const DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-0 h-full bg-gradient-to-t to-transparent'

export const DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS = 'bottom-4 z-popover bg-background/95 shadow-md'

export const RIGHT_PANEL_WIDTH_TRANSITION_CLASS =
  'transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[width]'

export const RIGHT_PANEL_SHELL_TRANSITION_CLASS =
  'transition-[width,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[width,opacity]'

export const RIGHT_PANEL_HANDLE_TRANSITION_CLASS =
  'transition-[left] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[left]'

export const DOCKED_ENVIRONMENT_INFO_WIDTH = 320

export const MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO = 680

export const COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE = '5rem'

export const TEMPORARY_CHAT_PANEL_DEFAULT_WIDTH = 420

export const MACOS_TRAFFIC_LIGHTS_CLEARANCE_CLASS = 'pl-[92px]'

export const WINDOWS_HEADER_LEFT_PADDING_CLASS = 'pl-2'

export const BLANK_BROWSER_MIGRATION_TTL_MS = 2 * 60 * 1000

export const MAX_CACHED_DESKTOP_WORKBENCH_PANES = 1
