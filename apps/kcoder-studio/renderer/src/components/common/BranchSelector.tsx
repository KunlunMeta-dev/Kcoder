import { Check, ChevronDown, GitBranch, Plus, Search, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  calculateFloatingMenuHorizontalLayout,
  calculateFloatingMenuLayout,
  getFloatingMenuVisibleBounds,
  type FloatingMenuPlacement,
} from '@/lib/floating-menu'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { isAbortError } from '@/lib/async-errors'
import styles from './responsive-control-bar.module.css'
import { useBranchMenuScope, type BranchMenuTarget } from './useBranchMenuScope'

interface BranchSelectorProps {
  currentBranch?: string
  loading?: boolean
  onRefresh?: () => Promise<void>
  onListBranches: () => Promise<string[]>
  onSelectBranch: (branchName: string) => Promise<void> | void
  onCreateBranch?: (branchName: string) => Promise<void>
  variant: 'environment' | 'workbar' | 'worktree'
  target?: BranchMenuTarget | null
  mobileSheet?: boolean
}

const BRANCH_MENUS = {
  environment: { prefix: 'environment', placement: 'below', height: 420, width: 320 },
  workbar: { prefix: 'project', placement: 'above', height: 420, width: 320 },
  worktree: { prefix: 'project-worktree', placement: 'below', height: 360, width: 256 },
} as const

function branchMatchesQuery(branch: string, query: string): boolean {
  const normalizedBranch = branch.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery || normalizedBranch.includes(normalizedQuery)) return true

  let queryIndex = 0
  for (const character of normalizedBranch) {
    if (character === normalizedQuery[queryIndex]) {
      queryIndex += 1
      if (queryIndex === normalizedQuery.length) return true
    }
  }
  return false
}

export function BranchSelector(props: BranchSelectorProps) {
  const scope = useBranchMenuScope(props.target)
  return <BranchSelectorContent key={scope.key} {...props} scope={scope} />
}

