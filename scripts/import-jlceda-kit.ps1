<#
.SYNOPSIS
    一键将 666 仓库中的嘉立创EDA Skills/插件/记忆导入本机 Antigravity，并准备嘉立创EDA专业版扩展(.eext)导入与连接自检。
.DESCRIPTION
    1. 自动探测本机嘉立创EDA专业版 (lceda-pro.exe v4.1.70+)，避开旧版 v2.x。
    2. 将 666/.agents/plugins/embedded-hardware-kit 同步到 %USERPROFILE%\.gemini\config\plugins\embedded-hardware-kit，
       自动写入适配本机路径的原生 MCP 配置 (mcp_config.json)，并补齐 easyeda-api 的 ws 依赖。
    3. 校验/下载官方中文版 .eext 扩展（Run API Gateway + 嘉立创 DFM 检查），可选打开目录并激活嘉立创窗口便于直接点击「导入」。
    4. 实测 lceda-pro 原生桥接 (doctor) 与当前打开的工程会话 (session list)，可选启动 WebSocket Bridge。
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\import-jlceda-kit.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\import-jlceda-kit.ps1 -StartBridge
#>
[CmdletBinding()]
param(
    [string]$LcedaExe = "",
    [switch]$StartBridge,
    [switch]$NoExplorer,
    [switch]$NoActivate,
    [switch]$SkipNpm
)

$ErrorActionPreference = "Stop"
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

$RepoRoot    = Split-Path -Parent $PSScriptRoot
$SrcPlugin   = Join-Path $RepoRoot ".agents\plugins\embedded-hardware-kit"
$DstPlugin   = Join-Path $env:USERPROFILE ".gemini\config\plugins\embedded-hardware-kit"
$ExtDir      = Join-Path $RepoRoot "extensions"

function Write-Step([string]$Msg) {
    Write-Host ""
    Write-Host "=== $Msg ===" -ForegroundColor Cyan
}

function Write-Ok([string]$Msg) {
    Write-Host "  [OK] $Msg" -ForegroundColor Green
}

function Write-Warn([string]$Msg) {
    Write-Host "  [WARN] $Msg" -ForegroundColor Yellow
}

