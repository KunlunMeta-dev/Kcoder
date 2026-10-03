Unicode true

!include "MUI2.nsh"
!include "StrFunc.nsh"
!include "WinVer.nsh"
!include "WinMessages.nsh"
${Using:StrFunc} StrStrAdv
${Using:StrFunc} StrRep
${Using:StrFunc} UnStrRep

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSION4
  !define VERSION4 "0.0.0.0"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is required"
!endif
!ifndef CLI_BINARY
  !error "CLI_BINARY is required"
!endif
!ifndef SUPERVISOR_BINARY
  !error "SUPERVISOR_BINARY is required"
!endif
!ifndef RIPGREP_BINARY
  !define RIPGREP_BINARY ""
!endif
!ifndef CHROME_DIRECTORY
  !define CHROME_DIRECTORY ""
!endif

Name "KCoder ${VERSION}"
Caption "KCoder ${VERSION} Setup"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\KCoder"
InstallDirRegKey HKCU "Software\KCoder" "InstallDir"
RequestExecutionLevel highest
ShowInstDetails show
ShowUninstDetails show
CRCCheck force
BrandingText "KCoder"

VIProductVersion "${VERSION4}"
VIAddVersionKey /LANG=1033 "ProductName" "KCoder"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "KCoder Windows installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "KCoder contributors"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to KCoder ${VERSION} Setup"
!define MUI_WELCOMEPAGE_TEXT "This wizard installs KCoder for the current Windows user. You can choose the installation folder on the next page."
!define MUI_FINISHPAGE_TITLE "KCoder installation complete"
!define MUI_FINISHPAGE_TEXT "KCoder was installed successfully. Open a new terminal before running kcoder."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Var LegacyInstallDir
Var LegacyCleanupIncomplete
Var TransactionDir
Var MainBackedUp
Var HelperBackedUp
Var MainCommitted
Var HelperCommitted
Var RollbackFailed
Var ChromeBackedUp
Var ChromeCommitted

!define RETIRED_NAME_A "Kunlun"
!define RETIRED_NAME_B "Code"
!define RETIRED_NAME_COMPACT "${RETIRED_NAME_A}${RETIRED_NAME_B}"
!define RETIRED_NAME_SPACED "${RETIRED_NAME_A} ${RETIRED_NAME_B}"
!define RETIRED_FILE_A "kunlun"
!define RETIRED_FILE_B "code"
!define RETIRED_FILE_COMPACT "${RETIRED_FILE_A}${RETIRED_FILE_B}"
!define RETIRED_FILE_DASHED "${RETIRED_FILE_A}-${RETIRED_FILE_B}"
!define RETIRED_ENV_A "KUNLUN"
!define RETIRED_ENV_B "CODE"

LangString LegacyInstallTitle 1033 "Older KCoder installation detected"
LangString LegacyInstallTitle 2052 "检测到旧版 KCoder"
LangString LegacyInstallText 1033 "An older installation was found in:$\r$\n$LegacyInstallDir$\r$\n$\r$\nAfter ${VERSION} is installed successfully, the old program files, PATH entries, and environment variables pointing to this old installation will be removed. User-profile configuration and credentials are not touched.$\r$\n$\r$\nChoose Yes to continue, or No to cancel."
LangString LegacyInstallText 2052 "检测到旧版安装：$\r$\n$LegacyInstallDir$\r$\n$\r$\n${VERSION} 安装成功后才清理旧程序文件、PATH 条目，以及指向旧安装目录的环境变量。不会处理用户配置和凭据。$\r$\n$\r$\n选择“是”继续，选择“否”取消安装。"

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "KCoder requires Windows 10 or later."
    Abort
  ${EndIf}
  Call DetectLegacyInstallation
  ${If} $LegacyInstallDir != ""
    IfSilent legacy_cleanup_confirmed legacy_cleanup_prompt
legacy_cleanup_prompt:
    MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2 "$(LegacyInstallTitle)$\r$\n$\r$\n$(LegacyInstallText)" IDYES legacy_cleanup_confirmed
    Abort
legacy_cleanup_confirmed:
  ${EndIf}
FunctionEnd

