import { Download, Loader2, LogIn, LogOut, Settings, UserRound, UserRoundPlus } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { desktopHost } from '@/kcoder/desktopHost'
import { RuntimeTargetConfirmDialog } from '@/components/settings/RuntimeTargetConfirmDialog'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import { useConfiguredKeybinding } from '@/hooks/useConfiguredKeybinding'
import { OPEN_SETTINGS_COMMAND } from '@/lib/keybindings'
import { isKCoderDesktopHostPage, isKCoderGatewayPage, type GatewayServer } from '@/kcoder/gatewayRpc'
import { GatewayAccountLoginDialog } from './GatewayAccountLoginDialog'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import type { User as UserProfile } from '@/types/api'

function formatVersionTemplate(template: string, version: string): string {
  return template.replace('{{version}}', version)
}

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
    template
  )
}

function calculateDownloadPercent(
  downloadedBytes: number,
  totalBytes: number | null
): number | null {
  if (!totalBytes || totalBytes <= 0) return null
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
}

function UpdateDownloadProgressIcon({ progress }: { progress: number }) {
  return (
    <span
      data-testid="app-update-download-icon-progress"
      aria-label={`${progress}%`}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(rgb(var(--color-primary)) ${progress}%, rgb(var(--color-border)) 0)`,
      }}
    >
      <span className="h-2 w-2 rounded-full bg-popover" />
    </span>
  )
}

interface DesktopSettingsMenuProps {
  user: UserProfile | null
  onOpenSettings: () => void
  onLogout: () => void
  onLogin?: () => void
  showLogout?: boolean
  // KCoder account targets with their per-context login state; when present,
  // the menu grows a per-target login/switch/sign-out section.
  accountTargets?: GatewayServer[]
  onAccountLogout?: (server: GatewayServer) => void
}

export function DesktopSettingsMenu({
  onOpenSettings,
  onLogout,
  onLogin,
  showLogout,
  accountTargets,
  onAccountLogout,
}: DesktopSettingsMenuProps) {
  const { t } = useTranslation('common')
  const settingsShortcut = useConfiguredKeybinding(OPEN_SETTINGS_COMMAND)
  const host = desktopHost()
  const shouldShowLogout =
    showLogout ??
    (!isLocalFirstAppRuntime() || (isKCoderGatewayPage() && !isKCoderDesktopHostPage()))
  const appUpdate = useOptionalAppUpdate()
  const supported = Boolean(appUpdate) && appUpdate?.supported !== false
  const dismissError = appUpdate?.dismissError
  const [confirmQuit, setConfirmQuit] = useState(false)
  const [quitting, setQuitting] = useState(false)
  const [quitError, setQuitError] = useState(false)
  const [accountPending, setAccountPending] = useState<false | { action: 'logout' | 'switch'; server: GatewayServer }>(false)
  const [accountError, setAccountError] = useState('')
  const [loginDialogFor, setLoginDialogFor] = useState<GatewayServer | null>(null)
  const accountBusy = accountPending !== false && quitting
  useEffect(() => {
    dismissError?.()
    return () => dismissError?.()
  }, [dismissError])
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const updateStatus = appUpdate?.status ?? 'idle'
  const downloadProgress = appUpdate?.downloadProgress ?? null
  const updateError = appUpdate?.error ?? null
  const checkNow = appUpdate?.checkNow
  const installUpdate = appUpdate?.installUpdate

  const handleUpdateClick = async () => {
    if (!supported) return
    if (availableUpdate && installUpdate) {
      await installUpdate()
      return
    }

    await checkNow?.()
  }

  const updateButtonLabel = availableUpdate
    ? formatVersionTemplate(
        t('workbench.app_update_install', {
          defaultValue: '更新到 {{version}}',
          version: availableUpdate.version,
        }),
        availableUpdate.version
      )
    : t('workbench.app_update_check', { defaultValue: '检查更新' })
  const isUpdateBusy = updateStatus === 'checking' || updateStatus === 'installing'
  const downloadPercent = downloadProgress
    ? calculateDownloadPercent(downloadProgress.downloadedBytes, downloadProgress.totalBytes)
    : null
  const updateMessage =
    updateStatus === 'installing'
      ? null
      : availableUpdate
        ? formatVersionTemplate(
            t('workbench.app_update_available', {
              defaultValue: '发现新版本 {{version}}',
              version: availableUpdate.version,
            }),
            availableUpdate.version
          )
        : updateStatus === 'upToDate'
          ? t('workbench.app_update_up_to_date', {
              defaultValue: '已是最新版本',
            })
          : null
  const downloadMessage =
    updateStatus === 'installing'
      ? downloadPercent === null
        ? t('workbench.app_update_downloading', { defaultValue: '正在下载更新' })
        : t('workbench.app_update_downloading_progress', {
            defaultValue: '正在下载更新 {{progress}}%',
            progress: downloadPercent,
          }).replace('{{progress}}', String(downloadPercent))
      : null

  return (
    <div
      data-testid="settings-menu"
      className="absolute bottom-[72px] left-1.5 right-1.5 z-30 overflow-hidden rounded-[20px] border border-border/70 bg-popover/95 py-2.5 text-text-primary shadow-[0_24px_60px_rgba(0,0,0,0.36)] ring-1 ring-border/40 backdrop-blur-xl"
    >
      {onLogin ? (
        <>
          <SettingsMenuItem
            testId="login-menu-button"
            icon={<LogIn className="h-4 w-4 shrink-0 text-primary" />}
            label={t('workbench.account_cloud_login', '云登录不可用')}
            description={t(
              'workbench.account_cloud_login_description',
              '当前客户端不提供旧版云登录'
            )}
            onClick={onLogin}
          />
          <div className="mx-4 my-1.5 border-t border-border/70" />
        </>
      ) : null}
      <SettingsMenuItem
        testId="settings-menu-button"
        icon={<Settings className="h-4 w-4 shrink-0 text-text-secondary" />}
        label={t('workbench.settings', '设置')}
        shortcut={settingsShortcut ?? undefined}
        onClick={onOpenSettings}
      />
      <SettingsMenuItem
        testId="check-app-update-button"
        icon={
          updateStatus === 'installing' && downloadPercent !== null ? (
            <UpdateDownloadProgressIcon progress={downloadPercent} />
          ) : isUpdateBusy ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-secondary" />
          ) : (
            <Download className="h-4 w-4 shrink-0 text-text-secondary" />
          )
        }
        label={supported ? updateButtonLabel : t('workbench.app_update_unsupported')}
        onClick={handleUpdateClick}
        disabled={!supported || isUpdateBusy}
        active={Boolean(updateError)}
      />
      {downloadMessage ? (
        <div
          data-testid="app-update-download-progress"
          className="space-y-1.5 px-4 pb-2 pl-[44px] pr-5 text-xs font-medium leading-[18px] text-text-secondary"
        >
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={
                downloadPercent === null
                  ? 'h-full w-1/3 animate-pulse rounded-full bg-primary'
                  : 'h-full rounded-full bg-primary transition-[width] duration-200'
              }
              style={downloadPercent === null ? undefined : { width: `${downloadPercent}%` }}
            />
          </div>
          <span>{downloadMessage}</span>
        </div>
      ) : null}
      {updateMessage || updateError ? (
        <div
          data-testid="app-update-status"
          className="px-4 pb-2 pl-[44px] pr-5 text-xs font-medium leading-[18px] text-text-secondary"
        >
          <span className={updateError ? 'text-red-400' : undefined}>
            {updateError ?? updateMessage}
          </span>
          {updateError && dismissError && (
            <button
              type="button"
              data-testid="dismiss-app-update-error"
              className="mt-1 block rounded px-2 py-1 text-text-primary focus-visible:ring-2"
              onClick={dismissError}
            >
              {t('workbench.dismiss_error')}
            </button>
          )}
        </div>
      ) : null}
      {accountTargets && accountTargets.length > 0 ? (
        <>
          <div className="mx-4 my-1.5 border-t border-border/70" />
          <p className="px-4 pb-1 pt-0.5 text-xs font-medium leading-4 text-text-muted" data-testid="gateway-account-section">
            {t('workbench.account_gateway_section', { defaultValue: 'KCoder 账号' })}
          </p>
          {accountTargets.map(server => {
            const identity = server.accountIdentity
            if (!identity) {
              return (
                <SettingsMenuItem
                  key={server.id}
                  testId={`gateway-account-login-${server.id}`}
                  icon={<UserRoundPlus className="h-4 w-4 shrink-0 text-primary" />}
                  label={formatTemplate(
                    t('workbench.account_gateway_login', '登录账号 · {{name}}'),
                    { name: server.label }
                  )}
                  onClick={() => setLoginDialogFor(server)}
                />
              )
            }
            return (
              <Fragment key={server.id}>
                <SettingsMenuItem
                  testId={`gateway-account-switch-${server.id}`}
                  icon={<UserRound className="h-4 w-4 shrink-0 text-text-secondary" />}
                  label={formatTemplate(
                    t('workbench.account_gateway_switch', '切换账号 · {{name}}'),
                    { name: server.label }
                  )}
                  description={formatTemplate(
                    t('workbench.account_gateway_current', '当前账号：{{username}}'),
                    { username: identity.username }
                  )}
                  onClick={() => setAccountPending({ action: 'switch', server })}
                />
                <SettingsMenuItem
                  testId={`gateway-account-logout-${server.id}`}
                  icon={<LogOut className="h-4 w-4 shrink-0 text-text-secondary" />}
                  label={formatTemplate(
                    t('workbench.account_gateway_logout', '退出账号 · {{name}}'),
                    { name: server.label }
                  )}
                  onClick={() => setAccountPending({ action: 'logout', server })}
                />
              </Fragment>
            )
          })}
        </>
      ) : null}
      {shouldShowLogout ? (
        <>
          <div className="mx-4 my-1.5 border-t border-border/70" />
          <SettingsMenuItem
            testId="logout-menu-button"
            icon={<LogOut className="h-4 w-4 shrink-0 text-text-secondary" />}
            label={t('workbench.logout', '退出登录')}
            onClick={onLogout}
          />
        </>
      ) : null}
      {host && (
        <>
          <div className="mx-4 my-1.5 border-t border-border/70" />
          <SettingsMenuItem
            testId="quit-app-menu-button"
            icon={<LogOut className="h-4 w-4 shrink-0 text-text-secondary" />}
            label={t('workbench.quit_app')}
            description={!shouldShowLogout ? t('workbench.local_session_no_account') : undefined}
            onClick={() => {
              setQuitError(false)
              setConfirmQuit(true)
            }}
          />
          {quitError && (
            <div role="alert" className="px-4 text-sm text-red-600">
              <p>{t('workbench.quit_app_failed')}</p>
              <button
                type="button"
                data-testid="dismiss-quit-error"
                className="mt-1 rounded px-2 py-1 text-text-primary focus-visible:ring-2"
                onClick={() => setQuitError(false)}
              >
                {t('workbench.dismiss_error')}
              </button>
            </div>
          )}
        </>
      )}
      {confirmQuit && (
        <RuntimeTargetConfirmDialog
          testId="quit-app-dialog"
          title={t('workbench.quit_app')}
          description={t('workbench.quit_app_confirm')}
          cancelLabel={t('workbench.cancel')}
          closeLabel={t('workbench.cancel')}
          confirmLabel={t('workbench.quit_app')}
          pending={quitting}
          onCancel={() => {
            if (!quitting) setConfirmQuit(false)
          }}
          onConfirm={() => {
            if (quitting || !host) return
            setQuitting(true)
            void host.windowAction('quit').catch(() => {
              setQuitting(false)
              setConfirmQuit(false)
              setQuitError(true)
            })
          }}
        />
      )}
      {loginDialogFor && !accountPending && (
        <GatewayAccountLoginDialog
          server={loginDialogFor}
          onDone={() => setLoginDialogFor(null)}
          onCancel={() => setLoginDialogFor(null)}
        />
      )}
      {accountPending && (
        <RuntimeTargetConfirmDialog
          testId={
            accountPending.action === 'switch'
              ? 'gateway-account-switch-dialog'
              : 'gateway-account-logout-dialog'
          }
          title={formatTemplate(
            accountPending.action === 'switch'
              ? t('workbench.account_gateway_switch', '切换账号 · {{name}}')
              : t('workbench.account_gateway_logout', '退出账号 · {{name}}'),
            { name: accountPending.server.label }
          )}
          description={formatTemplate(
            accountPending.action === 'switch'
              ? t(
                  'workbench.account_gateway_switch_confirm',
                  '将退出 {{name}} 上的当前账号并断开其任务连接，然后前往登录页面。'
                )
              : t(
                  'workbench.account_gateway_logout_confirm',
                  '退出 {{name}} 上的 KCoder 账号会断开该目标上此账号的任务和连接。'
                ),
            { name: accountPending.server.label }
          )}
          cancelLabel={t('workbench.cancel')}
          closeLabel={t('workbench.cancel')}
          confirmLabel={
            accountPending.action === 'switch'
              ? t('workbench.account_gateway_switch_confirm_action', '退出并切换')
              : t('workbench.account_gateway_logout_confirm_action', '退出账号')
          }
          pending={accountBusy}
          error={accountError || undefined}
          onCancel={() => {
            if (!accountBusy) setAccountPending(false)
          }}
          onConfirm={() => {
            if (accountBusy) return
            const { action, server } = accountPending
            setQuitting(true)
            setAccountError('')
            void Promise.resolve(onAccountLogout?.(server))
              .then(() => {
                setAccountPending(false)
                if (action === 'switch') setLoginDialogFor(server)
              })
              .catch(value => {
                setAccountError(value instanceof Error ? value.message : String(value))
              })
              .finally(() => {
                setQuitting(false)
              })
          }}
        />
      )}
    </div>
  )
}

interface SettingsMenuItemProps {
  testId: string
  icon: ReactNode
  label: string
  description?: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void | Promise<void>
}

function SettingsMenuItem({
  testId,
  icon,
  label,
  description,
  shortcut,
  active = false,
  disabled = false,
  onClick,
}: SettingsMenuItemProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-3 px-4 text-left text-sm font-normal leading-[18px] text-text-primary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 ${
        description ? 'min-h-12 py-2' : 'h-9'
      } ${active ? 'bg-hover' : ''}`}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description ? (
          <span className="block truncate text-xs font-normal leading-4 text-text-muted">
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <KeyboardShortcut
          value={shortcut}
          className="h-6 bg-muted px-2 text-sm text-text-secondary"
        />
      ) : null}
    </button>
  )
}
