// Test-only fixed executable launcher. The enclosing RunContext Job owns every child.
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <stdint.h>
#include <io.h>

#define CAP 32768
#define MAX_ANCESTORS 20
typedef struct {
  DWORD pid, parent;
  ULONGLONG birth;
  BOOL in_job;
  wchar_t image[CAP];
} Identity;
typedef struct {
  wchar_t mode[32], owner[64], root[CAP], receipts[CAP], executable[CAP];
  wchar_t executable_sha[65], script[CAP], script_sha[65], git[CAP], git_sha[65];
  wchar_t electron[CAP], electron_sha[65];
} Configuration;
static HANDLE pending_child = NULL;

static void fail(const char *message) {
  fprintf(stderr, "owned task-delivery launcher: %s (win32=%lu)\n", message, GetLastError());
  if (pending_child) { TerminateProcess(pending_child, 91); WaitForSingleObject(pending_child, 4000); CloseHandle(pending_child); }
  exit(91);
}
static void key(const wchar_t *ini, const wchar_t *name, wchar_t *out, DWORD cap) {
  wchar_t *buffer = calloc(CAP, sizeof(wchar_t));
  if (!buffer) fail("configuration allocation failed");
  DWORD size = GetPrivateProfileStringW(L"fixture", name, NULL, buffer, CAP, ini);
  if (!size || size >= CAP - 1 || size >= cap) fail("missing or oversized fixture configuration");
  wcscpy(out, buffer); free(buffer);
  for (DWORD i = 0; i < size; ++i) if (out[i] < 32) fail("configuration contains control characters");
}
static HANDLE regular_file(const wchar_t *path) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION info;
  if (file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file, &info)) fail("cannot open fixed regular file");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nNumberOfLinks != 1)
    fail("fixed input must be a single-link regular file");
  return file;
}
static void canonical(const wchar_t *path, wchar_t *out, BOOL directory) {
  HANDLE file = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION info;
  if (file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file, &info)) fail("cannot identify owned path");
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      (!!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != !!directory)) fail("unexpected owned path type");
  DWORD size = GetFinalPathNameByHandleW(file, out, CAP, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(file);
  if (!size || size >= CAP) fail("canonical path is too long");
}
static int same_path(const wchar_t *left, const wchar_t *right) {
  return CompareStringOrdinal(left, -1, right, -1, TRUE) == CSTR_EQUAL;
}
static int under(const wchar_t *root, const wchar_t *path) {
  size_t size = wcslen(root);
  return wcslen(path) > size && path[size] == L'\\' &&
    CompareStringOrdinal(root, (int)size, path, (int)size, TRUE) == CSTR_EQUAL;
}
static void sha256(const wchar_t *path, wchar_t *hex) {
  HANDLE file = regular_file(path);
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  DWORD size = 0, written = 0, read = 0;
  unsigned char digest[32], buffer[65536];
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&size, sizeof(size), &written, 0) < 0) fail("SHA256 setup failed");
  unsigned char *object = calloc(size, 1);
  if (!object || BCryptCreateHash(algorithm, &hash, object, size, NULL, 0, 0) < 0) fail("SHA256 allocation failed");
  for (;;) {
    if (!ReadFile(file, buffer, sizeof(buffer), &read, NULL)) fail("fixed input read failed");
    if (!read) break;
    if (BCryptHashData(hash, buffer, read, 0) < 0) fail("SHA256 input failed");
  }
  if (BCryptFinishHash(hash, digest, sizeof(digest), 0) < 0) fail("SHA256 finish failed");
  for (int i = 0; i < 32; ++i) swprintf(hex + i * 2, 3, L"%02x", digest[i]);
  BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); free(object); CloseHandle(file);
}
static void expected_hash(const wchar_t *path, const wchar_t *expected) {
  wchar_t actual[65]; sha256(path, actual);
  if (wcslen(expected) != 64 || wcscmp(actual, expected)) fail("fixed executable or source digest changed");
}
static DWORD parent_pid(DWORD pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) fail("process ownership snapshot unavailable");
  PROCESSENTRY32W entry = {0}; entry.dwSize = sizeof(entry);
  DWORD parent = 0;
  if (Process32FirstW(snapshot, &entry)) do {
    // Inspect only the exact PID. Never select a process by its executable name.
    if (entry.th32ProcessID == pid) { parent = entry.th32ParentProcessID; break; }
  } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot); return parent;
}
static Identity identity(DWORD pid) {
  Identity result = {0}; result.pid = pid;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  FILETIME birth, end, kernel, user;
  DWORD size = CAP, code = 0;
  if (!process || !GetProcessTimes(process, &birth, &end, &kernel, &user) ||
      !GetExitCodeProcess(process, &code) || code != STILL_ACTIVE ||
      !QueryFullProcessImageNameW(process, 0, result.image, &size) ||
      !IsProcessInJob(process, NULL, &result.in_job)) fail("live process identity unavailable");
  result.birth = ((ULONGLONG)birth.dwHighDateTime << 32) | birth.dwLowDateTime;
  result.parent = parent_pid(pid);
  CloseHandle(process);
  wchar_t resolved[CAP]; canonical(result.image, resolved, FALSE); wcscpy(result.image, resolved);
  return result;
}
static Identity *ancestry(const Configuration *config, DWORD pid, size_t *count) {
  Identity *rows = calloc(MAX_ANCESTORS, sizeof(Identity));
  if (!rows) fail("ancestry allocation failed");
  *count = 0;
  while (*count < MAX_ANCESTORS) {
    Identity row = identity(pid);
    if (!row.in_job) fail("process escaped its enclosing owned Job");
    if (*count && row.birth > rows[*count - 1].birth) fail("ancestor PID was reused");
    rows[(*count)++] = row;
    if (same_path(row.image, config->electron)) {
      // Electron may fork another electron.exe as its Node Gateway. Bind the main
      // ancestor, not the first matching image in that contiguous owner chain.
      Identity parent = identity(row.parent);
      if (!same_path(parent.image, config->electron)) {
        expected_hash(row.image, config->electron_sha);
        return rows;
      }
    }
    if (!row.parent || row.parent == row.pid) break;
    pid = row.parent;
  }
  fail("process is not descended from the fixed Electron host"); return NULL;
}
static void json_string(FILE *file, const wchar_t *value) {
  // ASCII JSON escapes preserve every UTF-16 code unit, including non-ASCII paths.
  fputc('"', file);
  for (; *value; ++value) {
    if (*value == L'"' || *value == L'\\') { fputc('\\', file); fputc((char)*value, file); }
    else if (*value >= 32 && *value < 127) fputc((char)*value, file);
    else fprintf(file, "\\u%04x", (unsigned short)*value);
  }
  fputc('"', file);
}
static void json_identity(FILE *file, const Identity *row) {
  fprintf(file, "{\"pid\":%lu,\"parentPid\":%lu,\"creationTicks\":\"%llu\",\"inJob\":%s,\"imagePath\":",
    row->pid, row->parent, row->birth, row->in_job ? "true" : "false");
  json_string(file, row->image); fputc('}', file);
}
static void json_ancestors(FILE *file, const Identity *rows, size_t count) {
  fputc('[', file);
  for (size_t i = 0; i < count; ++i) { if (i) fputc(',', file); json_identity(file, &rows[i]); }
  fputc(']', file);
}
static void receipt(const Configuration *config, const Identity *child, const wchar_t *cwd,
                    const Identity *rows, size_t count) {
  wchar_t filename[CAP], hash[65]; expected_hash(child->image, config->executable_sha);
  sha256(child->image, hash);
  if (swprintf(filename, CAP, L"%ls\\%lu-%llu.json", config->receipts, child->pid, child->birth) < 0) fail("receipt path too long");
  HANDLE handle = CreateFileW(filename, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (handle == INVALID_HANDLE_VALUE) fail("receipt collision");
  // The child remains suspended until its immutable launch proof has been flushed.
  int descriptor = _open_osfhandle((intptr_t)handle, 0);
  FILE *file = descriptor < 0 ? NULL : _fdopen(descriptor, "w");
  if (!file) fail("cannot open receipt stream");
  fputs("{\"version\":1,\"mode\":\"native\",\"owner\":", file); json_string(file, config->owner);
  fputs(",\"child\":", file); json_identity(file, child);
  fputs(",\"sha256\":", file); json_string(file, hash);
  fputs(",\"cwd\":", file); json_string(file, cwd);
  fputs(",\"ancestors\":", file); json_ancestors(file, rows, count); fputs("}\n", file);
  if (fflush(file) || !FlushFileBuffers(handle) || fclose(file)) fail("cannot flush launch proof");
}
static void append(wchar_t *line, size_t *used, wchar_t value) {
  if (*used >= CAP - 1) fail("command line too long");
  line[(*used)++] = value; line[*used] = 0;
}
static void argument(wchar_t *line, size_t *used, const wchar_t *value) {
  // Windows argv quoting: double trailing backslashes and those preceding a quote.
  if (*used) append(line, used, L' ');
  append(line, used, L'"');
  while (*value) {
    size_t slashes = 0;
    while (*value == L'\\') { ++slashes; ++value; }
    for (size_t i = 0; i < slashes * ((!*value || *value == L'"') ? 2 : 1); ++i) append(line, used, L'\\');
    if (!*value) break;
    if (*value == L'"') append(line, used, L'\\');
    append(line, used, *value++);
  }
  append(line, used, L'"');
}
static void configuration(Configuration *config) {
  wchar_t ini[CAP], resolved[CAP];
  DWORD length = GetModuleFileNameW(NULL, ini, CAP);
  if (!length || length > CAP - 5) fail("launcher image unavailable");
  wcscat(ini, L".ini");
  HANDLE input = regular_file(ini); LARGE_INTEGER size;
  if (!GetFileSizeEx(input, &size) || size.QuadPart > 65536) fail("oversized launcher configuration");
  CloseHandle(input);
  key(ini, L"mode", config->mode, 32); key(ini, L"owner", config->owner, 64);
  if (wcslen(config->owner) != 36 || wcsspn(config->owner, L"0123456789abcdef-") != 36) fail("invalid run owner");
  key(ini, L"root", config->root, CAP); canonical(config->root, resolved, TRUE); wcscpy(config->root, resolved);
  key(ini, L"executable", config->executable, CAP); canonical(config->executable, resolved, FALSE); wcscpy(config->executable, resolved);
  key(ini, L"executableSha256", config->executable_sha, 65); expected_hash(config->executable, config->executable_sha);
  if (!wcscmp(config->mode, L"gh")) {
    key(ini, L"script", config->script, CAP); key(ini, L"scriptSha256", config->script_sha, 65);
    expected_hash(config->script, config->script_sha);
    key(ini, L"git", config->git, CAP); key(ini, L"gitSha256", config->git_sha, 65); expected_hash(config->git, config->git_sha);
  } else if (!wcscmp(config->mode, L"native")) {
    key(ini, L"receipts", config->receipts, CAP); canonical(config->receipts, resolved, TRUE); wcscpy(config->receipts, resolved);
    if (!under(config->root, config->receipts)) fail("receipt directory escaped run root");
    key(ini, L"electron", config->electron, CAP); canonical(config->electron, resolved, FALSE); wcscpy(config->electron, resolved);
    key(ini, L"electronSha256", config->electron_sha, 65);
  } else fail("unknown fixed launcher mode");
}
int wmain(int argc, wchar_t **argv) {
  Configuration *config = calloc(1, sizeof(Configuration));
  if (!config) fail("configuration allocation failed");
  configuration(config);
  if (!wcscmp(config->mode, L"native") && argc == 6 && !wcscmp(argv[1], L"--fixture-observe")) {
    wchar_t *end; unsigned long pid = wcstoul(argv[2], &end, 10); if (*end || !pid) fail("invalid observed PID");
    ULONGLONG birth = _wcstoui64(argv[3], &end, 10); if (*end || !birth) fail("invalid observed creation time");
    DWORD electron_pid = wcstoul(argv[4], &end, 10); if (*end || !electron_pid) fail("invalid Electron PID");
    ULONGLONG electron_birth = _wcstoui64(argv[5], &end, 10); if (*end || !electron_birth) fail("invalid Electron creation time");
    Identity child = identity((DWORD)pid); size_t count;
    if (child.birth != birth || !same_path(child.image, config->executable)) fail("observed Native identity changed");
    Identity *rows = ancestry(config, child.pid, &count);
    if (rows[count - 1].pid != electron_pid || rows[count - 1].birth != electron_birth) fail("observed process belongs to another Electron owner");
    wchar_t hash[65]; sha256(child.image, hash);
    if (wcscmp(hash, config->executable_sha)) fail("observed Native digest changed");
    fputs("{\"version\":1,\"owner\":", stdout); json_string(stdout, config->owner);
    fputs(",\"child\":", stdout); json_identity(stdout, &child);
    fputs(",\"sha256\":", stdout); json_string(stdout, hash);
    fputs(",\"ancestors\":", stdout); json_ancestors(stdout, rows, count); fputs("}\n", stdout);
    free(rows); free(config); return 0;
  }
  wchar_t *cwd = calloc(CAP, sizeof(wchar_t)), *line = calloc(CAP, sizeof(wchar_t));
  if (!cwd || !line || !GetCurrentDirectoryW(CAP, cwd)) fail("current directory unavailable");
  BOOL app_server = FALSE;
  if (!wcscmp(config->mode, L"native")) {
    for (int i = 1; i < argc; ++i) {
      if (!wcscmp(argv[i], L"app-server")) app_server = TRUE;
      if (!wcscmp(argv[i], L"--cwd")) {
        if (++i >= argc) fail("missing Native cwd");
        canonical(argv[i], cwd, TRUE);
      }
    }
  }
  wchar_t resolved[CAP]; canonical(cwd, resolved, TRUE); wcscpy(cwd, resolved);
  if ((app_server || !wcscmp(config->mode, L"gh")) && !under(config->root, cwd)) fail("task cwd escaped run root");
  size_t used = 0; argument(line, &used, config->executable);
  if (!wcscmp(config->mode, L"gh")) {
    argument(line, &used, config->script);
    argument(line, &used, L"--fixture-git"); argument(line, &used, config->git); argument(line, &used, config->git_sha);
  }
  for (int i = 1; i < argc; ++i) argument(line, &used, argv[i]);
  HANDLE handles[3]; DWORD standards[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i = 0; i < 3; ++i) if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(standards[i]),
       GetCurrentProcess(), &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) fail("cannot duplicate owned stdio");
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = calloc(bytes, 1);
  if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles, sizeof(handles), NULL, NULL)) fail("owned stdio handle list unavailable");
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  PROCESS_INFORMATION process = {0};
  if (!CreateProcessW(config->executable, line, NULL, NULL, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, cwd, &startup.StartupInfo, &process)) fail("fixed child CreateProcess failed");
  pending_child = process.hProcess;
  // No BREAKAWAY flag is used; the inherited outer RunContext Job cannot be escaped.
  DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList);
  for (int i = 0; i < 3; ++i) CloseHandle(handles[i]);
  if (app_server) {
    Identity child = identity(process.dwProcessId); size_t count;
    if (!same_path(child.image, config->executable) || !child.in_job) fail("created Native image or Job changed");
    Identity *rows = ancestry(config, GetCurrentProcessId(), &count);
    receipt(config, &child, cwd, rows, count); free(rows);
  }
  if (ResumeThread(process.hThread) == (DWORD)-1) fail("cannot resume fixed child");
  CloseHandle(process.hThread);
  if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) fail("fixed child wait failed");
  DWORD code; if (!GetExitCodeProcess(process.hProcess, &code)) fail("fixed child exit unavailable");
  pending_child = NULL; CloseHandle(process.hProcess); free(cwd); free(line); free(config); return (int)code;
}
