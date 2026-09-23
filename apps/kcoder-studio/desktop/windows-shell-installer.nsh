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
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\shell\repair-shortcuts.ps1" -InstallDir "$INSTDIR" -DesktopLink "$newDesktopLink" -StartMenuLink "$newStartMenuLink"'
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
