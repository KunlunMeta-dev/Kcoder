import { ModelConfigurationDetails } from './ModelConfigurationDetails'
import { Check, ChevronRight, Cloud, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useConfiguredKeybinding } from '@/hooks/useConfiguredKeybinding'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  type ModelControlConfig,
  getControlsForModel,
  getDefaultModelOptions,
  getModelDisplayLabel,
  getSelectedModelDisplayLabel,
  groupModelsByFamily,
  inferModelFamily,
} from '@/lib/model-ui'
import { cn } from '@/lib/utils'
import { TOGGLE_MODEL_SELECTOR_COMMAND } from '@/lib/keybindings'
import type { UnifiedModel } from '@/types/api'
import { ModelResetDefaultRow } from './ModelResetDefaultRow'
import { ModelSelectorTrigger } from './ModelSelectorTrigger'
import type { ModelSelectorProps } from './model-selector-types'
import {
  handleMobileModelSelectorDialogKeyDown,
  useMobileModelSelectorFocus,
} from './model-selector-mobile-utils'
import {
  findDefaultModel,
  isVisibleModelSelectorControl,
  modelCompatibilityDisabledMessage,
  selectedControlOption,
} from './model-selector-utils'
import styles from './ModelSelector.module.css'

const MAIN_MENU_WIDTH = 256
const SUBMENU_WIDTH = 288
const SUBMENU_GAP = 0
const VIEWPORT_MARGIN = 16
const DESKTOP_MENU_VIEWPORT_TOP = 64
const MAIN_MENU_TRIGGER_GAP = 8
const MAIN_MENU_MAX_HEIGHT = 608
const SUBMENU_RIGHT_OFFSET = MAIN_MENU_WIDTH + SUBMENU_GAP
const SUBMENU_MAX_HEIGHT = 448
const SUBMENU_VIEWPORT_VERTICAL_GAP = 128
type DesktopSubmenuTarget = { type: 'models' } | { type: 'control'; id: string } | { type: 'none' }

function getDesktopViewportRightBoundary(): number {
  const shell = document.getElementById('right-workspace-panel-shell')
  if (shell && shell.getAttribute('aria-hidden') !== 'true') {
    const rect = shell.getBoundingClientRect()
    if (rect.width > 0) return Math.round(rect.left)
  }
  return window.innerWidth
}

function isCloudModel(model: UnifiedModel): boolean {
  return model.provider !== 'local'
}

