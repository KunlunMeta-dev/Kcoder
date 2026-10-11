#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

/* Test-only controller that operates only on the installer window it started and never enumerates or terminates other processes. */
static DWORD installer_pid;
static int confirmed, cancelled;
static wchar_t dialog_text[16384];

static BOOL CALLBACK collect_text(HWND window, LPARAM unused) {
    (void)unused;
    wchar_t text[2048];
    GetWindowTextW(window, text, 2048);
    if (wcslen(dialog_text) + wcslen(text) + 2 < 16384) {
        wcscat(dialog_text, text);
        wcscat(dialog_text, L"\n");
    }
    return TRUE;
}

static BOOL CALLBACK cancel_window(HWND window, LPARAM unused) {
    (void)unused;
    DWORD pid;
    GetWindowThreadProcessId(window, &pid);
    if (pid != installer_pid || !IsWindowVisible(window)) return TRUE;
    dialog_text[0] = 0;
    collect_text(window, 0);
    EnumChildWindows(window, collect_text, 0);
    if (wcsstr(dialog_text, L"older installation was found")) {
        confirmed = 1;
        PostMessageW(window, WM_COMMAND, IDYES, 0);
    } else if (wcsstr(dialog_text, L"Are you sure") || wcsstr(dialog_text, L"quit KCoder")) {
        PostMessageW(window, WM_COMMAND, IDYES, 0);
    } else if (confirmed && wcsstr(dialog_text, L"Welcome to KCoder")) {
        cancelled = 1;
        PostMessageW(window, WM_COMMAND, IDCANCEL, 0);
    }
    return TRUE;
}

int wmain(int argc, wchar_t **argv) {
    if (argc == 5 && wcscmp(argv[1], L"lock") == 0) {
        HANDLE file = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
        if (file == INVALID_HANDLE_VALUE) return 5;
        HANDLE ready = CreateFileW(argv[3], GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
        if (ready == INVALID_HANDLE_VALUE) { CloseHandle(file); return 6; }
        CloseHandle(ready);
        ULONGLONG end = GetTickCount64() + 30000;
        while (GetFileAttributesW(argv[4]) == INVALID_FILE_ATTRIBUTES && GetTickCount64() < end) Sleep(20);
        CloseHandle(file);
        return 0;
    }
    if (argc == 4 && wcscmp(argv[1], L"cancel") == 0) {
        wchar_t command[8192];
        swprintf(command, 8192, L"\"%ls\" /D=%ls", argv[2], argv[3]);
        STARTUPINFOW startup = { .cb = sizeof(startup) };
        PROCESS_INFORMATION process;
        if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &process)) return 2;
        installer_pid = process.dwProcessId;
        ULONGLONG end = GetTickCount64() + 20000;
        while (WaitForSingleObject(process.hProcess, 50) == WAIT_TIMEOUT && GetTickCount64() < end) {
            EnumWindows(cancel_window, 0);
        }
        if (WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
            TerminateProcess(process.hProcess, 9);
            WaitForSingleObject(process.hProcess, 5000);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return 3;
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return confirmed && cancelled ? 0 : 4;
    }
    puts("kcoder nsis fixture");
    return 0;
}