Function TryLegacyInstallDir
  ${If} $LegacyInstallDir == ""
    ${If} $0 != ""
      ; Migrate Program Files and old LocalAppData installations without touching the current KCoder directory or user configuration.
      StrCmpS "$0" "$LOCALAPPDATA\Programs\${RETIRED_NAME_COMPACT}" legacy_try_candidate
      StrCmpS "$0" "$LOCALAPPDATA\Programs\${RETIRED_NAME_SPACED}" legacy_try_candidate
      StrLen $1 "$PROGRAMFILES"
      StrCpy $2 "$0" $1
      StrCmpS "$2" "$PROGRAMFILES" 0 legacy_try_programfiles64
      Goto legacy_try_root_match
legacy_try_programfiles64:
      StrLen $1 "$PROGRAMFILES64"
      StrCpy $2 "$0" $1
      StrCmpS "$2" "$PROGRAMFILES64" 0 legacy_try_done
legacy_try_root_match:
      StrCpy $3 "$0" 1 $1
      StrCmp "$3" "\" legacy_try_candidate 0
      StrCmp "$3" "/" legacy_try_candidate legacy_try_done
legacy_try_candidate:
      ${If} ${FileExists} "$0\kcoder.exe"
        StrCpy $LegacyInstallDir "$0"
      ${ElseIf} ${FileExists} "$0\${RETIRED_FILE_COMPACT}.exe"
        StrCpy $LegacyInstallDir "$0"
      ${ElseIf} ${FileExists} "$0\${RETIRED_FILE_A}.exe"
        StrCpy $LegacyInstallDir "$0"
      ${ElseIf} ${FileExists} "$0\${RETIRED_FILE_DASHED}.exe"
        StrCpy $LegacyInstallDir "$0"
      ${EndIf}
    ${EndIf}
  ${EndIf}
legacy_try_done:
FunctionEnd

Function DetectLegacyInstallation
  StrCpy $LegacyInstallDir ""
  SetRegView 64
  ReadRegStr $0 HKCU "Software\KCoder" "InstallDir"
  Call TryLegacyInstallDir
  ReadRegStr $0 HKLM "Software\KCoder" "InstallDir"
  Call TryLegacyInstallDir
  ReadRegStr $0 HKLM "Software\WOW6432Node\KCoder" "InstallDir"
  Call TryLegacyInstallDir
  ReadRegStr $0 HKCU "Software\${RETIRED_NAME_COMPACT}" "InstallDir"
  Call TryLegacyInstallDir
  ReadRegStr $0 HKLM "Software\${RETIRED_NAME_COMPACT}" "InstallDir"
  Call TryLegacyInstallDir
  ReadRegStr $0 HKLM "Software\WOW6432Node\${RETIRED_NAME_COMPACT}" "InstallDir"
  Call TryLegacyInstallDir
  StrCpy $0 "$PROGRAMFILES\KCoder"
  Call TryLegacyInstallDir
  StrCpy $0 "$PROGRAMFILES64\KCoder"
  Call TryLegacyInstallDir
  StrCpy $0 "$PROGRAMFILES\${RETIRED_NAME_COMPACT}"
  Call TryLegacyInstallDir
  StrCpy $0 "$PROGRAMFILES\${RETIRED_NAME_SPACED}"
  Call TryLegacyInstallDir
  StrCpy $0 "$PROGRAMFILES64\${RETIRED_NAME_COMPACT}"
  Call TryLegacyInstallDir
  StrCpy $0 "$PROGRAMFILES64\${RETIRED_NAME_SPACED}"
  Call TryLegacyInstallDir
  StrCpy $0 "$LOCALAPPDATA\Programs\${RETIRED_NAME_COMPACT}"
  Call TryLegacyInstallDir
  StrCpy $0 "$LOCALAPPDATA\Programs\${RETIRED_NAME_SPACED}"
  Call TryLegacyInstallDir
FunctionEnd

Function IsLegacyPathValue
  Exch $6
  StrCpy $1 "0"
  StrCmpS "$6" "$LegacyInstallDir" legacy_path_match
  StrLen $2 "$LegacyInstallDir"
  StrCpy $3 "$6" $2
  StrCmpS "$3" "$LegacyInstallDir" 0 legacy_path_done
  StrCpy $4 "$6" 1 $2
  StrCmp "$4" "\" legacy_path_match
  StrCmp "$4" "/" legacy_path_match legacy_path_done
