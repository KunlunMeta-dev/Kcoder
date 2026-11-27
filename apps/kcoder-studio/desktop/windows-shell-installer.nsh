!define KCODER_INSTALLER_SHELL_DIR "${__FILEDIR__}\windows-shell"
Var /GLOBAL pid

!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"
!include "UAC.nsh"
Var kcoderDataRoot
Var kcoderCacheRoot
Var kcoderDataRootEdit
Var kcoderCacheRootEdit
Var kcoderStoragePerUser
Var kcoderStorageArgs

LangString kcoderStorageTitle 1033 "Data and cache folders"
LangString kcoderStorageTitle 2052 "数据与缓存目录"
LangString kcoderStorageDescription 1033 "Choose folders independently of the application installation folder."
LangString kcoderStorageDescription 2052 "数据位置与软件安装目录分别设置。"
LangString kcoderStorageHelp 1033 "Leave a field empty to keep its saved choice or first-launch default. Changing existing data requires migration preview; the current location stays active until migration completes."
LangString kcoderStorageHelp 2052 "留空将保留已选位置，首次安装则使用默认位置。更改已有数据位置须先预览迁移，迁移完成前仍使用原目录。"
LangString kcoderStorageData 1033 "Configuration and data folder:"
LangString kcoderStorageData 2052 "配置与数据目录："
LangString kcoderStorageCache 1033 "Temporary files and cache folder:"
LangString kcoderStorageCache 2052 "临时与缓存目录："
LangString kcoderStorageBrowse 1033 "Browse..."
LangString kcoderStorageBrowse 2052 "浏览..."
LangString kcoderStorageDeferred 1033 "This installation is for all users or is elevated. Each account chooses its own data and cache folders at first launch. No personal location is saved by this installer."
LangString kcoderStorageDeferred 2052 "此次为全用户安装或已提权。各账户将在首次启动时选择自己的数据与缓存目录，安装器不会保存个人目录。"
LangString kcoderStorageAccountError 1033 "Data/cache arguments require a non-elevated current-user installation. Install without these arguments, then choose folders when running Studio as the intended user."
LangString kcoderStorageAccountError 2052 "数据与缓存参数仅适用于未提权的当前用户安装。请去掉这些参数，安装后由实际使用账户启动 Studio 选择目录。"
LangString kcoderStoragePathError 1033 "Enter absolute folder paths without quotes or line breaks, or leave fields empty. If the paths exceed the installer's limit, choose shorter paths or select them at first launch."
LangString kcoderStoragePathError 2052 "请输入不含引号或换行的绝对目录，或将字段留空。若路径超出安装器长度限制，请缩短路径或在首次启动时选择。"
LangString kcoderStorageFailed 1033 "The application was installed, but the requested data/cache choice was not confirmed. Open Studio as the intended user to check the current storage and migration status."
LangString kcoderStorageFailed 2052 "软件已安装，但未能确认请求的数据与缓存选择结果。请由实际使用账户打开 Studio 核对当前目录和迁移状态。"

!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KCODER_DATA_ROOT=" $kcoderDataRoot
  ${IfNot} ${Errors}
  ${AndIf} $kcoderDataRoot == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(kcoderStoragePathError)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/KCODER_CACHE_ROOT=" $kcoderCacheRoot
  ${IfNot} ${Errors}
  ${AndIf} $kcoderCacheRoot == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(kcoderStoragePathError)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Call kcoderCheckStorageAccount
!macroend