function Test-LcedaCliCandidate([string]$ExePath) {
    if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) { return $null }
    $dir = Split-Path -Parent $ExePath
    $verFile = Join-Path $dir "version"
    $verHint = ""
    if (Test-Path -LiteralPath $verFile) {
        $verHint = (Get-Content -LiteralPath $verFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($verHint -and $verHint -match '^[123]\.') {
            # 跳过明显不支持 CLI 的老版本 (v2.x / v3.x)，避免 probe 卡死
            return $null
        }
    }
    try {
        $tmpOut = [System.IO.Path]::GetTempFileName()
        $tmpErr = [System.IO.Path]::GetTempFileName()
        $p = Start-Process -FilePath $ExePath -ArgumentList "--help" -NoNewWindow -PassThru `
            -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
        $finished = $p.WaitForExit(8000)
        if (-not $finished) {
            try { $p.Kill() } catch {}
            Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
            return $null
        }
        $out = (Get-Content -LiteralPath $tmpOut -Raw -ErrorAction SilentlyContinue)
        Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
        if ($out -and ($out -match 'JLCEDA Pro\s+([0-9]+\.[0-9]+\.[0-9]+[^\r\n]*)' -or $out -match 'EasyEDA Pro\s+([0-9]+\.[0-9]+\.[0-9]+[^\r\n]*)')) {
            return [PSCustomObject]@{
                Executable = (Resolve-Path -LiteralPath $ExePath).Path
                Version    = $Matches[1].Trim()
            }
        }
    } catch {}
    return $null
}

function Find-LcedaProCli([string]$OverridePath) {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($OverridePath) { $candidates.Add($OverridePath) }

    # 1. 注册表卸载项（优先当前用户安装的新版本）
    $regPaths = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($rp in $regPaths) {
        $items = Get-ItemProperty $rp -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match '嘉立创EDA|EasyEDA|LCEDA' -and $_.InstallLocation }
        foreach ($it in $items) {
            $exe1 = Join-Path $it.InstallLocation "lceda-pro.exe"
            $exe2 = Join-Path $it.InstallLocation "easyeda-pro.exe"
            if (Test-Path -LiteralPath $exe1) { $candidates.Add($exe1) }
            if (Test-Path -LiteralPath $exe2) { $candidates.Add($exe2) }
        }
    }

    # 2. PATH 中的可执行文件
    foreach ($dir in ($env:PATH -split ';')) {
        if (-not $dir) { continue }
        foreach ($name in @("lceda-pro.exe", "easyeda-pro.exe")) {
            $full = Join-Path $dir $name
            if (Test-Path -LiteralPath $full) { $candidates.Add($full) }
        }
    }

    # 3. 常见安装路径
    foreach ($p in @(
        "D:\lceda-pro\lceda-pro.exe",
        "C:\Program Files\lceda-pro\lceda-pro.exe",
        "$env:LOCALAPPDATA\Programs\lceda-pro\lceda-pro.exe"
    )) {
        if (Test-Path -LiteralPath $p) { $candidates.Add($p) }
    }

    $seen = @{}
    foreach ($c in $candidates) {
        $norm = $c.ToLowerInvariant()
        if ($seen.ContainsKey($norm)) { continue }
        $seen[$norm] = $true
        $hit = Test-LcedaCliCandidate $c
        if ($hit) { return $hit }
    }
    return $null
}

# ==============================================================================
# Step 1: 检测本机嘉立创EDA专业版 (v4.1.70+)
# ==============================================================================
Write-Step "1/5 检测本机嘉立创EDA专业版 (CLI / 原生 MCP)"
$lceda = Find-LcedaProCli -OverridePath $LcedaExe
if ($lceda) {
    Write-Ok "已定位支持原生 CLI/MCP 的客户端: $($lceda.Executable) (版本 $($lceda.Version))"
} else {
    Write-Warn "未自动检测到支持 CLI 的嘉立创EDA专业版 v4.1.70+。你仍可继续导入 Skills，稍后可用 -LcedaExe 指定路径。"
}

# ==============================================================================
# Step 2: 导入 666 中的全部 Skills、常驻记忆与原生 MCP 到 Antigravity
# ==============================================================================
Write-Step "2/5 导入 Skills、常驻记忆与原生 MCP 到 Antigravity 插件目录"
if (-not (Test-Path -LiteralPath $SrcPlugin)) {
    throw "未找到源插件目录: $SrcPlugin，请确认在 666 仓库完整目录中运行此脚本。"
}

New-Item -ItemType Directory -Force -Path $DstPlugin, (Join-Path $DstPlugin "skills"), (Join-Path $DstPlugin "rules") | Out-Null

Copy-Item -LiteralPath (Join-Path $SrcPlugin "plugin.json") -Destination (Join-Path $DstPlugin "plugin.json") -Force
Copy-Item -LiteralPath (Join-Path $SrcPlugin "rules\AGENTS.md") -Destination (Join-Path $DstPlugin "rules\AGENTS.md") -Force

$skillDirs = Get-ChildItem -LiteralPath (Join-Path $SrcPlugin "skills") -Directory
foreach ($sk in $skillDirs) {
    $dstSk = Join-Path $DstPlugin ("skills\" + $sk.Name)
    New-Item -ItemType Directory -Force -Path $dstSk | Out-Null
    # 使用 robocopy 同步（保留目标内已有 node_modules，免重复下载）
    & robocopy $sk.FullName $dstSk /E /MIR /XD node_modules .git /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "同步 Skill 失败: $($sk.Name) (robocopy exit=$LASTEXITCODE)"
    }
    Write-Ok "已导入 Skill: $($sk.Name)"
}

# 写入适配本机真实路径的 mcp_config.json
$mcpExe = if ($lceda) { $lceda.Executable } else { "D:\lceda-pro\lceda-pro.exe" }
$mcpObj = [ordered]@{
    mcpServers = [ordered]@{
        "lceda-pro" = [ordered]@{
            command = $mcpExe
            args    = @("--mcp", "stdio")
        }
    }
}
$mcpJson = $mcpObj | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $DstPlugin "mcp_config.json"), $mcpJson + "`r`n", [System.Text.UTF8Encoding]::new($false))
Write-Ok "已更新原生 MCP 配置: $(Join-Path $DstPlugin 'mcp_config.json') -> $mcpExe --mcp stdio"
Write-Ok "已写入 Antigravity 常驻记忆: $(Join-Path $DstPlugin 'rules\AGENTS.md')"

# 补齐 easyeda-api 的 ws 依赖
$apiSkillDir = Join-Path $DstPlugin "skills\easyeda-api"
$wsDir = Join-Path $apiSkillDir "node_modules\ws"
if (-not $SkipNpm -and (Test-Path -LiteralPath (Join-Path $apiSkillDir "package.json")) -and -not (Test-Path -LiteralPath $wsDir)) {
    $npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Write-Host "  正在为 easyeda-api 安装 ws 依赖..." -ForegroundColor DarkGray
        Push-Location $apiSkillDir
        try {
            & $npmCmd.Source install --omit=dev --no-audit --no-fund | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Ok "easyeda-api 依赖 (ws) 安装完成" }
            else { Write-Warn "npm install 返回退出码 $LASTEXITCODE（不影响原生 CLI/MCP 使用）" }
        } finally {
            Pop-Location
        }
    } else {
        Write-Warn "未检测到 npm.cmd，跳过 easyeda-api 的 ws 安装（不影响原生 CLI/MCP 使用）"
    }
} elseif (Test-Path -LiteralPath $wsDir) {
    Write-Ok "easyeda-api 依赖 (ws) 已就绪"
}

# ==============================================================================
# Step 3: 准备并校验嘉立创EDA专业版官方中文扩展 (.eext)
# ==============================================================================
Write-Step "3/5 准备嘉立创EDA专业版官方扩展 (.eext)"
New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

$officialEexts = @(
    @{
        Name = "run-api-gateway_v1.0.5_zh-cn.eext"
        Desc = "官方 AI WebSocket 网关扩展（配合 easyeda-api Skill 使用）"
        Url  = "https://github.com/easyeda/eext-run-api-gateway/releases/download/v1.0.5/run-api-gateway_v1.0.5_zh-cn.eext"
    },
    @{
        Name = "jlc-order-dfm-checker_v1.0.5_zh-cn.eext"
        Desc = "官方嘉立创下单 DFM 自动检查扩展"
        Url  = "https://github.com/easyeda/eext-jlc-order-dfm-checker/releases/download/v1.0.5/jlc-order-dfm-checker_v1.0.5_zh-cn.eext"
    }
)

$readyEexts = New-Object System.Collections.Generic.List[string]
foreach ($ext in $officialEexts) {
    $localFile = Join-Path $ExtDir $ext.Name
    if (-not (Test-Path -LiteralPath $localFile)) {
        Write-Host "  正在下载官方扩展: $($ext.Name)..." -ForegroundColor DarkGray
        & curl.exe -fsSL --retry 3 -o $localFile $ext.Url
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "下载失败: $($ext.Name) ($($ext.Url))"
            continue
        }
    }
    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($localFile)
        $hasManifest = ($zip.Entries | Where-Object { $_.FullName -eq "extension.json" }).Count -gt 0
        $zip.Dispose()
        if ($hasManifest) {
            $readyEexts.Add($localFile)
            Write-Ok "$($ext.Name) — $($ext.Desc)"
        } else {
            Write-Warn "$($ext.Name) 缺少 extension.json，文件可能损坏"
        }
    } catch {
        Write-Warn "校验 $($ext.Name) 失败: $_"
    }
}

# ==============================================================================
# Step 4: 验证嘉立创原生桥接与打开的工程会话
# ==============================================================================
Write-Step "4/5 验证嘉立创EDA原生桥接与当前会话"
if ($lceda) {
    $doctorRaw = (& $lceda.Executable doctor | Out-String).Trim()
    try {
        $docObj = $doctorRaw | ConvertFrom-Json
        if ($docObj.ok -and $docObj.value.connected) {
            Write-Ok "原生桥接已连通: bridgeVersion=$($docObj.value.bridgeVersion), versionMatch=$($docObj.value.versionMatch)"
            $sessRaw = (& $lceda.Executable session list | Out-String).Trim()
            $sessObj = $sessRaw | ConvertFrom-Json
            if ($sessObj.ok -and $sessObj.value.Count -gt 0) {
                foreach ($s in $sessObj.value) {
                    Write-Ok "已识别打开窗口: $($s.title) [sessionId=$($s.sessionId)]"
                }
            } else {
                Write-Warn "嘉立创桥接已就绪，当前暂无打开的工程窗口。"
            }
        } else {
            Write-Warn "原生桥接未连通（请先打开嘉立创EDA专业版客户端）: $doctorRaw"
        }
    } catch {
        Write-Warn "解析 doctor 输出失败: $doctorRaw"
    }
}

# 可选启动 easyeda-api WebSocket 桥接服务
if ($StartBridge) {
    $bridgeScript = Join-Path $apiSkillDir "scripts\bridge-server.mjs"
    if (Test-Path -LiteralPath $bridgeScript) {
        $alreadyPort = $null
        for ($port = 49620; $port -le 49629; $port++) {
            try {
                $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 -ErrorAction Stop
                if ($h.service -eq "easyeda-bridge") { $alreadyPort = $port; break }
            } catch {}
        }
        if ($alreadyPort) {
            Write-Ok "easyeda-api WebSocket Bridge 已在运行: http://127.0.0.1:$alreadyPort"
        } else {
            Start-Process -FilePath "node" -ArgumentList @($bridgeScript) -WorkingDirectory $apiSkillDir -WindowStyle Hidden
            Start-Sleep -Seconds 2
            for ($port = 49620; $port -le 49629; $port++) {
                try {
                    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 -ErrorAction Stop
                    if ($h.service -eq "easyeda-bridge") { $alreadyPort = $port; break }
                } catch {}
            }
            if ($alreadyPort) {
                Write-Ok "已后台启动 easyeda-api WebSocket Bridge: http://127.0.0.1:$alreadyPort"
            } else {
                Write-Warn "尝试启动 Bridge 服务但未在 49620-49629 检测到响应，请检查 node 与 ws 依赖。"
            }
        }
    }
}

# ==============================================================================
# Step 5: 引导将 .eext 导入嘉立创EDA专业版（因扩展存于客户端 IndexedDB，需界面点一次导入）
# ==============================================================================
Write-Step "5/5 嘉立创EDA专业版界面导入说明"
Write-Host "  说明：Antigravity 的 6 个 Skills + 原生 MCP + 持久记忆已完成自动导入，免装扩展即可使用原生 CLI/MCP。" -ForegroundColor White
Write-Host "  如需同时在嘉立创「扩展管理器」中启用官方 .eext 扩展（Run API Gateway / DFM检查），只需点一次：" -ForegroundColor White
Write-Host "    1) 在嘉立创EDA专业版顶部菜单打开：高级 -> 扩展管理器 -> 点击左下角蓝色【导入】按钮" -ForegroundColor Yellow
Write-Host "    2) 选择以下目录中的 .eext 文件：" -ForegroundColor Yellow
foreach ($f in $readyEexts) {
    Write-Host "       - $f" -ForegroundColor Green
}
Write-Host "    3) 导入后在「已安装」中启用，并勾选「允许外部交互（Allow External Interaction）」" -ForegroundColor Yellow

if (-not $NoExplorer -and $readyEexts.Count -gt 0) {
    Start-Process -FilePath "explorer.exe" -ArgumentList "/select,`"$($readyEexts[0])`""
}
if (-not $NoActivate -and $lceda) {
    & $lceda.Executable activate | Out-Null
}

Write-Host ""
Write-Host "全部完成！新开或继续 Antigravity 对话即可直接使用全部 6 个嘉立创/STM32 Skills。" -ForegroundColor Green