legacy_path_match:
  StrCpy $1 "1"
legacy_path_done:
  Pop $7
  Push $1
FunctionEnd

Function RemoveLegacyEnvironmentVariable
  Exch $5
  ReadRegStr $0 HKCU "Environment" "$5"
  ${If} $0 != ""
    Push $0
    Call IsLegacyPathValue
    Pop $1
    ${If} $1 == "1"
      DeleteRegValue HKCU "Environment" "$5"
    ${EndIf}
  ${EndIf}
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "$5"
  ${If} $0 != ""
    Push $0
    Call IsLegacyPathValue
    Pop $1
    ${If} $1 == "1"
      DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "$5"
    ${EndIf}
  ${EndIf}
  Pop $5
FunctionEnd

Function RemoveLegacyUserPathEntry
  Exch $5
  ReadRegStr $0 HKCU "Environment" "Path"
  StrLen $4 $0
  ${If} $4 > 1021
    DetailPrint "User PATH is too long for safe legacy cleanup; leaving it unchanged."
    Pop $5
    Return
  ${EndIf}
  StrLen $4 $5
  ${If} $4 > 1021
    DetailPrint "User PATH is too long for safe legacy cleanup; leaving it unchanged."
    Pop $5
    Return
  ${EndIf}
  StrCpy $1 ";$0;"
  StrCpy $2 ";$5;"
  ${StrRep} $3 "$1" "$2" ";"
  StrCpy $4 $3 1
  ${If} $4 == ";"
    StrCpy $3 $3 "" 1
  ${EndIf}
  StrLen $4 $3
  ${If} $4 > 0
    IntOp $4 $4 - 1
    StrCpy $2 $3 1 $4
    ${If} $2 == ";"
      StrCpy $3 $3 $4
    ${EndIf}
  ${EndIf}
  WriteRegExpandStr HKCU "Environment" "Path" "$3"
  Pop $5
FunctionEnd

Function RemoveLegacyMachinePathEntry
  Exch $5
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  StrLen $4 $0
  ${If} $4 > 1021
    DetailPrint "Machine PATH is too long for safe legacy cleanup; leaving it unchanged."
    Pop $5
    Return
  ${EndIf}
  StrLen $4 $5
  ${If} $4 > 1021
    DetailPrint "Machine PATH is too long for safe legacy cleanup; leaving it unchanged."
    Pop $5
    Return
  ${EndIf}
  StrCpy $1 ";$0;"
  StrCpy $2 ";$5;"
  ${StrRep} $3 "$1" "$2" ";"
  StrCpy $4 $3 1
  ${If} $4 == ";"
    StrCpy $3 $3 "" 1
  ${EndIf}
  StrLen $4 $3
  ${If} $4 > 0
    IntOp $4 $4 - 1
    StrCpy $2 $3 1 $4
    ${If} $2 == ";"
      StrCpy $3 $3 $4
    ${EndIf}
  ${EndIf}
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$3"
  Pop $5
FunctionEnd

Function RemoveLegacyRegistryMetadata
  SetRegView 64
  ReadRegStr $0 HKCU "Software\KCoder" "InstallDir"
  StrCmpS "$0" "$LegacyInstallDir" 0 +2
  DeleteRegKey HKCU "Software\KCoder"
  ReadRegStr $0 HKLM "Software\KCoder" "InstallDir"
  StrCmpS "$0" "$LegacyInstallDir" 0 +2
  DeleteRegKey HKLM "Software\KCoder"
  ReadRegStr $0 HKLM "Software\WOW6432Node\KCoder" "InstallDir"
  StrCmpS "$0" "$LegacyInstallDir" 0 +2
  DeleteRegKey HKLM "Software\WOW6432Node\KCoder"
  ReadRegStr $0 HKCU "Software\${RETIRED_NAME_COMPACT}" "InstallDir"
  StrCmpS "$0" "$LegacyInstallDir" 0 +2
  DeleteRegKey HKCU "Software\${RETIRED_NAME_COMPACT}"
  ReadRegStr $0 HKLM "Software\${RETIRED_NAME_COMPACT}" "InstallDir"
  StrCmpS "$0" "$LegacyInstallDir" 0 +2
  DeleteRegKey HKLM "Software\${RETIRED_NAME_COMPACT}"
  ReadRegStr $0 HKLM "Software\WOW6432Node\${RETIRED_NAME_COMPACT}" "InstallDir"
  StrCmpS "$0" "$LegacyInstallDir" 0 +2
  DeleteRegKey HKLM "Software\WOW6432Node\${RETIRED_NAME_COMPACT}"