!macro customPageAfterChangeDir
  Page custom kcoderStoragePage kcoderStoragePageLeave

  Function kcoderCheckStorageAccount
    StrCpy $kcoderStoragePerUser "1"
    ${If} $installMode == "all"
    ${OrIf} ${UAC_IsInnerInstance}
    ${OrIf} ${UAC_IsAdmin}
      StrCpy $kcoderStoragePerUser "0"
      ${If} $kcoderDataRoot != ""
      ${OrIf} $kcoderCacheRoot != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(kcoderStorageAccountError)" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function kcoderStoragePage
    Call kcoderCheckStorageAccount
    !insertmacro MUI_HEADER_TEXT "$(kcoderStorageTitle)" "$(kcoderStorageDescription)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${If} $kcoderStoragePerUser == "0"
      ${NSD_CreateLabel} 0 0 100% 60u "$(kcoderStorageDeferred)"
      Pop $0
    ${Else}
      ${NSD_CreateLabel} 0 0 100% 44u "$(kcoderStorageHelp)"
      Pop $0
      ${NSD_CreateLabel} 0 50u 100% 12u "$(kcoderStorageData)"
      Pop $0
      ${NSD_CreateDirRequest} 0 64u 78% 14u "$kcoderDataRoot"
      Pop $kcoderDataRootEdit
      ${NSD_CreateBrowseButton} 80% 63u 20% 16u "$(kcoderStorageBrowse)"
      Pop $0
      ${NSD_OnClick} $0 kcoderBrowseDataRoot
      ${NSD_CreateLabel} 0 88u 100% 12u "$(kcoderStorageCache)"
      Pop $0
      ${NSD_CreateDirRequest} 0 102u 78% 14u "$kcoderCacheRoot"
      Pop $kcoderCacheRootEdit
      ${NSD_CreateBrowseButton} 80% 101u 20% 16u "$(kcoderStorageBrowse)"
      Pop $0
      ${NSD_OnClick} $0 kcoderBrowseCacheRoot
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function kcoderBrowseDataRoot
    Pop $0
    ${NSD_GetText} $kcoderDataRootEdit $kcoderDataRoot
    nsDialogs::SelectFolderDialog "$(kcoderStorageData)" "$kcoderDataRoot"
    Pop $0
    ${If} $0 != error
      ${NSD_SetText} $kcoderDataRootEdit $0
    ${EndIf}
  FunctionEnd

  Function kcoderBrowseCacheRoot
    Pop $0
    ${NSD_GetText} $kcoderCacheRootEdit $kcoderCacheRoot
    nsDialogs::SelectFolderDialog "$(kcoderStorageCache)" "$kcoderCacheRoot"
    Pop $0
    ${If} $0 != error
      ${NSD_SetText} $kcoderCacheRootEdit $0
    ${EndIf}
  FunctionEnd

  Function kcoderStoragePageLeave
    ${If} $kcoderStoragePerUser == "1"
      ${NSD_GetText} $kcoderDataRootEdit $kcoderDataRoot
      ${NSD_GetText} $kcoderCacheRootEdit $kcoderCacheRoot
      Call kcoderValidateStorageArguments
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(kcoderStoragePathError)"
        Abort
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function kcoderValidateStorageArguments
    ClearErrors
    # Do not let NSIS truncate a root or its command-line quoting.
    StrLen $R1 $kcoderDataRoot
    StrLen $R2 $kcoderCacheRoot
    StrLen $R3 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    IntOp $R1 $R1 + $R2
    IntOp $R1 $R1 + $R3
    IntOp $R1 $R1 + 256
    ${If} $R1 >= ${NSIS_MAX_STRLEN}
      SetErrors
      Return
    ${EndIf}
    StrCpy $R1 "$kcoderDataRoot$kcoderCacheRoot"
    StrCpy $R2 0
    ${Do}
      StrCpy $R3 $R1 1 $R2
      ${If} $R3 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $R3 == '$\"'
      ${OrIf} $R3 == '$\r'
      ${OrIf} $R3 == '$\n'
        SetErrors
        Return
      ${EndIf}
      IntOp $R2 $R2 + 1
    ${Loop}
  FunctionEnd
!macroend
!endif

!macro customCheckAppRunning
!ifndef BUILD_UNINSTALLER
  Call kcoderCheckStorageAccount
  Call kcoderValidateStorageArguments
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(kcoderStoragePathError)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!endif
  InitPluginsDir
  File /oname=$PLUGINSDIR\kcoder-process-preflight.ps1 "${KCODER_INSTALLER_SHELL_DIR}\close-installed-processes.ps1"
  System::Call 'kernel32::GetCurrentProcessId() i.r9'
  StrCpy $pid $9
  StrCpy $R0 "User"
  ${If} $installMode == "all"
    StrCpy $R0 "Machine"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=45000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\kcoder-process-preflight.ps1" -InstallDir "$INSTDIR" -Scope "$R0" -AppGuid "${APP_GUID}" -InstallerPid $pid -Mode Inspect'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 == 10
    ${If} ${Silent}
      ${If} $LANGUAGE == 2052
        DetailPrint "KCoder 进程仍在运行。请关闭后再进行静默安装。"
      ${Else}
        DetailPrint "KCoder processes are still running. Close them before an unattended installation."
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} $LANGUAGE == 2052
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "需要先关闭此安装的 Studio、CLI 和后台进程。继续会中断其中正在执行的任务。是否关闭并继续？" IDCANCEL kcoderPreflightCancelled
    ${Else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Studio, CLI and background processes from this installation must close. Continuing will interrupt their active tasks. Close them and continue?" IDCANCEL kcoderPreflightCancelled
    ${EndIf}
    nsExec::ExecToStack /TIMEOUT=90000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\kcoder-process-preflight.ps1" -InstallDir "$INSTDIR" -Scope "$R0" -AppGuid "${APP_GUID}" -InstallerPid $pid -Mode Close'
    Pop $0
    Pop $1
    DetailPrint "$1"
  ${EndIf}
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)"
    SetErrorLevel 2
    Quit
  ${EndIf}
  Goto kcoderPreflightComplete
  kcoderPreflightCancelled:
    SetErrorLevel 2
    Quit
  kcoderPreflightComplete:
