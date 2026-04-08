$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectPath

# Stop existing process on port 3000 if any
$existingPid = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
if ($existingPid) {
  Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
}

Write-Host "Starting AgencyFlow on http://localhost:3000 ..."
npm start
