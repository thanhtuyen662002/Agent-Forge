// Run this repository-owned program through the fixed Windows PowerShell binary.
// Paths and commands arrive as JSON on stdin, never as executable shell text.
// These are kernel primitives; the service must also fence Git metadata and
// ownership before admitting a complete worktree mutation.
export const WINDOWS_DIRECTORY_BOUNDARY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class AgentForgeDirectoryPins : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public FileTime Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    public int Length; public IntPtr Root, Name; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQuality;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, byte[] data, uint size);
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status,
    IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);

  readonly Dictionary<string, SafeFileHandle> ancestors = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  readonly Dictionary<string, SafeFileHandle> children = new Dictionary<string, SafeFileHandle>(StringComparer.Ordinal);
  readonly string root;
  public AgentForgeDirectoryPins(string managedRoot) {
    root = Path.GetFullPath(managedRoot).TrimEnd('\\');
    if (root.Length < 4 || root[1] != ':' || root.StartsWith("\\\\") || root.IndexOf(':',2) >= 0)
      throw new IOException("UNSUPPORTED_MUTATION_BOUNDARY");
    try {
      string current = Path.GetPathRoot(root);
      PinAncestor(current);
      foreach (string part in root.Substring(current.Length).Split('\\')) {
        current = Path.Combine(current, part);
        PinAncestor(current);
      }
    } catch { Dispose(); throw; }
  }
  void PinAncestor(string candidate) {
    // Deny write-data and delete sharing. Windows permits an attributes-only
    // writer to set a reparse point despite these pins. This is not a safe
    // wrapper for path-based Git mutation; only relative/captured primitives
    // below are admitted, with reparse checks before each native operation.
    // FILE_LIST_DIRECTORY makes sharing enforcement apply. An attributes-only
    // handle does not fence rename on Windows even with delete sharing absent.
    SafeFileHandle handle = CreateFileW(candidate, 0x81, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new IOException("BOUNDARY_OPEN_DENIED"); }
    try { Identity(handle, candidate); ancestors.Add(candidate, handle); }
    catch { handle.Dispose(); throw; }
  }
  static FileInfo Check(SafeFileHandle handle) {
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x10) == 0 || (info.Attributes & 0x400) != 0)
      throw new IOException("BOUNDARY_REPARSE_OR_IDENTITY_DENIED");
    return info;
  }
  public static object Identity(SafeFileHandle handle, string expected) {
    FileInfo info = Check(handle);
    StringBuilder text = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, text, (uint)text.Capacity, 0);
    if (length == 0 || length >= text.Capacity) throw new IOException("BOUNDARY_IDENTITY_UNAVAILABLE");
    string final = text.ToString();
    if (final.StartsWith("\\\\?\\")) final = final.Substring(4);
    if (!String.Equals(final.TrimEnd('\\'), Path.GetFullPath(expected).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
      throw new IOException("BOUNDARY_PATH_IDENTITY_CHANGED");
    return new { volume = info.Volume.ToString(), fileId = (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString() };
  }
  public object RootIdentity() { return Identity(ancestors[root], root); }
  static void Name(string name) {
    if (name == null || !System.Text.RegularExpressions.Regex.IsMatch(name, "\\Aafw-[0-9a-f]{32}\\z"))
      throw new IOException("BOUNDARY_CHILD_NAME_DENIED");
  }
  public object Child(string name, bool create) { return OpenChild(name, create, false); }
  object OpenChild(string name, bool create, bool deleting) {
    Name(name);
    RootIdentity();
    if (children.ContainsKey(name)) throw new IOException("BOUNDARY_CHILD_ALREADY_CAPTURED");
    IntPtr buffer = IntPtr.Zero, unicode = IntPtr.Zero;
    SafeFileHandle handle = null;
    try {
      buffer = Marshal.StringToHGlobalUni(name);
      UnicodeString value = new UnicodeString { Length = checked((ushort)(name.Length*2)), MaximumLength = checked((ushort)((name.Length+1)*2)), Buffer = buffer };
      unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
      Marshal.StructureToPtr(value, unicode, false);
      ObjectAttributes attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)), Root = ancestors[root].DangerousGetHandle(), Name = unicode, Attributes = 0x40 };
      IoStatus status;
      // FILE_CREATE returns the new object handle atomically. The leaf cannot
      // be swapped between mkdir and open. FILE_OPEN never follows a junction.
      int result = NtCreateFile(out handle, deleting ? 0x00110080u : 0x00100081u, ref attributes, out status, IntPtr.Zero, 0x10, 1,
        create ? 2u : 1u, 0x00200021, IntPtr.Zero, 0);
      if (result < 0 || handle == null || handle.IsInvalid) throw new IOException("BOUNDARY_CHILD_OPEN_DENIED");
      object identity = Identity(handle, Path.Combine(root, name));
      children.Add(name, handle); handle = null;
      return identity;
    } finally {
      if (handle != null) handle.Dispose();
      if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
    }
  }
  public void DeleteEmptyChild(string name) {
    Name(name);
    RootIdentity();
    SafeFileHandle handle;
    if (!children.TryGetValue(name, out handle)) throw new IOException("BOUNDARY_CHILD_NOT_CAPTURED");
    Identity(handle, Path.Combine(root, name));
    FileInfo captured = Check(handle);
    // Git for Windows cannot discover a checkout while its directory has an
    // outstanding DELETE-access handle. Read/list pins fence checkout; removal
    // reacquires DELETE access and matches the original native identity before
    // any destructive call. An intervening replacement is never deleted.
    children.Remove(name); handle.Dispose();
    OpenChild(name, false, true);
    handle = children[name];
    FileInfo current = Check(handle);
    if (captured.Volume != current.Volume || captured.IndexHigh != current.IndexHigh || captured.IndexLow != current.IndexLow ||
        captured.Created.Low != current.Created.Low || captured.Created.High != current.Created.High)
      throw new IOException("BOUNDARY_CHILD_IDENTITY_CHANGED");
    // FileDispositionInfo addresses the exact captured object. It rejects a
    // nonempty directory; no recursive/path-based fallback is permitted.
    if (!SetFileInformationByHandle(handle, 4, new byte[] { 1 }, 1)) throw new IOException("BOUNDARY_CHILD_DELETE_DENIED");
    children.Remove(name); handle.Dispose();
  }
  public void Dispose() {
    foreach (SafeFileHandle handle in children.Values) handle.Dispose(); children.Clear();
    List<SafeFileHandle> values = new List<SafeFileHandle>(ancestors.Values);
    for (int i=values.Count-1;i>=0;i--) values[i].Dispose(); ancestors.Clear();
  }
}
'@
$pins = $null
try {
  $first = [Console]::ReadLine() | ConvertFrom-Json
  $pins = [AgentForgeDirectoryPins]::new([string]$first.root)
  @{ ok = $true; identity = $pins.RootIdentity() } | ConvertTo-Json -Compress -Depth 5
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      if ($request.op -eq 'close') { break }
      if ($request.op -eq 'reserve') { $identity = $pins.Child([string]$request.name, $true) }
      elseif ($request.op -eq 'capture') { $identity = $pins.Child([string]$request.name, $false) }
      elseif ($request.op -eq 'delete-empty') { $pins.DeleteEmptyChild([string]$request.name); $identity = $null }
      else { throw 'BOUNDARY_COMMAND_DENIED' }
      @{ ok = $true; identity = $identity } | ConvertTo-Json -Compress -Depth 5
    } catch { @{ ok = $false; error = 'BOUNDARY_OPERATION_DENIED' } | ConvertTo-Json -Compress }
  }
} catch { @{ ok = $false; error = 'BOUNDARY_ACQUIRE_DENIED' } | ConvertTo-Json -Compress }
finally { if ($null -ne $pins) { $pins.Dispose() } }
`;
