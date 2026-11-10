!define KCODER_INSTALLER_SHELL_DIR "${__FILEDIR__}\windows-shell"
Var /GLOBAL pid

!macro customCheckAppRunning
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
    ${IfNot} ${Silent}
      ${If} $LANGUAGE == 2052
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "需要先关闭此安装的 Studio、CLI 和后台进程。继续会中断其中正在执行的任务。是否关闭并继续？" IDCANCEL kcoderPreflightCancelled
      ${Else}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Studio, CLI and background processes from this installation must close. Continuing will interrupt their active tasks. Close them and continue?" IDCANCEL kcoderPreflightCancelled
      ${EndIf}
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
