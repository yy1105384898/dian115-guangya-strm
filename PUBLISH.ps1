$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$repository = 'yy1105384898/dian115-guangya-strm'
gh auth status
if ($LASTEXITCODE -ne 0) { throw '请先运行 gh auth login --hostname github.com，再重新执行本脚本。' }
$account = gh api user --jq .login
if ($LASTEXITCODE -ne 0 -or $account.Trim() -ne 'yy1105384898') { throw '登录账号必须为 yy1105384898' }
gh repo view $repository --json nameWithOwner 2>$null
if ($LASTEXITCODE -ne 0) {
  gh repo create $repository --public --description 'DIAN115 光鸭 STRM 同步插件：账号登录、自动云盘名称、规则同步与整理监控' --source . --remote origin --push
  if ($LASTEXITCODE -ne 0) { throw '仓库创建或推送失败' }
} else {
  git push -u origin main
  if ($LASTEXITCODE -ne 0) { throw '推送失败，未强制覆盖远端' }
}
gh release view v0.6.3 --repo $repository 2>$null
if ($LASTEXITCODE -ne 0) {
  gh release create v0.6.3 releases/guangya-strm-0.6.3.dian115p releases/SHA256SUMS --repo $repository --target main --title '光鸭 STRM 同步 v0.6.3' --notes-file RELEASE_NOTES.md
  if ($LASTEXITCODE -ne 0) { throw 'Release 发布失败' }
}
gh repo view $repository --json url --jq .url
