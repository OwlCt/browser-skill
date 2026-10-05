param(
    [string]$ServerName = "responses_edge_browser",
    [ValidateSet("install", "get", "remove")]
    [string]$Action = "install"
)

$ErrorActionPreference = "Stop"

if ($ServerName -notmatch "^[A-Za-z0-9_-]+$") {
    throw "ServerName may contain only letters, numbers, underscores, and hyphens."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $projectRoot "src\mcp-server.mjs"
$nodeCommand = Get-Command node -ErrorAction Stop
$codexExecutable = if ($env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH -PathType Leaf)) {
    $env:CODEX_CLI_PATH
} else {
    (Get-Command codex -ErrorAction Stop).Source
}

$windowsProfile = [System.Environment]::GetFolderPath('UserProfile')
if (-not $env:CODEX_HOME -and $env:USERPROFILE -and $windowsProfile -ne $env:USERPROFILE) {
    throw "This process runs under $windowsProfile, while the desktop profile is $env:USERPROFILE. Run this command in the desktop host environment; a sandbox MCP list does not describe the desktop registration."
}
$effectiveCodexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $windowsProfile '.codex' }
Write-Host "Codex executable: $codexExecutable"
Write-Host "Codex config directory: $effectiveCodexDirectory"

if ($Action -ne "install") {
    & $codexExecutable mcp $Action $ServerName
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) {
    throw "MCP server entry point was not found: $serverScript"
}

$previousErrorActionPreference = $ErrorActionPreference
try {
    # A missing registration is the expected first-install state. Windows
    # PowerShell otherwise promotes the CLI's stderr to a terminating error
    # before we can inspect its exit code.
    $ErrorActionPreference = "SilentlyContinue"
    & $codexExecutable mcp get $ServerName *> $null
    $existingServerExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}

if ($existingServerExitCode -eq 0) {
    & $codexExecutable mcp remove $ServerName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to remove the existing MCP registration: $ServerName"
    }
}

& $codexExecutable mcp add $ServerName -- $nodeCommand.Source $serverScript
if ($LASTEXITCODE -ne 0) {
    throw "Failed to register MCP server: $ServerName"
}

& $codexExecutable mcp get $ServerName
if ($LASTEXITCODE -ne 0) {
    throw "MCP registration could not be read back: $ServerName"
}

Write-Host "Restart Codex so the new MCP tools are loaded."
Write-Host "If CC Switch manages Codex, also retain this server in its Codex common config and MCP registry."