function BranchSelectorContent({
  currentBranch,
  loading = false,
  onRefresh,
  onListBranches,
  onSelectBranch,
  onCreateBranch,
  variant,
  mobileSheet = false,
  scope,
}: BranchSelectorProps & { scope: ReturnType<typeof useBranchMenuScope> }) {
  const { t } = useTranslation('common')
  const menu = BRANCH_MENUS[variant]
  const isEnvironment = variant === 'environment'
  const selectionOnly = variant === 'worktree'
  const menuTitle = t(
    selectionOnly ? 'workbench.project_worktree_branch_title' : 'workbench.environment_branch_menu'
  )
  const loadingLabel = t(
    selectionOnly ? 'workbench.project_worktree_branch_loading' : 'common.loading'
  )
  const isMobile = useIsMobile()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const readSequenceRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [action, setAction] = useState<'idle' | 'switching' | 'creating'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [createFormOpen, setCreateFormOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [desktopMenuLayout, setDesktopMenuLayout] = useState<{
    placement: FloatingMenuPlacement
    maxHeight: number
    left: number
    width: number
  }>({
    placement: menu.placement,
    maxHeight: menu.height,
    left: 0,
    width: menu.width,
  })
  const prefix = menu.prefix
  const useMobileSheet = mobileSheet && isMobile && !isEnvironment
  const filteredBranches = useMemo(
    () => branches.filter(branch => branchMatchesQuery(branch, query)),
    [branches, query]
  )

  const close = useCallback(() => {
    readSequenceRef.current += 1
    setOpen(false)
    setQuery('')
    setError(null)
    setCreateFormOpen(false)
    setNewBranchName('')
  }, [])

  useEffect(
    () => () => {
      readSequenceRef.current += 1
    },
    []
  )

  const updateDesktopMenuLayout = useCallback(() => {
    if (!open || useMobileSheet || typeof window === 'undefined') return

    const triggerRect = triggerRef.current?.getBoundingClientRect()
    if (!triggerRect) return

    const preferredPlacement = menu.placement
    const visibleBounds = getFloatingMenuVisibleBounds(
      rootRef.current,
      16,
      !isEnvironment ? rootRef.current?.closest<HTMLElement>('[data-project-work-bar]') : null
    )
    const nextLayout = calculateFloatingMenuLayout({
      triggerRect,
      visibleBounds,
      preferredPlacement,
      maxHeight: menu.height,
    })
    const containerRect = rootRef.current?.getBoundingClientRect()
    if (!containerRect) return
    const horizontalLayout = calculateFloatingMenuHorizontalLayout({
      anchorRect: isEnvironment
        ? { left: containerRect.left, right: containerRect.left + 44, width: 44 }
        : triggerRect,
      containerLeft: containerRect.left,
      visibleBounds,
      preferredWidth: menu.width,
      alignment: isEnvironment ? 'end' : 'start',
    })

    setDesktopMenuLayout(current =>
      current.placement === nextLayout.placement &&
      current.maxHeight === nextLayout.maxHeight &&
      current.left === horizontalLayout.left &&
      current.width === horizontalLayout.width
        ? current
        : { ...nextLayout, ...horizontalLayout }
    )
  }, [isEnvironment, menu, open, useMobileSheet])

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }

    if (!useMobileSheet) {
      document.addEventListener('pointerdown', handlePointerDown)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open, useMobileSheet])

  useLayoutEffect(() => {
    if (!open || useMobileSheet) return

    updateDesktopMenuLayout()
  }, [open, updateDesktopMenuLayout, useMobileSheet])

  useEffect(() => {
    if (!open || useMobileSheet) return

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateDesktopMenuLayout)
    const container = rootRef.current
    const boundary = container?.closest<HTMLElement>('[data-project-work-bar]')
    if (container) observer?.observe(container)
    if (boundary) observer?.observe(boundary)
    window.addEventListener('resize', updateDesktopMenuLayout)
    window.addEventListener('scroll', updateDesktopMenuLayout, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateDesktopMenuLayout)
      window.removeEventListener('scroll', updateDesktopMenuLayout, true)
    }
  }, [open, updateDesktopMenuLayout, useMobileSheet, variant])

  async function handleToggle() {
    if (!scope.isCurrent()) return
    if (open) {
      close()
      return
    }

    setOpen(true)
    setError(null)
    setBranchesLoading(true)
    const readSequence = ++readSequenceRef.current
    const isCurrent = () => scope.isCurrent() && readSequence === readSequenceRef.current
    try {
      await onRefresh?.()
      if (!isCurrent()) return
      const nextBranches = await onListBranches()
      if (isCurrent()) setBranches(nextBranches)
    } catch (nextError) {
      if (!isCurrent()) return
      if (isAbortError(nextError)) {
        close()
        return
      }
      setBranches([])
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('workbench.environment_branch_load_failed', '分支加载失败')
      )
    } finally {
      if (isCurrent()) setBranchesLoading(false)
    }
  }

  async function changeBranch(
    nextAction: 'switching' | 'creating',
    change: () => Promise<void> | void,
    failureKey: string
  ) {
    if (!scope.isCurrent() || action !== 'idle') return
    const intent = readSequenceRef.current
    const ownsMenu = () => scope.isCurrent() && intent === readSequenceRef.current
    setError(null)
    setAction(nextAction)
    try {
      await change()
      if (ownsMenu()) close()
    } catch (nextError) {
      if (ownsMenu()) setError(nextError instanceof Error ? nextError.message : t(failureKey))
    } finally {
      if (scope.isCurrent()) setAction('idle')
    }
  }

  function handleCheckout(branchName: string) {
    if (!scope.isCurrent()) return
    if (selectionOnly) {
      onSelectBranch(branchName)
      close()
      triggerRef.current?.focus()
      return
    }
    if (branchName === currentBranch) {
      close()
      return
    }
    return changeBranch(
      'switching',
      () => onSelectBranch(branchName),
      'workbench.environment_branch_checkout_failed'
    )
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const branchName = newBranchName.trim()
    if (!branchName || !onCreateBranch) return
    return changeBranch(
      'creating',
      () => onCreateBranch(branchName),
      'workbench.environment_branch_create_failed'
    )
  }

  const emptyBranchLabel = t(
    selectionOnly
      ? 'workbench.project_worktree_branch_empty'
      : isEnvironment
        ? 'workbench.environment_branch_empty'
        : 'workbench.environment_branch_select'
  )
  const branchLabel = loading ? loadingLabel : currentBranch || emptyBranchLabel

  return (
    <div ref={rootRef} className={cn('relative', !isEnvironment && 'min-w-0')}>
      <button
        ref={triggerRef}
        type="button"
        data-testid={`${prefix}-branch-${isEnvironment ? 'row' : 'button'}`}
        onClick={() => void handleToggle()}
        className={cn(
          isEnvironment
            ? 'flex h-9 w-full items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-hover'
            : 'flex h-9 min-w-[44px] max-w-full items-center gap-2 rounded-full px-2 text-sm font-normal leading-[18px] text-text-secondary transition-[background-color,color,box-shadow] hover:bg-background hover:text-text-primary hover:shadow-[0_10px_28px_rgba(0,0,0,0.14)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          useMobileSheet && 'font-medium',
          open &&
            !isEnvironment &&
            'bg-background text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.14)]'
        )}
        aria-label={menuTitle}
        title={!isEnvironment ? branchLabel : undefined}
        aria-expanded={open}
      >
        <GitBranch className={isEnvironment ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            !isEnvironment && styles.hideLabelOnNarrow,
            selectionOnly && 'max-w-[8rem]'
          )}
        >
          {branchLabel}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </button>

      {open && useMobileSheet && (
        <div className="fixed inset-0 z-modal bg-black/25" onClick={close} />
      )}

      {open && (
        <div
          data-testid={`${prefix}-branch-menu`}
          data-overlay-motion={useMobileSheet ? 'drawer' : 'popover'}
          data-mobile={useMobileSheet ? 'true' : undefined}
          className={cn(
            useMobileSheet
              ? 'fixed inset-x-0 bottom-0 z-modal flex max-h-[56dvh] flex-col rounded-t-[28px] border border-border bg-background px-5 pb-2 text-text-primary shadow-[0_-18px_48px_rgba(0,0,0,0.18)]'
              : 'absolute z-system-popover flex flex-col overflow-hidden rounded-2xl border border-border bg-background px-3 py-3 text-text-primary shadow-[0_18px_44px_rgba(0,0,0,0.18)]',
            selectionOnly && useMobileSheet && 'max-h-[45dvh]',
            !useMobileSheet &&
              (isEnvironment
                ? desktopMenuLayout.placement === 'below'
                  ? 'top-[38px]'
                  : 'bottom-[38px]'
                : desktopMenuLayout.placement === 'below'
                  ? 'top-11'
                  : 'bottom-11')
          )}
          style={
            useMobileSheet
              ? undefined
              : {
                  maxHeight: desktopMenuLayout.maxHeight,
                  left: desktopMenuLayout.left,
                  width: desktopMenuLayout.width,
                }
          }
        >
          {useMobileSheet && (
            <>
              <div className="mx-auto mt-2 h-1 w-11 shrink-0 rounded-full bg-border" />
              <div className="flex shrink-0 items-center justify-between pb-2 pt-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-text-primary">{menuTitle}</h2>
                  <p className="truncate text-xs text-text-muted">{branchLabel}</p>
                </div>
                <button
                  type="button"
                  data-testid={`${prefix}-branch-mobile-close-button`}
                  aria-label={t('workbench.close_menu', '关闭菜单')}
                  onClick={close}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-text-primary"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </>
          )}
          <label
            className={cn(
              'flex h-9 shrink-0 items-center gap-2 rounded-lg px-2 text-text-muted',
              useMobileSheet && 'h-11 shrink-0 rounded-2xl bg-surface px-4'
            )}
          >
            <Search className="h-4 w-4 shrink-0" />
            <input
              data-testid={`${prefix}-branch-search-input`}
              value={query}
              onChange={event => setQuery(event.target.value)}
              className={cn(
                'min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted',
                useMobileSheet && 'text-base leading-5'
              )}
              placeholder={t('workbench.environment_branch_search', '搜索分支')}
              autoFocus={!useMobileSheet}
            />
          </label>
          <h3
            className={cn(
              'mt-3 shrink-0 px-2 text-xs font-medium text-text-secondary',
              useMobileSheet && 'mt-2'
            )}
          >
            {t('workbench.environment_branches', '分支')}
          </h3>
          <div
            data-testid={`${prefix}-branch-list`}
            className={cn(
              'mt-2 min-h-0 flex-1 max-h-[220px] overflow-y-auto',
              useMobileSheet && 'scrollbar-none min-h-0 max-h-[260px] space-y-1 pb-1',
              selectionOnly && useMobileSheet && 'max-h-[28dvh]'
            )}
          >
            {branchesLoading && <p className="px-2 py-3 text-sm text-text-muted">{loadingLabel}</p>}
            {!branchesLoading && error && <p className="px-2 py-3 text-xs text-danger">{error}</p>}
            {!branchesLoading &&
              !error &&
              filteredBranches.map(branch => (
                <button
                  type="button"
                  key={branch}
                  data-testid={`${prefix}-branch-option`}
                  disabled={action !== 'idle'}
                  onClick={() => void handleCheckout(branch)}
                  className={cn(
                    'flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60',
                    useMobileSheet && 'h-11 text-base'
                  )}
                >
                  <GitBranch className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {branch === currentBranch && (
                    <Check className="h-4 w-4 shrink-0 text-text-secondary" />
                  )}
                </button>
              ))}
            {!branchesLoading && !error && filteredBranches.length === 0 && (
              <p
                data-testid={`${prefix}-branch-empty`}
                className="px-2 py-3 text-sm text-text-muted"
              >
                {t('workbench.environment_branch_empty_results', '没有匹配的分支')}
              </p>
            )}
          </div>
          {!selectionOnly && (
            <div
              className={cn(
                'mt-2 shrink-0 border-t border-border pt-2',
                useMobileSheet && 'mt-1 pt-1'
              )}
            >
              {createFormOpen ? (
                <form className="flex items-center gap-2" onSubmit={handleCreate}>
                  <input
                    data-testid={`${prefix}-new-branch-input`}
                    value={newBranchName}
                    onChange={event => setNewBranchName(event.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary"
                    placeholder={t('workbench.environment_new_branch_placeholder', '输入新分支名')}
                    autoFocus={!useMobileSheet}
                  />
                  <button
                    type="submit"
                    data-testid={`${prefix}-confirm-new-branch-button`}
                    disabled={!newBranchName.trim() || action !== 'idle'}
                    className="h-8 rounded-md bg-text-primary px-2 text-xs font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
                  >
                    {action === 'creating'
                      ? t('workbench.environment_branch_creating', '创建中')
                      : t('workbench.environment_branch_create_confirm', '创建')}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  data-testid={`${prefix}-open-new-branch-button`}
                  disabled={!onCreateBranch || action !== 'idle'}
                  onClick={() => setCreateFormOpen(true)}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
                >
                  <Plus className="h-4 w-4" />
                  {t('workbench.environment_branch_create_checkout', '创建并检出新分支...')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
