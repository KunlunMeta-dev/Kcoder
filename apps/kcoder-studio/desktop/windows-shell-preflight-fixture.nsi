Unicode true
RequestExecutionLevel user
Name "Owned KCoder process preflight syntax fixture"
OutFile "${FIXTURE_OUT}"
!include "LogicLib.nsh"
!define APP_GUID "dde41fb5-2370-5338-807d-3f5c37c73fa3"
!define APP_EXECUTABLE_FILENAME "kcoder-studio.exe"
LangString appCannotBeClosed 1033 "Close the owned application first"
Var installMode
!include "windows-shell-installer.nsh"
!include "include\allowOnlyOneInstallerInstance.nsh"
Function .onInit
  StrCpy $installMode "CurrentUser"
  !insertmacro CHECK_APP_RUNNING
FunctionEnd
Section
SectionEnd
