// Isolate an owned profile while preserving product SSH argv and native stdio.
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#include <stdint.h>

#define CAP 32768
static int read_value(const wchar_t *dir,const wchar_t *leaf,wchar_t *out) {
  wchar_t path[CAP]; if(swprintf(path,CAP,L"%ls\\%ls",dir,leaf)<0)return 0;
  HANDLE file=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(file==INVALID_HANDLE_VALUE)return 0;
  LARGE_INTEGER size;DWORD read=0;
  int ok=GetFileSizeEx(file,&size)&&size.QuadPart>0&&size.QuadPart<(CAP-1)*2&&size.QuadPart%2==0;
  if(ok)ok=ReadFile(file,out,(DWORD)size.QuadPart,&read,NULL)&&read==(DWORD)size.QuadPart;
  CloseHandle(file);if(!ok)return 0;
  out[read/2]=0;
  for(DWORD i=0;i<read/2;i++)if(out[i]<32||out[i]==L'"'||out[i]==L'\0')return 0;
  return 1;
}
static int add(wchar_t *line,size_t *at,wchar_t value) {
  if(*at>=CAP-1)return 0;
  line[(*at)++]=value;line[*at]=0;return 1;
}
static int argument(wchar_t *line,size_t *at,const wchar_t *value) {
  if(*at&&!add(line,at,L' '))return 0;
  if(!add(line,at,L'"'))return 0;
  while(*value){size_t slashes=0;while(*value==L'\\'){slashes++;value++;}
    if(*value==L'"'||!*value){for(size_t i=0;i<slashes*2;i++)if(!add(line,at,L'\\'))return 0;
      if(*value==L'"'){if(!add(line,at,L'\\')||!add(line,at,*value++))return 0;}}
    else{for(size_t i=0;i<slashes;i++)if(!add(line,at,L'\\'))return 0;if(!add(line,at,*value++))return 0;}
  }
  return add(line,at,L'"');
}
static unsigned long long ticks(FILETIME t){return ((unsigned long long)t.dwHighDateTime<<32)|t.dwLowDateTime;}
int wmain(int argc,wchar_t **argv) {
  if(argc<2||argc>16)return 90;
  wchar_t dir[CAP],program[CAP],profile[CAP],owner[CAP],line[CAP]={0},record[CAP];
  DWORD n=GetModuleFileNameW(NULL,dir,CAP);if(!n||n>=CAP)return 91;
  wchar_t *last=wcsrchr(dir,L'\\');if(!last)return 92;*last=0;
  if(!read_value(dir,L"program.txt",program)||!read_value(dir,L"profile.txt",profile)||!read_value(dir,L"owner.txt",owner))return 93;
  if(wcslen(owner)!=36||wcslen(program)<4||program[1]!=L':'||profile[1]!=L':')return 94;
  for(size_t i=0;i<36;i++)if(!((owner[i]>=L'0'&&owner[i]<=L'9')||(owner[i]>=L'a'&&owner[i]<=L'f')||owner[i]==L'-'))return 95;
  if(_wputenv_s(L"KCODER_CONFIG_DIR",profile)||_wputenv_s(L"KCODER_HOME",L"")
      ||!SetEnvironmentVariableW(L"KCODER_CONFIG_DIR",profile)||!SetEnvironmentVariableW(L"KCODER_HOME",NULL))return 96;
  size_t at=0;if(!argument(line,&at,program))return 97;
  for(int i=1;i<argc;i++)if(!argument(line,&at,argv[i]))return 98;
  HANDLE job=CreateJobObjectW(NULL,NULL);if(!job)return 99;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){CloseHandle(job);return 100;}
  STARTUPINFOW start={0};start.cb=sizeof(start);start.dwFlags=STARTF_USESTDHANDLES;
  start.hStdInput=GetStdHandle(STD_INPUT_HANDLE);start.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);start.hStdError=GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child={0};
  if(!CreateProcessW(program,line,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,dir,&start,&child)){CloseHandle(job);return 101;}
  if(!AssignProcessToJobObject(job,child.hProcess)){TerminateProcess(child.hProcess,102);CloseHandle(child.hThread);CloseHandle(child.hProcess);CloseHandle(job);return 102;}
  FILETIME created,exit,kernel,user,parentCreated;
  if(!GetProcessTimes(child.hProcess,&created,&exit,&kernel,&user)||!GetProcessTimes(GetCurrentProcess(),&parentCreated,&exit,&kernel,&user)){
    CloseHandle(job);CloseHandle(child.hThread);CloseHandle(child.hProcess);return 103;}
  swprintf(record,CAP,L"%ls\\launch-owner-%lu.json",dir,GetCurrentProcessId());
  HANDLE file=CreateFileW(record,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
  if(file==INVALID_HANDLE_VALUE){CloseHandle(job);CloseHandle(child.hThread);CloseHandle(child.hProcess);return 104;}
  char text[1024];int bytes=snprintf(text,sizeof(text),"{\"owner\":\"%ls\",\"parentPid\":%lu,\"parentFileTime\":\"%llu\",\"childPid\":%lu,\"childFileTime\":\"%llu\"}\n",owner,GetCurrentProcessId(),ticks(parentCreated),child.dwProcessId,ticks(created));
  DWORD written=0;int saved=bytes>0&&bytes<(int)sizeof(text)&&WriteFile(file,text,(DWORD)bytes,&written,NULL)&&written==(DWORD)bytes&&FlushFileBuffers(file);
  CloseHandle(file);if(!saved){CloseHandle(job);CloseHandle(child.hThread);CloseHandle(child.hProcess);return 105;}
  ResumeThread(child.hThread);CloseHandle(child.hThread);WaitForSingleObject(child.hProcess,INFINITE);
  DWORD code=1;GetExitCodeProcess(child.hProcess,&code);CloseHandle(child.hProcess);CloseHandle(job);return (int)code;
}
