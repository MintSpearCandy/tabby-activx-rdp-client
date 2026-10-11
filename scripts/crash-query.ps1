# crash-query.ps1 — recent app-crash records for the arc Tabby instance.
$events = Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=(Get-Date).AddDays(-2)} -ErrorAction SilentlyContinue
if (-not $events) { Write-Output 'no Event 1000 records in 48h'; exit }
foreach ($e in $events) {
  $msg = $e.Message -split "`r?`n"
  $faultApp = ($msg | Select-String 'P1:' | Select-Object -First 1) -replace '.*:\s*',''
  if ($faultApp -and $faultApp -notmatch 'Tabby|electron|rdp') { continue }
  Write-Output ('==== ' + $e.TimeCreated)
  $msg | Select-String -Pattern 'P1:|P2:|P3:|P4:|P5:|P6:|P7:|异常代码|Exception code|故障模块|Faulting module' | ForEach-Object { $_.ToString().Trim() }
}
