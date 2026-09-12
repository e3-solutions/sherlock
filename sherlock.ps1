[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet("install")][string]$Action = "install",
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][Alias("GithubId")][string]$Github,
    [Parameter(Mandatory = $true)][string]$Email,
    [string]$ClaudeBackfillHours = "72"
)

$ErrorActionPreference = "Stop"
& "$PSScriptRoot\plugins\sherlock\scripts\launch_installer.ps1" `
    -Providers auto -RepoRoot $PSScriptRoot -Name $Name -GithubId $Github -Email $Email `
    -ClaudeBackfillHours $ClaudeBackfillHours
exit $LASTEXITCODE