!macroend

!macro customInstall
  StrCpy $R0 "User"
  ${If} $installMode == "all"
    StrCpy $R0 "Machine"
  ${EndIf}
  DetailPrint "Installing KCoder CLI command ($R0)..."
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\shell\install-cli.ps1" -InstallDir "$INSTDIR" -Mode Install -Scope "$R0"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    DetailPrint "KCoder CLI PATH registration failed (exit $0)."
    IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "Studio and the CLI were installed, but CLI PATH registration failed. Run the installer again, or add $INSTDIR\resources\bin to PATH."
  ${EndIf}
  # Elevated/all-user installation must not publish an administrator's personal choice.
  Call kcoderCheckStorageAccount
  ${If} $kcoderStoragePerUser == "1"
    StrCpy $kcoderStorageArgs ""
    # A final \. keeps a trailing backslash from escaping the Windows argument quote.
    ${If} $kcoderDataRoot != ""
      StrCpy $kcoderStorageArgs '$kcoderStorageArgs --data-root "$kcoderDataRoot\."'
    ${EndIf}
    ${If} $kcoderCacheRoot != ""
      StrCpy $kcoderStorageArgs '$kcoderStorageArgs --cache-root "$kcoderCacheRoot\."'
    ${EndIf}
    ${If} ${Silent}
      StrCpy $kcoderStorageArgs "$kcoderStorageArgs --storage-install-silent"
    ${EndIf}
    DetailPrint "Preparing KCoder startup for the current Windows account..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --prepare-windows-startup$kcoderStorageArgs' $0
    ${If} $0 != 0
      DetailPrint "Startup profile preparation deferred to first launch (exit $0)."
      ${If} $kcoderDataRoot != ""
      ${OrIf} $kcoderCacheRoot != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(kcoderStorageFailed)" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  ${Else}
    DetailPrint "Personal storage choice deferred to the actual user's first launch."
  ${EndIf}
  # Run after electron-builder creates or retains this installation's shortcuts.
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\shell\repair-shortcuts.ps1" -InstallDir "$INSTDIR" -ExecutableName "${APP_EXECUTABLE_FILENAME}" -DesktopLink "$newDesktopLink" -StartMenuLink "$newStartMenuLink"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    DetailPrint "KCoder shortcut icon update failed (exit $0)."
    IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "KCoder installed, but Windows shortcut icons could not be refreshed. Run the installer again to retry."
  ${EndIf}
!macroend

!macro customUnInstall
  # Keep the cleanup code available after the installed files have been removed.
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\resources\shell\install-cli.ps1" "$PLUGINSDIR\kcoder-cli-cleanup.ps1"
!macroend

!macro customUnInstallSection
  Section "un.-KCoder CLI PATH"
    SectionIn RO
    # Failed atomic upgrade removal aborts before this section can change PATH.
    StrCpy $R0 "User"
    ${If} $installMode == "all"
      StrCpy $R0 "Machine"
    ${EndIf}
    nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\kcoder-cli-cleanup.ps1" -InstallDir "$INSTDIR" -Mode Uninstall -Scope "$R0"'
    Pop $0
    Pop $1
    DetailPrint "$1"
    ${If} $0 != 0
      DetailPrint "KCoder CLI PATH cleanup failed (exit $0)."
    ${EndIf}
  SectionEnd
!macroend
