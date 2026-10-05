$ErrorActionPreference = "Continue"
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$profile = "C:\vscode\browser-skill\.play-visible-profile"
$url = "https://www.bilibili.com/toy/xujiayin-blank/index.html"
$log = "C:\vscode\browser-skill\artifacts\keep-visible-edge.log"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
New-Item -ItemType Directory -Force -Path "C:\vscode\browser-skill\artifacts" | Out-Null
New-Item -ItemType Directory -Force -Path "$profile\Default" | Out-Null

$prefs = @"
{"browser":{"has_seen_welcome_page":true,"check_default_browser":false},"signin":{"allowed":false},"sync":{"suppress_start":true},"distribution":{"import_bookmarks":false,"make_chrome_default":false}}
"@
Set-Content -Path "$profile\Default\Preferences" -Value $prefs -Encoding UTF8

function Write-Log($m) {
  $line = "$(Get-Date -Format o) $m"
  Add-Content -Path $log -Value $line
  Write-Output $line
}

function Test-Cdp {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:9334/json/version" -UseBasicParsing -TimeoutSec 1
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Start-VisibleEdge {
  Write-Log "launching visible Edge"
  Start-Process -FilePath $edge -ArgumentList @(
    "--user-data-dir=$profile",
    "--profile-directory=Default",
    "--remote-debugging-port=9334",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-session-crashed-bubble",
    "--disable-features=msEdgeSigninPromo,msWelcomePageOnLaunch,TranslateUI",
    "--start-maximized",
    "--window-position=60,40",
    "--window-size=1400,900",
    $url
  ) | Out-Null
}

if (-not (Test-Cdp)) { Start-VisibleEdge }

$deadline = (Get-Date).AddHours(6)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 4
  if (-not (Test-Cdp)) {
    Write-Log "CDP down, relaunch"
    Start-VisibleEdge
    Start-Sleep -Seconds 3
  }
}
