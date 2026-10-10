param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ProcessAcl {
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool InitializeAcl(IntPtr acl, uint size, uint revision);
    [DllImport("advapi32.dll")]
    public static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint information,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
}
'@
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $NodePath
$info.Arguments = '-e "process.stdin.once(''data'',()=>process.exit(0))"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$child = [System.Diagnostics.Process]::Start($info)
$acl = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(8)
try {
    [Console]::Out.WriteLine($child.Id)
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'deny') { throw 'expected deny command' }
    if (-not [ProcessAcl]::InitializeAcl($acl, 8, 2)) { throw 'InitializeAcl failed' }
    $result = [ProcessAcl]::SetSecurityInfo($child.Handle, 6, [uint32]2147483652,
        [IntPtr]::Zero, [IntPtr]::Zero, $acl, [IntPtr]::Zero)
    if ($result -ne 0) { throw "SetSecurityInfo failed: $result" }
    [Console]::Out.WriteLine('denied')
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'release') { throw 'expected release command' }
} finally {
    if (-not $child.HasExited) {
        $child.StandardInput.WriteLine('exit')
        $child.StandardInput.Flush()
        $child.WaitForExit()
    }
    $child.Dispose()
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($acl)
}
