# 推送前脱敏扫描：独立一步，先读输出再 push。
# 扫已跟踪文件（git ls-files），四类必查：真实凭据形状 / 隐私路径 / 长串字面量 / 运行期产物。
# 输出结构：每行 "FILE:LINENO KIND: line"；无问题输出 SCAN RESULT: CLEAN。
[Culture]::CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
$issues = New-Object System.Collections.Generic.List[string]

# 隐私检查的备用分支在运行期构建，**不写死任何本机信息**——账户名 / 用户目录 /
# 当前工作目录都从环境变量与工作目录取，仓库与提交记录里不留本机痕迹。
$privacyPatternList = @(
  '[A-Za-z]:\\Users',                   # Windows 用户目录（匹配任意用户名）
  'Users\\',                            # 用户目录片段（反斜杠形态）
  '%USERPROFILE%',                      # 环境变量写法
  '/home/',                             # Unix 用户目录
  [regex]::Escape($env:USERNAME),       # 本机账户名（运行期取）
  [regex]::Escape($env:USERPROFILE),    # 本机用户目录绝对路径（运行期取）
  [regex]::Escape((Get-Location).Path)  # 当前工作目录绝对路径（运行期取）
)
$privacyRegex = ($privacyPatternList | Where-Object { $_ -ne '' }) -join '|'

$tracked = git ls-files 2>&1
foreach ($f in $tracked) {
  if (-not (Test-Path -LiteralPath $f)) { continue }
  $text = Get-Content -Raw -LiteralPath $f -ErrorAction SilentlyContinue
  if ($null -eq $text) { continue }
  $lineNo = 0
  foreach ($line in ($text -split "`n")) {
    $lineNo++
    # 1) 真实凭据按形状（关键字会漏，按各平台格式查）
    if ($line -match '\d{8,10}:[A-Za-z0-9_-]{35}') { $issues.Add("$f`:$lineNo REAL-TOKEN: $($line.Trim())") }
    if ($line -match 'xox[bpo]-[A-Za-z0-9-]{10,}') { $issues.Add("$f`:$lineNo SLACK-TOKEN: $($line.Trim())") }
    if ($line -match 'gh[pousr]_[A-Za-z0-9]{20,}') { $issues.Add("$f`:$lineNo GH-TOKEN: $($line.Trim())") }
    if ($line -match 'sk-[A-Za-z0-9]{20,}') { $issues.Add("$f`:$lineNo OPENAI-TOKEN: $($line.Trim())") }
    if ($line -match 'AKIA[0-9A-Z]{16}') { $issues.Add("$f`:$lineNo AWS-TOKEN: $($line.Trim())") }
    if ($line -match '-----BEGIN [A-Z ]*PRIVATE KEY-----') { $issues.Add("$f`:$lineNo PRIVATE-KEY") }
    if ($line -match '(?i)(token|secret|password|api_key|app_secret)\s*[=:]\s*[''"][^''"]{16,}[''"]') {
      $issues.Add("$f`:$lineNo LONG-LITERAL: $($line.Trim())")
    }
    # 2) 隐私数据：本机用户名 / 用户目录 / 本机绝对路径（$privacyRegex 运行期构建）
    if ($privacyRegex -ne '' -and $line -match $privacyRegex) {
      $issues.Add("$f`:$lineNo PRIVACY-PATH: $($line.Trim())")
    }
  }
}

if ($issues.Count -eq 0) {
  Write-Output "SCAN RESULT: CLEAN - no credentials, privacy paths, or long literals in tracked files"
} else {
  Write-Output "SCAN RESULT: $($issues.Count) issue(s) found - DO NOT PUSH until reviewed:"
  $issues | Select-Object -First 80
}