export function ModelSelector({
  models,
  selectedModel,
  selectedModelOptions,
  nextTurn = false,
  disabled,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onBlockedModelSelect,
  onOpenChange,
  openSignal,
  menuPlacement = 'above',
  buttonClassName = '',
  menuClassName = '',
  maxClosedWidth,
}: ModelSelectorProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const desktopMenuWrapperRef = useRef<HTMLDivElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const submenuPanelRef = useRef<HTMLDivElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const handledOpenSignalRef = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [mobileQuery, setMobileQuery] = useState('')
  const [desktopMenuTop, setDesktopMenuTop] = useState(0)
  const [desktopMenuLeft, setDesktopMenuLeft] = useState(0)
  const [desktopMenuMaxHeight, setDesktopMenuMaxHeight] = useState(MAIN_MENU_MAX_HEIGHT)
  const [submenuOffset, setSubmenuOffset] = useState(0)
  const [submenuLeft, setSubmenuLeft] = useState(SUBMENU_RIGHT_OFFSET)
  const [submenuWidth, setSubmenuWidth] = useState<number | undefined>()
  const [activeDesktopSubmenu, setActiveDesktopSubmenu] = useState<DesktopSubmenuTarget | null>(
    null
  )
  const modelSelectorShortcut = useConfiguredKeybinding(TOGGLE_MODEL_SELECTOR_COMMAND)
  const reportedOpenRef = useRef(open)

  useEffect(() => {
    if (reportedOpenRef.current === open) return
    reportedOpenRef.current = open
    onOpenChange?.(open)
  }, [onOpenChange, open])
  const familyGroups = useMemo(() => groupModelsByFamily(models), [models])
  const selectedFamily = selectedModel
    ? inferModelFamily(selectedModel)
    : familyGroups[0]?.config.id
  const [activeFamilyId, setActiveFamilyId] = useState(selectedFamily ?? '')
  const displayedFamilyId = activeFamilyId || selectedFamily || familyGroups[0]?.config.id || ''
  const activeGroup =
    familyGroups.find(group => group.config.id === displayedFamilyId) ?? familyGroups[0]

  useEffect(() => {
    if (!openSignal || disabled || open) return
    if (handledOpenSignalRef.current === openSignal) return

    handledOpenSignalRef.current = openSignal
    buttonRef.current?.click()
  }, [disabled, open, openSignal])

  const closeMenu = useCallback(() => {
    setOpen(false)
    setMobileQuery('')
    setActiveDesktopSubmenu(null)
  }, [setActiveDesktopSubmenu, setMobileQuery, setOpen])
  const handleSelectModelOption = useCallback(
    (optionId: string, value: string) => {
      onSelectModelOption(optionId, value)
      if (isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModelOption]
  )
  const handleSelectModel = useCallback(
    (model: UnifiedModel | null) => {
      onSelectModel(model)
      if (isMobile) closeMenu()
    },
    [closeMenu, isMobile, onSelectModel]
  )
  const updateDesktopMenuLayout = useCallback(() => {
    const button = buttonRef.current
    const menuPanel = menuPanelRef.current
    if (!button || !menuPanel) return

    const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
    const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
    const maxAvailableHeight = Math.max(0, viewportBottom - viewportTop)
    const measuredHeight = menuPanel.getBoundingClientRect().height
    const contentHeight = menuPanel.scrollHeight + menuPanel.offsetHeight - menuPanel.clientHeight
    const naturalHeight = Math.max(measuredHeight, contentHeight) || MAIN_MENU_MAX_HEIGHT
    const menuHeight = Math.min(MAIN_MENU_MAX_HEIGHT, maxAvailableHeight, naturalHeight)
    const buttonRect = button.getBoundingClientRect()
    const preferredTop =
      menuPlacement === 'below'
        ? buttonRect.bottom + MAIN_MENU_TRIGGER_GAP
        : buttonRect.top - MAIN_MENU_TRIGGER_GAP - menuHeight
    const maxTop = viewportBottom - menuHeight
    const clampedTop = Math.round(Math.max(viewportTop, Math.min(preferredTop, maxTop)))
    const menuWidth = menuPanel.getBoundingClientRect().width || MAIN_MENU_WIDTH
    const viewportRight = getDesktopViewportRightBoundary()
    const maxLeft = viewportRight - VIEWPORT_MARGIN - menuWidth
    const preferredLeft = buttonRect.right - menuWidth
    const clampedLeft = Math.round(Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, maxLeft)))

    setDesktopMenuTop(clampedTop)
    setDesktopMenuLeft(clampedLeft)
    setDesktopMenuMaxHeight(menuHeight)
  }, [menuPlacement])
  const updateSubmenuLayout = useCallback((target: HTMLElement | null) => {
    if (!target || !menuPanelRef.current) {
      setSubmenuOffset(0)
      setSubmenuLeft(SUBMENU_RIGHT_OFFSET)
      setSubmenuWidth(undefined)
      return
    }

    const menuRect = menuPanelRef.current.getBoundingClientRect()
    const menuTop = menuRect.top
    const targetTop = target.getBoundingClientRect().top
    const preferredOffset = Math.round(targetTop - menuTop)
    const submenuRect = submenuPanelRef.current?.getBoundingClientRect()
    const submenuScrollHeight = submenuPanelRef.current?.scrollHeight ?? 0
    const maxSubmenuHeight = Math.min(
      SUBMENU_MAX_HEIGHT,
      Math.max(0, window.innerHeight - SUBMENU_VIEWPORT_VERTICAL_GAP)
    )
    const measuredSubmenuHeight = submenuRect?.height ?? 0
    const submenuHeight = Math.min(
      Math.max(measuredSubmenuHeight, submenuScrollHeight),
      maxSubmenuHeight
    )

    if (submenuHeight > 0) {
      const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
      const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
      const maxOffset = viewportBottom - submenuHeight - menuTop
      const minOffset = viewportTop - menuTop
      setSubmenuOffset(Math.round(Math.max(minOffset, Math.min(preferredOffset, maxOffset))))
    } else {
      setSubmenuOffset(preferredOffset)
    }

    const measuredMenuWidth = menuRect.width || MAIN_MENU_WIDTH
    const measuredSubmenuWidth = submenuRect?.width || SUBMENU_WIDTH
    const rightSideLeft = measuredMenuWidth + SUBMENU_GAP
    const viewportWidth = getDesktopViewportRightBoundary()
    const availableRight = viewportWidth - VIEWPORT_MARGIN - menuRect.left - rightSideLeft
    const availableLeft = menuRect.left - VIEWPORT_MARGIN - SUBMENU_GAP
    const rightSideWidth = Math.max(0, Math.min(measuredSubmenuWidth, availableRight))
    const leftSideWidth = Math.max(0, Math.min(measuredSubmenuWidth, availableLeft))

    const rightSideEdge = menuRect.left + rightSideLeft + measuredSubmenuWidth
    if (rightSideEdge <= viewportWidth - VIEWPORT_MARGIN) {
      setSubmenuWidth(undefined)
      setSubmenuLeft(rightSideLeft)
      return
    }

    const leftSideLeft = -(measuredSubmenuWidth + SUBMENU_GAP)
    if (menuRect.left + leftSideLeft >= VIEWPORT_MARGIN) {
      setSubmenuWidth(undefined)
      setSubmenuLeft(leftSideLeft)
      return
    }

    if (leftSideWidth >= rightSideWidth) {
      setSubmenuWidth(Math.round(leftSideWidth))
      setSubmenuLeft(-Math.round(leftSideWidth + SUBMENU_GAP))
      return
    }

    if (rightSideWidth > 0) {
      setSubmenuWidth(Math.round(rightSideWidth))
      setSubmenuLeft(rightSideLeft)
      return
    }

    const viewportFittedLeft = Math.max(
      VIEWPORT_MARGIN - menuRect.left,
      Math.min(
        rightSideLeft,
        viewportWidth - VIEWPORT_MARGIN - measuredSubmenuWidth - menuRect.left
      )
    )
    setSubmenuWidth(undefined)
    setSubmenuLeft(Math.round(viewportFittedLeft))
  }, [])
  const activateModels = useCallback(() => {
    setActiveDesktopSubmenu({ type: 'models' })
  }, [setActiveDesktopSubmenu])
  const clearDesktopSubmenu = useCallback(() => {
    setActiveDesktopSubmenu({ type: 'none' })
  }, [setActiveDesktopSubmenu])
  const activateMobileFamily = useCallback(
    (familyId: string) => {
      setActiveFamilyId(current => (current === familyId ? current : familyId))
    },
    [setActiveFamilyId]
  )

  useEffect(() => {
    if (!open || isMobile) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        containerRef.current?.contains(target) ||
        desktopMenuWrapperRef.current?.contains(target)
      ) {
        return
      }

      closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [closeMenu, isMobile, open])

  useLayoutEffect(() => {
    if (!open) return
    if (activeDesktopSubmenu?.type === 'models') {
      updateSubmenuLayout(modelButtonRef.current)
      return
    }
    updateSubmenuLayout(null)
  }, [activeDesktopSubmenu, open, updateSubmenuLayout])

  useEffect(() => {
    if (!open || isMobile) return

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu, isMobile, open])

  useMobileModelSelectorFocus(open, isMobile, mobileCloseButtonRef)

  const supportsTargetDefault = models.some(model => model.config?.supportsModelSelectionMode === true)
  const targetDefaultModel = findDefaultModel(models)
  const followDefaultLabel = targetDefaultModel
    ? t('workbench.follow_target_default_with', 'Follow target default ({{model}})', {
        model: getModelDisplayLabel(targetDefaultModel, {}, (key, fallback) => t(key, fallback)),
      })
    : t('workbench.follow_target_default', 'Follow target default')
  const followDefaultButton = supportsTargetDefault ? (
    <button type="button" data-testid="model-follow-target-default"
      disabled={disabled} onClick={() => { onSelectModel(null); closeMenu() }}
      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-text-primary hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-60"
      aria-pressed={selectedModel === null}>
      <span className="min-w-0 flex-1 truncate">{followDefaultLabel}</span>
      {selectedModel === null && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
    </button>
  ) : null

  const selectedButtonLabel =
    getSelectedModelDisplayLabel(selectedModel, selectedModelOptions, (key, fallback) =>
      t(key, fallback)
    ) || (supportsTargetDefault ? followDefaultLabel : t('workbench.default_model', 'Default'))
  const effectiveButtonLabel = selectedModel?.compatibilityDisabledReason === 'unavailable'
    ? `${selectedButtonLabel} · ${t('workbench.model_disabled_unavailable', 'This model is unavailable')}`
    : selectedButtonLabel
  const buttonLabel = nextTurn
    ? t('workbench.next_turn_model', 'Next · {{model}}', { model: effectiveButtonLabel })
    : effectiveButtonLabel

  const mobileFamilyControls = useMemo(() => {
    const controls = selectedModel
      ? getControlsForModel(selectedModel)
      : (activeGroup?.config.controls ?? [])
    return controls.filter(
      control =>
        isVisibleModelSelectorControl(control) &&
        (control.scope ?? 'family') === 'family' &&
        control.id !== 'reasoning' &&
        control.id !== 'speed'
    )
  }, [activeGroup, selectedModel])
  const selectedModelControls = selectedModel
    ? getControlsForModel(selectedModel).filter(
        control => isVisibleModelSelectorControl(control) && control.scope === 'model'
      )
    : []
  const controlsBelowModels = selectedModelControls.filter(
    control => control.placement === 'belowModels'
  )
  const desktopModels = useMemo(() => familyGroups.flatMap(group => group.models), [familyGroups])
  const defaultModel = useMemo(() => findDefaultModel(desktopModels), [desktopModels])

  useLayoutEffect(() => {
    if (!open || isMobile) return

    updateDesktopMenuLayout()
    window.addEventListener('resize', updateDesktopMenuLayout)
    return () => window.removeEventListener('resize', updateDesktopMenuLayout)
  }, [
    activeGroup?.models.length,
    desktopModels.length,
    familyGroups.length,
    selectedModelControls.length,
    isMobile,
    open,
    updateDesktopMenuLayout,
  ])

  const normalizedMobileQuery = mobileQuery.trim().toLowerCase()
  const resolveControlLabel = useCallback((key: string, fallback: string) => t(key, fallback), [t])
  const mobileModels = useMemo(() => {
    const modelsToFilter = activeGroup?.models ?? []
    if (!normalizedMobileQuery) return modelsToFilter

    return modelsToFilter.filter(model => {
      const searchableText = [
        model.name,
        model.displayName,
        model.modelId,
        getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return searchableText.includes(normalizedMobileQuery)
    })
  }, [activeGroup, normalizedMobileQuery, resolveControlLabel, selectedModelOptions])



  function renderDesktopModelOptions(modelsToRender: UnifiedModel[]) {
    if (modelsToRender.length === 0) {
      return (
        <div className="rounded-lg px-3 py-6 text-center text-sm text-text-muted">
          {t('workbench.no_models', 'No models available')}
        </div>
      )
    }

    return modelsToRender.map(model => {
      const selected = model.name === selectedModel?.name && model.type === selectedModel?.type
      const modelDisabled = Boolean(model.compatibilityDisabled)
      const disabledMessage = modelDisabled
        ? modelCompatibilityDisabledMessage(model.compatibilityDisabledReason, resolveControlLabel)
        : undefined
      return (
        <button
          key={`${model.type}:${model.name}`}
          type="button"
          data-testid={`model-option-${model.name}`}
          aria-disabled={modelDisabled}
          title={disabledMessage}
          onClick={() => {
            if (modelDisabled) {
              onBlockedModelSelect?.(model, disabledMessage)
              return
            }
            handleSelectModel(model)
          }}
          className={[
            'flex min-h-8 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm leading-[18px]',
            modelDisabled
              ? 'cursor-not-allowed text-text-muted hover:bg-transparent'
              : 'text-text-primary hover:bg-muted',
          ].join(' ')}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-normal">
            {disabledMessage ? (
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate">
                  {getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel)}
                </span>
                <span className="mt-0.5 block truncate text-xs font-normal text-text-muted">
                  {disabledMessage}
                </span>
              </span>
            ) : isCloudModel(model) ? (
              <span className="min-w-0 flex-1 truncate">
                {getModelDisplayLabel(model, {}, resolveControlLabel)}
              </span>
            ) : (
              getModelDisplayLabel(model, {}, resolveControlLabel)
            )}
            {isCloudModel(model) && (
              <Cloud
                aria-label={t('workbench.environment_cloud', '云端')}
                className="h-3.5 w-3.5 shrink-0 text-text-muted"
              />
            )}
          </span>
          {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
        </button>
      )
    })
  }

  function renderMobileControlSection(control: ModelControlConfig) {
    return (
      <section key={control.id} className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-text-muted">
          {control.labelKey ? t(control.labelKey, control.label) : control.label}
        </h3>
        <div className="flex flex-wrap gap-2 pb-1">
          {control.options
            .slice()
            .sort((a, b) => a.order - b.order)
            .map(option => {
              const selected =
                selectedControlOption(control, selectedModelOptions)?.value === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`model-control-${control.id}-${option.value}`}
                  onClick={() => handleSelectModelOption(control.id, option.value)}
                  className={[
                    'flex h-11 min-w-[44px] shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium',
                    selected
                      ? 'border-[#1f2933] bg-[#1f2933] text-white'
                      : 'border-border bg-surface text-text-secondary',
                  ].join(' ')}
                >
                  <span>{option.labelKey ? t(option.labelKey, option.label) : option.label}</span>
                  {selected && <Check className="h-4 w-4" />}
                </button>
              )
            })}
        </div>
      </section>
    )
  }

  function renderMobileSheet() {
    return createPortal(
      <div className="fixed inset-0 z-modal bg-black/25" onClick={closeMenu}>
        <div
          ref={mobileMenuRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-selector-mobile-title"
          data-testid="model-selector-menu"
          data-mobile="true"
          className="absolute inset-x-0 bottom-0 flex h-[82dvh] flex-col rounded-t-[28px] border border-border bg-background shadow-[0_-18px_48px_rgba(0,0,0,0.18)]"
          onClick={event => event.stopPropagation()}
          onKeyDown={event =>
            handleMobileModelSelectorDialogKeyDown(event, mobileMenuRef.current, closeMenu)
          }
        >
          <div className="mx-auto mt-3 h-1 w-11 rounded-full bg-border" />
          <div className="flex items-center justify-between px-5 pb-3 pt-4">
            <div className="min-w-0">
              <h2
                id="model-selector-mobile-title"
                className="text-lg font-semibold text-text-primary"
              >
                {t('workbench.model_picker_title')}
              </h2>
              <p className="mt-1 truncate text-xs text-text-muted">{buttonLabel}</p>
            </div>
            <button
              type="button"
              ref={mobileCloseButtonRef}
              data-testid="model-selector-close-button"
              aria-label={t('workbench.close_menu')}
              onClick={closeMenu}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-text-primary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-5">
            <label className="flex h-11 items-center gap-3 rounded-2xl bg-surface px-4 text-text-secondary">
              <Search className="h-5 w-5 shrink-0" />
              <input
                data-testid="model-selector-search-input"
                value={mobileQuery}
                onChange={event => setMobileQuery(event.target.value)}
                placeholder={t('workbench.search_models')}
                className="min-w-0 flex-1 bg-transparent text-base leading-5 text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-5">
            {followDefaultButton}
            <div className="mb-5 shrink-0 space-y-4">
              {mobileFamilyControls.map(renderMobileControlSection)}
            </div>

            <div className="scrollbar-none -mx-5 mb-5 shrink-0 overflow-x-auto px-5">
              <div className="flex gap-2">
                {familyGroups.map(group => {
                  const active = group.config.id === activeGroup?.config.id
                  return (
                    <button
                      key={group.config.id}
                      type="button"
                      data-testid={`model-family-${group.config.id}`}
                      onClick={() => activateMobileFamily(group.config.id)}
                      className={[
                        'h-11 min-w-[44px] shrink-0 rounded-full px-4 text-sm font-medium',
                        active ? 'bg-[#1f2933] text-white' : 'bg-surface text-text-secondary',
                      ].join(' ')}
                    >
                      {group.config.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <section
              className="flex min-h-0 flex-1 flex-col space-y-2"
              data-testid="model-selector-submenu"
            >
              <h3 className="shrink-0 px-1 text-xs font-semibold text-text-muted">
                {activeGroup?.config.label ?? t('workbench.model_version')}
              </h3>
              {mobileModels.length > 0 ? (
                <div
                  data-testid="model-selector-model-list"
                  className="scrollbar-none min-h-0 flex-1 space-y-2 overflow-y-auto pb-2"
                >
                  {mobileModels.map(model => {
                    const selected =
                      model.name === selectedModel?.name && model.type === selectedModel?.type
                    const modelDisabled = Boolean(model.compatibilityDisabled)
                    const disabledMessage = modelDisabled
                      ? modelCompatibilityDisabledMessage(
                          model.compatibilityDisabledReason,
                          resolveControlLabel
                        )
                      : undefined
                    return (
                      <button
                        key={`${model.type}:${model.name}`}
                        type="button"
                        data-testid={`model-option-${model.name}`}
                        aria-disabled={modelDisabled}
                        title={disabledMessage}
                        onClick={() => {
                          if (modelDisabled) {
                            onBlockedModelSelect?.(model, disabledMessage)
                            return
                          }
                          handleSelectModel(model)
                        }}
                        className={[
                          'flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left',
                          modelDisabled && 'cursor-not-allowed opacity-70',
                          selected
                            ? 'border-[#b9d1ca] bg-[#e8f2ef]'
                            : 'border-transparent bg-surface',
                        ].join(' ')}
                      >
                        <span className="min-w-0 flex-1">
                          <span
                            className={[
                              'flex items-center gap-1.5 truncate text-sm font-semibold',
                              modelDisabled ? 'text-text-muted' : 'text-text-primary',
                            ].join(' ')}
                          >
                            <span className="truncate">
                              {getModelDisplayLabel(
                                model,
                                selectedModelOptions,
                                resolveControlLabel
                              )}
                            </span>
                            {isCloudModel(model) && (
                              <Cloud
                                aria-label={t('workbench.environment_cloud', '云端')}
                                className="h-3.5 w-3.5 shrink-0 text-text-muted"
                              />
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-text-muted">
                            {disabledMessage || model.displayName || model.modelId || model.name}
                          </span>
                        </span>
                        {selected && <Check className="h-5 w-5 shrink-0 text-text-primary" />}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-2xl bg-surface px-4 py-6 text-center text-sm text-text-muted">
                  {t('workbench.no_models')}
                </div>
              )}
            </section>

            <ModelConfigurationDetails model={selectedModel ?? defaultModel} onLayoutChange={updateDesktopMenuLayout} />
            {controlsBelowModels.length > 0 && (
              <div className="mt-5 space-y-4">
                {controlsBelowModels.map(renderMobileControlSection)}
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-3 border-t border-border bg-background/95 px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
            <button
              type="button"
              data-testid="model-selector-auto-button"
              onClick={() => handleSelectModel(null)}
              className="h-11 flex-1 rounded-full border border-border bg-background text-sm font-semibold text-text-primary"
            >
              {t('workbench.model_auto_select')}
            </button>
            <button
              type="button"
              data-testid="model-selector-confirm-button"
              onClick={closeMenu}
              className="h-11 flex-1 rounded-full bg-[#1f2933] text-sm font-semibold text-white"
            >
              {t('workbench.use_current_model')}
            </button>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  const desktopModelLabel = selectedModel
    ? getModelDisplayLabel(selectedModel, {}, resolveControlLabel)
    : t('workbench.default_model', 'Default')
  const modelRowActive = activeDesktopSubmenu?.type === 'models'

  return (
    <div ref={containerRef} className="group/model-selector relative min-w-0">
      {open && isMobile && renderMobileSheet()}
      {open &&
        !isMobile &&
        createPortal(
          <div
            ref={desktopMenuWrapperRef}
            style={{ left: desktopMenuLeft, top: desktopMenuTop }}
            className={cn('fixed z-system-popover w-64', menuClassName)}
          >
            <div
              ref={menuPanelRef}
              data-testid="model-selector-menu"
              data-enter-animation="main"
              style={{ maxHeight: desktopMenuMaxHeight }}
              className={cn(
                'w-64 shrink-0 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
                styles.mainMenu
              )}
            >
              <div className="space-y-0.5">
                <button
                  ref={modelButtonRef}
                  type="button"
                  data-testid="model-control-menu-model"
                  onMouseEnter={activateModels}
                  onPointerEnter={activateModels}
                  onFocus={activateModels}
                  onClick={activateModels}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-normal leading-[18px]',
                    modelRowActive
                      ? 'bg-muted text-text-primary'
                      : 'text-text-secondary hover:bg-muted hover:text-text-primary'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t('workbench.model_version', '模型')}
                  </span>
                  <span className="max-w-24 truncate text-text-muted">{desktopModelLabel}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                </button>
              </div>
              <div className="mx-3 my-1.5 border-t border-border" />
              {followDefaultButton}
              {controlsBelowModels.map(renderMobileControlSection)}
              <ModelConfigurationDetails model={selectedModel ?? defaultModel} onLayoutChange={updateDesktopMenuLayout} />
              <ModelResetDefaultRow
                disabled={!defaultModel}
                onClearSubmenu={clearDesktopSubmenu}
                onReset={() => {
                  if (!defaultModel) return
                  const defaultOptions = getDefaultModelOptions(defaultModel)
                  if (onSelectModelAndOptions) {
                    onSelectModelAndOptions(defaultModel, defaultOptions)
                  } else {
                    handleSelectModel(defaultModel)
                    for (const [option, value] of Object.entries(defaultOptions)) {
                      handleSelectModelOption(option, value)
                    }
                  }
                  clearDesktopSubmenu()
                }}
              />
            </div>

            {activeDesktopSubmenu?.type === 'models' ? (
              <div
                key="models"
                ref={submenuPanelRef}
                data-testid="model-selector-submenu"
                data-enter-animation="submenu"
                style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
                className={cn(
                  'absolute max-h-[min(28rem,calc(100vh-8rem))] min-h-48 w-72 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
                  styles.submenu
                )}
              >
                <div className="px-3 pb-1.5 pt-0.5 text-sm font-semibold leading-[18px] text-text-muted">
                  {t('workbench.model_version', '模型')}
                </div>
                <div className="space-y-0.5">
                  {familyGroups.length <= 1
                    ? renderDesktopModelOptions(desktopModels)
                    : familyGroups.map(group => (
                        <div key={group.config.id} className="pb-1 last:pb-0">
                          <div className="px-3 pb-1 pt-2 text-xs font-medium text-text-muted first:pt-0">
                            {group.config.label}
                          </div>
                          {renderDesktopModelOptions(group.models)}
                        </div>
                      ))}
                </div>
              </div>
            ) : null}
          </div>,
          document.body
        )}
      <ModelSelectorTrigger
        buttonRef={buttonRef}
        open={open}
        disabled={disabled}
        isMobile={isMobile}
        label={buttonLabel}
        shortcut={modelSelectorShortcut}
        ariaLabel={t('workbench.model_selector')}
        tooltipLabel={selectedModel?.compatibilityDisabledReason === 'unavailable'
          ? effectiveButtonLabel : t('workbench.model_picker_title', '选择模型')}
        buttonClassName={buttonClassName}
        maxClosedWidth={maxClosedWidth}
        onToggle={() => {
          if (disabled) return
          setOpen(current => {
            const nextOpen = !current
            if (nextOpen) {
              setActiveDesktopSubmenu({ type: 'none' })
            }
            return nextOpen
          })
        }}
      />
    </div>
  )
}
