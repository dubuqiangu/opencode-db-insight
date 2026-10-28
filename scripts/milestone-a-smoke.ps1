# 里程碑 A 冒烟：验证 ?day= 服务端本地日过滤在运行看板上的真实行为。
# 只读验证，不改动任何状态。
[Culture]::CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-Day([long]$epochMs) {
  return ([DateTimeOffset]::FromUnixTimeMilliseconds($epochMs).ToLocalTime()).ToString("yyyy-MM-dd")
}

$allJson = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18789/api/sessions?limit=5000" -TimeoutSec 20).Content
$allArr = @()
$allArr += ConvertFrom-Json $allJson
Write-Output ("ALL fetched={0}" -f $allArr.Count)

$day = Get-Day ([long]$allArr[0].timeUpdated)
$countOnDay = 0
foreach ($session in $allArr) {
  if ((Get-Day ([long]$session.timeUpdated)) -eq $day) { $countOnDay++ }
}
Write-Output ("CLIENT day={0} count={1}" -f $day, $countOnDay)

$filteredJson = (Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:18789/api/sessions?limit=5000&day={0}" -f $day) -TimeoutSec 20).Content
$filteredArr = @()
$filteredArr += ConvertFrom-Json $filteredJson
$serverOnDay = 0
foreach ($session in $filteredArr) {
  if ((Get-Day ([long]$session.timeUpdated)) -eq $day) { $serverOnDay++ }
}
Write-Output ("SERVER day={0} count={1} allReturnedOnDay={2}" -f $day, $filteredArr.Count, $serverOnDay)
Write-Output ("MATCH-CLIENT-SERVER={0}" -f ($countOnDay -eq $filteredArr.Count))

Write-Output "SMOKE DONE"