FunctionEnd

!macro DeleteLegacyProgramFile FileName
  IfFileExists "$LegacyInstallDir\${FileName}" 0 +5
  ClearErrors
  Delete "$LegacyInstallDir\${FileName}"
  IfErrors 0 +2
  StrCpy $LegacyCleanupIncomplete 1
!macroend

Function CleanupLegacyInstallation
  StrCpy $LegacyCleanupIncomplete 0
  ; A same-directory upgrade must retain the newly installed program, PATH entry, and registration data.
  StrCmp "$LegacyInstallDir" "" legacy_cleanup_done
  GetFullPathName $0 "$LegacyInstallDir"
  GetFullPathName $1 "$INSTDIR"
  StrCmp "$0" "$1" legacy_cleanup_done
  Push "$LegacyInstallDir"
  Call RemoveLegacyUserPathEntry
  Push "$LegacyInstallDir\bin"
  Call RemoveLegacyUserPathEntry
  Push "$LegacyInstallDir"
  Call RemoveLegacyMachinePathEntry
  Push "$LegacyInstallDir\bin"
  Call RemoveLegacyMachinePathEntry

  Push "KCODER_HOME"
  Call RemoveLegacyEnvironmentVariable
  Push "KCODER_CONFIG_DIR"
  Call RemoveLegacyEnvironmentVariable
  Push "KCODER_INSTALL_DIR"
  Call RemoveLegacyEnvironmentVariable
  Push "KCODER_BIN"
  Call RemoveLegacyEnvironmentVariable
  Push "KCODER_REAL_BIN"
  Call RemoveLegacyEnvironmentVariable
  Push "KCODER_STUDIO_KCODER_BIN"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}_HOME"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}_${RETIRED_ENV_B}_CONFIG_DIR"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}_${RETIRED_ENV_B}_INSTALL_DIR"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}${RETIRED_ENV_B}_HOME"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}${RETIRED_ENV_B}_INSTALL_DIR"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}_${RETIRED_ENV_B}_BIN"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}${RETIRED_ENV_B}_BIN"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}_${RETIRED_ENV_B}_REAL_BIN"
  Call RemoveLegacyEnvironmentVariable
  Push "${RETIRED_ENV_A}_STUDIO_${RETIRED_ENV_A}_BIN"
  Call RemoveLegacyEnvironmentVariable

  !insertmacro DeleteLegacyProgramFile "kcoder.exe"
  !insertmacro DeleteLegacyProgramFile "kcoder-process-supervisor.exe"
  !insertmacro DeleteLegacyProgramFile "${RETIRED_FILE_COMPACT}.exe"
  !insertmacro DeleteLegacyProgramFile "${RETIRED_FILE_A}.exe"
  !insertmacro DeleteLegacyProgramFile "${RETIRED_FILE_DASHED}.exe"
  !insertmacro DeleteLegacyProgramFile "${RETIRED_FILE_A}-process-supervisor.exe"
  !insertmacro DeleteLegacyProgramFile "uninstall.exe"
  !insertmacro DeleteLegacyProgramFile "lib\kcoder\rg.exe"
  !insertmacro DeleteLegacyProgramFile "lib\${RETIRED_FILE_DASHED}\rg.exe"
  RMDir "$LegacyInstallDir\lib\kcoder"
  RMDir "$LegacyInstallDir\lib\${RETIRED_FILE_DASHED}"
  RMDir "$LegacyInstallDir\lib"
  RMDir "$LegacyInstallDir"
  SetShellVarContext current
  Delete "$SMPROGRAMS\${RETIRED_NAME_SPACED}\${RETIRED_NAME_SPACED}.lnk"
  RMDir "$SMPROGRAMS\${RETIRED_NAME_SPACED}"
  Call RemoveLegacyRegistryMetadata
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
legacy_cleanup_done:
FunctionEnd

