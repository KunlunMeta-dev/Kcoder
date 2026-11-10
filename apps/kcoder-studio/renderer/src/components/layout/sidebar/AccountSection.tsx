import { useEffect, useRef, useState } from 'react'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { fetchKCoderAccount, type KCoderAccountStatus } from '@/kcoder/mobilePairing'
import { KCoderAccountDialog } from '../KCoderAccountDialog'
import { ClientAvatar } from '@/features/appearance/ClientAvatar'
import { cn } from '@/lib/utils'
import { DesktopSettingsMenu } from '../DesktopSettingsMenu'
import { GlobalImNotificationBell } from './NotificationSection'
import { SidebarAppUpdateButton } from './SidebarAppUpdate'
import type { SidebarModel } from './useSidebarModel'

export function AccountSection({ model }: { model: SidebarModel }) {
  const {
    user,
    devices,
    imNotificationSettings,
    onToggleGlobalImNotification,
    onOpenGlobalImNotificationSettings,
    onOpenStandaloneFolderProject,
    onOpenSettings,
    onLogout,
    t,
    cloud,
    usesCloudAccount,
    requiresCloudLogin,
    hasAvailableAppUpdate,
    experimentalFeaturesEnabled,
    gatewayAccountTargets,
    handleGatewayAccountLogout,
    sidebarAccount,
    settingsMenuOpen,
    setSettingsMenuOpen,
    setAccountCloudDialogOpen,
    imNotificationMenuOpen,
    setImNotificationMenuOpen,
    settingsMenuRef,
    setStandaloneWorkspaceDialogMode,
    setStandaloneRemoteDialogIntent,
  } = model
  const [productAccount, setProductAccount] = useState<KCoderAccountStatus | null>(null)
  const [productDialog, setProductDialog] = useState<'login' | 'logout' | null>(null)
  const accountLoaded = useRef(false)
  useEffect(() => {
    if (!isKCoderGatewayPage() || (!settingsMenuOpen && accountLoaded.current)) return
    const controller = new AbortController()
    void fetchKCoderAccount(controller.signal).then(status => {
      if (!controller.signal.aborted) {
        accountLoaded.current = true
        setProductAccount(status)
      }
    }).catch(error => {
      if (!controller.signal.aborted && error?.code === 'KCODER_ACCOUNT_UNAVAILABLE') {
        setProductAccount(current => current ?? { available: true, account: null })
      }
    })
    return () => controller.abort()
  }, [settingsMenuOpen])
  const useProductAccount = Boolean(productAccount?.available)
  const signedIn = useProductAccount && Boolean(productAccount?.account)
  return (
    <>
      <div ref={settingsMenuRef} className="group/account relative shrink-0">
        <div className="relative flex h-[60px] items-center rounded-[10px] transition-colors group-hover/account:bg-[rgb(var(--color-sidebar-hover))] group-focus-within/account:bg-[rgb(var(--color-sidebar-hover))]">
          <button
            type="button"
            data-testid="settings-button"
            onClick={() => {
              setImNotificationMenuOpen(false)
              setSettingsMenuOpen(open => !open)
            }}
            className={cn(
              'flex h-[60px] min-w-0 flex-1 items-center gap-3 rounded-[10px] py-2 pl-1.5 text-left text-[rgb(var(--color-sidebar-text-primary))]',
              hasAvailableAppUpdate ? 'pr-[72px]' : 'pr-10'
            )}
            title={t('workbench.account_and_settings', '账户与设置')}
            aria-label={t('workbench.account_and_settings', '账户与设置')}
            aria-expanded={settingsMenuOpen}
          >
            <span
              data-testid="sidebar-account-avatar"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary"
            >
              <ClientAvatar />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold leading-[18px]">
                {signedIn ? t('workbench.kcoder_account_label') : sidebarAccount.label}
              </span>
              <span className="block truncate text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-secondary))]">
                {signedIn ? productAccount?.account?.username : sidebarAccount.detail}
              </span>
            </span>
          </button>
          <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {hasAvailableAppUpdate && (
              <div data-testid="sidebar-app-update-action">
                <SidebarAppUpdateButton
                  onBeforeInstall={() => {
                    setSettingsMenuOpen(false)
                    setImNotificationMenuOpen(false)
                  }}
                />
              </div>
            )}
            {experimentalFeaturesEnabled && (
              <GlobalImNotificationBell
                devices={devices}
                imNotificationSettings={imNotificationSettings}
                menuOpen={imNotificationMenuOpen}
                menuContainerRef={settingsMenuRef}
                onMenuOpenChange={open => {
                  if (open) setSettingsMenuOpen(false)
                  setImNotificationMenuOpen(open)
                }}
                onToggleGlobalImNotification={onToggleGlobalImNotification}
                onOpenGlobalImNotificationSettings={onOpenGlobalImNotificationSettings}
                onOpenSettings={() => onOpenSettings()}
                onAddCloudDevice={() => {
                  if (onOpenStandaloneFolderProject) {
                    onOpenStandaloneFolderProject('remote', 'add-device')
                  } else {
                    setStandaloneRemoteDialogIntent('add-device')
                    setStandaloneWorkspaceDialogMode('remote')
                  }
                }}
              />
            )}
          </div>
          {settingsMenuOpen && (
            <DesktopSettingsMenu
              user={user}
              showLogout={signedIn || (usesCloudAccount ? cloud.isConnected : undefined)}
              productLogin={useProductAccount}
              logoutLabel={signedIn ? t('workbench.kcoder_account_logout') : useProductAccount && !usesCloudAccount ? t('workbench.kcoder_account_disconnect_web') : undefined}
              accountTargets={gatewayAccountTargets}
              onAccountLogout={handleGatewayAccountLogout}
              onOpenSettings={() => {
                setSettingsMenuOpen(false)
                onOpenSettings()
              }}
              onLogin={
                useProductAccount
                  ? signedIn ? undefined : () => {
                      setSettingsMenuOpen(false)
                      setProductDialog('login')
                    }
                  : requiresCloudLogin
                  ? () => {
                      setSettingsMenuOpen(false)
                      setAccountCloudDialogOpen(true)
                    }
                  : undefined
              }
              onLogout={() => {
                setSettingsMenuOpen(false)
                if (signedIn) {
                  setProductDialog('logout')
                  return
                }
                if (usesCloudAccount) {
                  cloud.disconnect()
                  return
                }
                onLogout()
              }}
            />
          )}
        </div>
      </div>
      {productDialog && <KCoderAccountDialog signOut={productDialog === 'logout'} portalUrl={productAccount?.portalUrl}
        onClose={() => setProductDialog(null)} onDone={status => {
          setProductAccount(status)
          if (!status.revocationUnconfirmed && !status.relayRegistrationFailed) setProductDialog(null)
        }} />}
    </>
  )
}
