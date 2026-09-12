[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][Alias("Github")][string]$GithubId,
    [Parameter(Mandatory = $true)][string]$Email
)

$ErrorActionPreference = "Stop"
& "$PSScriptRoot\plugins\sherlock\scripts\launch_installer.ps1" `
    -Providers claude_code -RepoRoot $PSScriptRoot -Name $Name -GithubId $GithubId -Email $Email
exit $LASTEXITCODE