Function AddInstallDirToUserPath
  ReadRegStr $0 HKCU "Environment" "Path"
  ; A missing PATH or absent match is normal and must not be reported as a write failure.
  ClearErrors
  StrLen $4 $0
  ${If} $4 > 1021
    DetailPrint "User PATH is too long for a safe automatic update; leaving it unchanged."
    MessageBox MB_ICONEXCLAMATION|MB_OK "KCoder was installed, but your user PATH is too long to update safely. Add $INSTDIR to PATH manually."
    Return
  ${EndIf}
  StrLen $5 $INSTDIR
  ${If} $5 > 1021
    DetailPrint "User PATH is too long for a safe automatic update; leaving it unchanged."
    MessageBox MB_ICONEXCLAMATION|MB_OK "KCoder was installed, but your user PATH is too long to update safely. Add $INSTDIR to PATH manually."
    Return
  ${EndIf}
  StrCpy $1 ";$0;"
  StrCpy $2 ";$INSTDIR;"
  ${StrStrAdv} $3 "$1" "$2" ">" ">" "0" "1" "0"
  ClearErrors
  ${If} $3 == ""
    IntOp $6 $4 + $5
    ${If} $4 > 0
      IntOp $6 $6 + 1
    ${EndIf}
    ${If} $6 > 1023
      DetailPrint "Adding KCoder would exceed the safe user PATH length; leaving it unchanged."
      MessageBox MB_ICONEXCLAMATION|MB_OK "KCoder was installed, but adding it would make your user PATH too long. Add $INSTDIR to PATH manually."
      Return
    ${EndIf}
    ${If} $0 == ""
      StrCpy $0 "$INSTDIR"
    ${Else}
      StrCpy $0 "$0;$INSTDIR"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
  ${EndIf}
FunctionEnd

Function un.RemoveInstallDirFromUserPath
  ReadRegStr $0 HKCU "Environment" "Path"
  StrLen $4 $0
  ${If} $4 > 1021
    DetailPrint "User PATH is too long for a safe automatic update; leaving it unchanged."
    Return
  ${EndIf}
  StrLen $4 $INSTDIR
  ${If} $4 > 1021
    DetailPrint "User PATH is too long for a safe automatic update; leaving it unchanged."
    Return
  ${EndIf}
  StrCpy $1 ";$0;"
  ${UnStrRep} $2 "$1" ";$INSTDIR;" ";"
  StrCpy $3 $2 1
  ${If} $3 == ";"
    StrCpy $2 $2 "" 1
  ${EndIf}
  StrLen $4 $2
  ${If} $4 > 0
    IntOp $4 $4 - 1
    StrCpy $3 $2 1 $4
    ${If} $3 == ";"
      StrCpy $2 $2 $4
    ${EndIf}
  ${EndIf}
  WriteRegExpandStr HKCU "Environment" "Path" "$2"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
FunctionEnd

