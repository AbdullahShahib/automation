# Stop process bound to port 3000
$existingPid = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess

if ($existingPid) {
  Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped process on port 3000 (PID: $existingPid)."
} else {
  Write-Host "No process is running on port 3000."
}
