param(
  [Parameter(Mandatory=$true)]
  [string]$SourceJsonPath
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $projectRoot "data"
$targetPath = Join-Path $targetDir "google-credentials.json"

if (-not (Test-Path $SourceJsonPath)) {
  Write-Error "Source file not found: $SourceJsonPath"
  exit 1
}

if (-not (Test-Path $targetDir)) {
  New-Item -ItemType Directory -Path $targetDir | Out-Null
}

Copy-Item -Path $SourceJsonPath -Destination $targetPath -Force
Write-Host "Copied credentials to: $targetPath"
Write-Host "Next step: run 'npm run verify:sheets' from project root."