Section "KCoder" SEC_MAIN
  StrCpy $MainBackedUp 0
  StrCpy $HelperBackedUp 0
  StrCpy $MainCommitted 0
  StrCpy $HelperCommitted 0
  StrCpy $RollbackFailed 0
  StrCpy $ChromeBackedUp 0
  StrCpy $ChromeCommitted 0
  StrCpy $TransactionDir ""
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors install_rollback
  GetTempFileName $TransactionDir "$INSTDIR"
  IfErrors install_rollback
  Delete "$TransactionDir"
  CreateDirectory "$TransactionDir"
  IfErrors install_rollback
  CreateDirectory "$TransactionDir\backup"
  IfErrors install_rollback
  ; Do not change the old installation before CRC validation and complete extraction. The transaction directory shares the target filesystem.
  SetOutPath "$TransactionDir"
  File /oname=kcoder.exe "${CLI_BINARY}"
  IfErrors install_rollback
  File /oname=kcoder-process-supervisor.exe "${SUPERVISOR_BINARY}"
  IfErrors install_rollback
  !if "${RIPGREP_BINARY}" != ""
    File /oname=rg.exe "${RIPGREP_BINARY}"
    IfErrors install_rollback
  !endif
  !if "${CHROME_DIRECTORY}" != ""
    SetOutPath "$TransactionDir\chrome"
    File /r "${CHROME_DIRECTORY}\*"
    IfErrors install_rollback
    SetOutPath "$TransactionDir"
  !endif

  IfFileExists "$INSTDIR\kcoder.exe\*.*" install_rollback
  IfFileExists "$INSTDIR\kcoder-process-supervisor.exe\*.*" install_rollback
  IfFileExists "$INSTDIR\kcoder.exe" 0 backup_helper
  ClearErrors
  Rename "$INSTDIR\kcoder.exe" "$TransactionDir\backup\kcoder.exe"
  IfErrors install_rollback
  StrCpy $MainBackedUp 1
backup_helper:
  IfFileExists "$INSTDIR\kcoder-process-supervisor.exe" 0 commit_main
  ClearErrors
  Rename "$INSTDIR\kcoder-process-supervisor.exe" "$TransactionDir\backup\kcoder-process-supervisor.exe"
  IfErrors install_rollback
  StrCpy $HelperBackedUp 1
commit_main:
  ClearErrors
  Rename "$TransactionDir\kcoder.exe" "$INSTDIR\kcoder.exe"
  IfErrors install_rollback
  StrCpy $MainCommitted 1
  ; Only test builds inject failure while committing the second file; production installers omit this branch.
  !ifdef KCODER_INSTALL_TEST_FAIL_AFTER_MAIN
    Goto install_rollback
  !endif
  Rename "$TransactionDir\kcoder-process-supervisor.exe" "$INSTDIR\kcoder-process-supervisor.exe"
  IfErrors install_rollback
  StrCpy $HelperCommitted 1

  !if "${CHROME_DIRECTORY}" != ""
    ; Commit the complete browser tree, including notices, only after extraction succeeds.
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\chrome") i .r0'
    IntCmp $0 -1 commit_chrome
    IntOp $1 $0 & 0x410
    ; Compare numeric attributes; string operators distinguish decimal 16 from hex 0x10.
    ${If} $1 <> 0x10
      Goto install_rollback
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\chrome\.kcoder-chrome.json") i .r0'
    IntOp $1 $0 & 0x410
    ${If} $1 <> 0
      Goto install_rollback
    ${EndIf}
    ClearErrors
    Rename "$INSTDIR\chrome" "$TransactionDir\backup\chrome"
    IfErrors install_rollback
    StrCpy $ChromeBackedUp 1
commit_chrome:
    ClearErrors
    Rename "$TransactionDir\chrome" "$INSTDIR\chrome"
    IfErrors install_rollback
    StrCpy $ChromeCommitted 1
  !endif

  ; The paired programs are committed. Report later resource or registration failures separately without claiming machine-wide transaction atomicity.
  ClearErrors
  !if "${RIPGREP_BINARY}" != ""
    CreateDirectory "$INSTDIR\lib\kcoder"
    CopyFiles /SILENT "$TransactionDir\rg.exe" "$INSTDIR\lib\kcoder\rg.exe"
    IfErrors install_metadata_failed
  !endif
  SetOutPath "$INSTDIR"
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\KCoder"
  CreateShortCut "$SMPROGRAMS\KCoder\KCoder.lnk" "$INSTDIR\kcoder.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\KCoder" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\KCoder" "Version" "${VERSION}"
  IfErrors install_metadata_failed
  ClearErrors
  Call AddInstallDirToUserPath
  IfErrors install_metadata_failed
  ClearErrors
  Call CleanupLegacyInstallation
  StrCmp $LegacyCleanupIncomplete 1 install_metadata_failed
  Delete "$INSTDIR\${RETIRED_FILE_COMPACT}.exe"
  Delete "$INSTDIR\${RETIRED_FILE_A}.exe"
  Delete "$INSTDIR\${RETIRED_FILE_DASHED}.exe"
  Delete "$INSTDIR\${RETIRED_FILE_A}-process-supervisor.exe"
  RMDir /r "$TransactionDir"
  Goto install_done

