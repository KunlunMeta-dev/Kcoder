// Keep Electron's OS profile intact while isolating the owned Native source home.
#include <windows.h>
#include <process.h>
#include <stdlib.h>
#include <wchar.h>

int wmain(int argc, wchar_t **argv) {
  const wchar_t *root = _wgetenv(L"KCODER_E2E_MIGRATION_AMBIENT");
  if (!root || !*root || wcslen(root) > 30000) return 92;
  wchar_t executable[32768], roaming[32768], local[32768];
  DWORD length = GetModuleFileNameW(NULL, executable, 32768);
  if (!length || length >= 32768) return 93;
  wchar_t *leaf = wcsrchr(executable, L'\\');
  if (!leaf) return 94;
  wcscpy(leaf + 1, L"kcoder.exe");
  _snwprintf(roaming, 32768, L"%ls\\AppData\\Roaming", root);
  _snwprintf(local, 32768, L"%ls\\AppData\\Local", root);
  if (_wputenv_s(L"USERPROFILE", root) || _wputenv_s(L"HOME", root)
      || _wputenv_s(L"APPDATA", roaming) || _wputenv_s(L"LOCALAPPDATA", local)) return 95;
  wchar_t **args = calloc((size_t)argc + 1, sizeof(wchar_t *));
  if (!args) return 96;
  args[0] = executable;
  for (int i = 1; i < argc; ++i) args[i] = argv[i];
  intptr_t result = _wspawnv(_P_WAIT, executable, (const wchar_t *const *)args);
  free(args);
  return result < 0 ? 97 : (int)result;
}
