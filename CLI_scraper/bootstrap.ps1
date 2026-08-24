$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $ProjectRoot "scripts/bootstrap.js") @args
exit $LASTEXITCODE