install_rollback:
  ; Remove only files committed by this run and retain the exact backup location after recovery failure.
  SetOutPath "$INSTDIR"
  ${If} $ChromeCommitted == 1
    ClearErrors
    RMDir /r "$INSTDIR\chrome"
    IfErrors 0 +2
    StrCpy $RollbackFailed 1
  ${EndIf}
  ${If} $ChromeBackedUp == 1
    ClearErrors
    Rename "$TransactionDir\backup\chrome" "$INSTDIR\chrome"
    IfErrors 0 +2
    StrCpy $RollbackFailed 1
  ${EndIf}
  ${If} $MainCommitted == 1
    ClearErrors
    Delete "$INSTDIR\kcoder.exe"
    IfErrors 0 +2
    StrCpy $RollbackFailed 1
  ${EndIf}
  ${If} $HelperCommitted == 1
    ClearErrors
    Delete "$INSTDIR\kcoder-process-supervisor.exe"
    IfErrors 0 +2
    StrCpy $RollbackFailed 1
  ${EndIf}
  !ifdef KCODER_INSTALL_TEST_FAIL_RECOVERY
    CreateDirectory "$INSTDIR\kcoder.exe"
  !endif
  ${If} $MainBackedUp == 1
    ClearErrors
    Rename "$TransactionDir\backup\kcoder.exe" "$INSTDIR\kcoder.exe"
    IfErrors 0 +2
    StrCpy $RollbackFailed 1
  ${EndIf}
  ${If} $HelperBackedUp == 1
    ClearErrors
    Rename "$TransactionDir\backup\kcoder-process-supervisor.exe" "$INSTDIR\kcoder-process-supervisor.exe"
    IfErrors 0 +2
    StrCpy $RollbackFailed 1
  ${EndIf}
  ${If} $RollbackFailed == 1
    DetailPrint "Installation failed; automatic recovery was incomplete. Recovery directory retained at $TransactionDir\backup"
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "Installation failed. Recovery was incomplete; keep $TransactionDir\backup for manual recovery."
  ${Else}
    ${If} $TransactionDir != ""
      RMDir /r "$TransactionDir"
    ${EndIf}
    DetailPrint "Installation failed; previous program files were restored."
  ${EndIf}
  SetErrorLevel 1
  Abort

install_metadata_failed:
  DetailPrint "Program files were updated, but setup registration or legacy cleanup failed. Previous files, if any, remain in $TransactionDir\backup"
  IfSilent +2
  MessageBox MB_ICONSTOP|MB_OK "Program files were updated, but setup did not finish. Previous files, if any, remain in $TransactionDir\backup."
  SetErrorLevel 1
  Abort
install_done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.RemoveInstallDirFromUserPath
  Delete "$SMPROGRAMS\KCoder\KCoder.lnk"
  RMDir "$SMPROGRAMS\KCoder"
  Delete "$INSTDIR\kcoder.exe"
  Delete "$INSTDIR\kcoder-process-supervisor.exe"
  Delete "$INSTDIR\${RETIRED_FILE_COMPACT}.exe"
  Delete "$INSTDIR\${RETIRED_FILE_A}-process-supervisor.exe"
  Delete "$INSTDIR\lib\kcoder\rg.exe"
  Delete "$INSTDIR\lib\${RETIRED_FILE_DASHED}\rg.exe"
  !if "${CHROME_DIRECTORY}" != ""
    ; Preserve unrelated directories and junction targets even during uninstall.
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\chrome") i .r0'
    IntOp $1 $0 & 0x410
    ${If} $1 = 0x10
      System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\chrome\.kcoder-chrome.json") i .r0'
      IntOp $1 $0 & 0x410
      ${If} $1 = 0
        RMDir /r "$INSTDIR\chrome"
      ${EndIf}
    ${EndIf}
  !endif
  RMDir "$INSTDIR\lib\kcoder"
  RMDir "$INSTDIR\lib\${RETIRED_FILE_DASHED}"
  RMDir "$INSTDIR\lib"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\KCoder"
SectionEnd
