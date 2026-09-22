$ErrorActionPreference = 'Stop'

$name = 'dota2-mcp-http'
$cmd  = 'C:\Users\Admin\Documents\project\mcp_test\scripts\dota2-mcp-http.cmd'
$user = "$env:USERDOMAIN\$env:USERNAME"

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "removed existing task"
}

$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

# ExecutionTimeLimit 0 = never kill it (the default 72h would).
# RestartCount/Interval = crash recovery: nothing else respawns an HTTP MCP server.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

# S4U: runs without a visible console window (Interactive would flash a cmd box).
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Shared dota2-mcp server (streamable HTTP on 127.0.0.1:7331) for all Codex threads and Claude Code sessions.' | Out-Null

Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-Table -AutoSize
Write-Host "registered OK"
