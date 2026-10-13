@echo off
rem AvmaDrive launcher: runs a tiny local web server (localhost only) and opens the app in Chrome/Edge.
rem Keep this file in the same folder as index.html.   Usage: AvmaDrive.bat, or with the argument stop / autostart-off
setlocal
set "AVMA_BAT=%~f0"
set "AVMA_DIR=%~dp0"
set "AVMA_PORT=8765"
set "AVMA_URL=http://localhost:%AVMA_PORT%/"
if /i "%~1"=="server" goto start_server_only
if /i "%~1"=="stop" goto stop_server
if /i "%~1"=="autostart-off" goto autostart_off

if not exist "%AVMA_DIR%index.html" (
  echo index.html was not found next to AvmaDrive.bat
  pause
  exit /b 1
)

call :start_server
call :find_browser
if defined BROWSER (
  start "" "%BROWSER%" "%AVMA_URL%"
) else (
  start "" "%AVMA_URL%"
)

set "ASKED=%LOCALAPPDATA%\AvmaDrive\autostart-asked"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AvmaDrive Server.lnk"
if exist "%LNK%" exit /b 0
if exist "%ASKED%" exit /b 0
echo.
echo The installed app needs the local server to be running.
choice /c YN /m "Start the server automatically when Windows starts"
if errorlevel 2 goto asked_done
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $l=$w.CreateShortcut($env:LNK); $l.TargetPath=$env:AVMA_BAT; $l.Arguments='server'; $l.WorkingDirectory=$env:AVMA_DIR; $l.WindowStyle=7; $l.Save()"
echo Done. (Remove it later with: AvmaDrive.bat autostart-off)
:asked_done
if not exist "%LOCALAPPDATA%\AvmaDrive" mkdir "%LOCALAPPDATA%\AvmaDrive"
echo 1>"%ASKED%"
exit /b 0

:start_server_only
call :start_server
exit /b 0

:start_server
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',[int]$env:AVMA_PORT);$c.Close();exit 0}catch{exit 1}"
if not errorlevel 1 exit /b 0
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$s=[IO.File]::ReadAllText($env:AVMA_BAT,[Text.Encoding]::UTF8); Invoke-Expression $s.Substring($s.IndexOf('#PS-'+'BEGIN'))"
set /a N=0
:wait_loop
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',[int]$env:AVMA_PORT);$c.Close();exit 0}catch{exit 1}"
if not errorlevel 1 exit /b 0
set /a N+=1
if %N% GEQ 15 exit /b 1
timeout /t 1 /nobreak >nul
goto wait_loop

:find_browser
set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"
exit /b 0

:stop_server
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -Uri ($env:AVMA_URL + '__stop') -Headers @{'X-Avma'='1'} | Out-Null}catch{}"
echo Server stopped.
exit /b 0

:autostart_off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AvmaDrive Server.lnk" 2>nul
echo Autostart removed.
exit /b 0

#PS-BEGIN
$ErrorActionPreference = 'Stop'
$sep  = [string][IO.Path]::DirectorySeparatorChar
$root = [IO.Path]::GetFullPath($env:AVMA_DIR).TrimEnd('\', '/')
$port = [int]$env:AVMA_PORT
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'; '.png' = 'image/png'; '.webp' = 'image/webp'
  '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.woff2' = 'font/woff2'
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Send($ctx, [byte[]]$bytes, [string]$type, [int]$status = 200) {
  $r = $ctx.Response
  $r.StatusCode = $status
  $r.ContentType = $type
  $r.Headers.Add('Cache-Control', 'no-cache')
  $r.ContentLength64 = $bytes.Length
  $r.OutputStream.Write($bytes, 0, $bytes.Length)
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try { $listener.Start() } catch { exit 1 }
while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  try {
    $p = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($p -eq '/__stop' -and $ctx.Request.Headers['X-Avma'] -eq '1') { Send $ctx ($utf8.GetBytes('bye')) 'text/plain'; $ctx.Response.Close(); $listener.Stop(); break }
    if ($p -eq '/') { $p = '/index.html' }
    $rel  = $p.TrimStart('/').Replace('/', $sep)
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))
    $ext  = [IO.Path]::GetExtension($full).ToLowerInvariant()
    if ($full.StartsWith($root + $sep) -and $mime.ContainsKey($ext) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
      Send $ctx ([IO.File]::ReadAllBytes($full)) $mime[$ext]
    } else {
      Send $ctx ($utf8.GetBytes('not found')) 'text/plain' 404
    }
  } catch { }
  try { $ctx.Response.Close() } catch { }
}
