param(
    [int]$Port = 9222,
    [string]$UserDataDir = "$env:LOCALAPPDATA\ResponsesEdgeProfile",
    [string]$EdgeExecutable = ""
)

$ErrorActionPreference = "Stop"

if (-not $EdgeExecutable) {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
    $EdgeExecutable = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $EdgeExecutable -or -not (Test-Path -LiteralPath $EdgeExecutable)) {
    throw "Microsoft Edge executable was not found. Set EDGE_EXECUTABLE or pass -EdgeExecutable."
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

$arguments = @(
    "--remote-debugging-port=$Port",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$UserDataDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
)

Start-Process -FilePath $EdgeExecutable -ArgumentList $arguments
Write-Host "Edge started with CDP at http://127.0.0.1:$Port"
Write-Host "Profile: $UserDataDir"
