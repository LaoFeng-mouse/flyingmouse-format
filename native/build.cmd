@echo off
setlocal
if not defined FM_VCVARS exit /b 2
if not defined FM_LAUNCHER_BUILD_DIR exit /b 2
call "%FM_VCVARS%"
if errorlevel 1 exit /b 1
cd /d "%FM_LAUNCHER_BUILD_DIR%"
rc /nologo /fo launcher.res launcher.rc
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /O2 /MT /W4 /utf-8 /EHsc /DUNICODE /D_UNICODE /I "%FM_LAUNCHER_BUILD_DIR%" "%~dp0launcher.cpp" launcher.res /Fe:launcher.exe /link /SUBSYSTEM:WINDOWS /DYNAMICBASE /NXCOMPAT user32.lib shell32.lib ole32.lib advapi32.lib bcrypt.lib
exit /b %errorlevel%
