param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $NodePath
$info.Arguments = '-e "process.stdin.once(''data'',()=>process.exit(259))"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$child = [System.Diagnostics.Process]::Start($info)
$held = $child.SafeHandle
$retained = $false
try {
    $held.DangerousAddRef([ref]$retained)
    [Console]::Out.WriteLine($child.Id)
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'exit') { throw 'expected exit command' }
    $child.StandardInput.WriteLine('exit')
    $child.StandardInput.Flush()
    $child.WaitForExit()
    if ($child.ExitCode -ne 259) { throw 'unexpected exit code' }
    [Console]::Out.WriteLine('retained')
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'release') { throw 'expected release command' }
} finally {
    if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
    if ($retained) { $held.DangerousRelease() }
    $child.Dispose()
}
