// Run this repository-owned program through the fixed Windows PowerShell binary.
// Paths and commands arrive as JSON on stdin, never as executable shell text.
// These are kernel primitives; the service must also fence Git metadata and
// ownership before admitting a complete worktree mutation.
export const WINDOWS_DIRECTORY_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = [Console]::ReadLine() | ConvertFrom-Json
& ([scriptblock]::Create([string]$source))
`;

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
  [DllImport("ntdll.dll")]
  static extern int NtQueryDirectoryFile(SafeFileHandle handle, IntPtr evt, IntPtr apc, IntPtr context,
    out IoStatus status, IntPtr data, uint length, int kind, [MarshalAs(UnmanagedType.U1)] bool single,
    IntPtr filter, [MarshalAs(UnmanagedType.U1)] bool restart);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(SafeFileHandle handle, byte[] data, uint length, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadFile(SafeFileHandle handle, byte[] data, uint length, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long position, uint method);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle handle);

  readonly Dictionary<string, SafeFileHandle> ancestors = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  readonly Dictionary<string, SafeFileHandle> children = new Dictionary<string, SafeFileHandle>(StringComparer.Ordinal);
  sealed class Node {
    public SafeFileHandle Handle;
    public FileInfo Captured;
    public string Key, Name, Parent;
    public bool Directory, Writable;
    public long Written;
  }
  readonly Dictionary<string, Node> nodes = new Dictionary<string, Node>(StringComparer.OrdinalIgnoreCase);
  readonly HashSet<string> sealedTrees = new HashSet<string>(StringComparer.Ordinal);
  SafeFileHandle operationLock;
  const int MaxNodes = 65536;
  readonly string root;
  public AgentForgeDirectoryPins(string managedRoot, bool initialize, string anchor, string anchorId, string anchorCreated) {
    // .NET Framework GetFullPath expands existing DOS short names. Preserve
    // the raw segments so the checked anchor is matched at its captured
    // handle before any missing child is created; normalize from handles.
    root = (managedRoot ?? "").TrimEnd('\\');
    if (root.Length < 4 || root.Length > 2048 || !Char.IsLetter(root[0]) || root[1] != ':' || root[2] != '\\' ||
        root.StartsWith("\\\\") || root.IndexOf(':',2) >= 0 || root.IndexOf('/') >= 0)
      throw new IOException("UNSUPPORTED_MUTATION_BOUNDARY");
    try {
      string current = Path.GetPathRoot(root);
      string requested = root, raw = current;
      bool anchorMatched = false;
      PinAncestor(current);
      Action<string, SafeFileHandle> matchAnchor = (candidate, handle) => {
        if (String.Equals(candidate.TrimEnd('\\'), (anchor ?? "").TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) {
          FileInfo info = Check(handle);
          if ((((ulong)info.IndexHigh << 32) | info.IndexLow).ToString() != anchorId ||
              (((ulong)info.Created.High << 32) | info.Created.Low).ToString() != anchorCreated)
            throw new IOException("BOUNDARY_ANCHOR_IDENTITY_CHANGED");
          anchorMatched = true;
        }
      };
      matchAnchor(raw, ancestors[current]);
      foreach (string part in requested.Substring(current.Length).Split('\\')) {
        SafeFileHandle parent = ancestors[current];
        raw = Path.Combine(raw, part);
        SafeFileHandle handle = null;
        try {
          try { handle = Relative(parent, part, true, false, false, false); }
          catch { if (!initialize || !anchorMatched) throw; handle = Relative(parent, part, true, true, false, false); }
          string next = FinalPath(handle);
          Identity(handle, next); ancestors.Add(next, handle); handle = null;
          matchAnchor(raw, ancestors[next]);
          current = next;
        } finally { if (handle != null) handle.Dispose(); }
      }
      if (initialize && !anchorMatched) throw new IOException("BOUNDARY_ANCHOR_IDENTITY_MISSING");
      root = current;
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
  static string FinalPath(SafeFileHandle handle) {
    StringBuilder text = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, text, (uint)text.Capacity, 0);
    if (length == 0 || length >= text.Capacity) throw new IOException("BOUNDARY_IDENTITY_UNAVAILABLE");
    string final = text.ToString();
    if (final.StartsWith("\\\\?\\")) final = final.Substring(4);
    return final.TrimEnd('\\');
  }
  public static object Identity(SafeFileHandle handle, string expected) {
    FileInfo info = Check(handle);
    string final = FinalPath(handle);
    if (!String.Equals(final.TrimEnd('\\'), Path.GetFullPath(expected).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
      throw new IOException("BOUNDARY_PATH_IDENTITY_CHANGED");
    return new { volume = info.Volume.ToString(), fileId = (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString(),
      created = (((ulong)info.Created.High << 32) | info.Created.Low).ToString() };
  }
  public object RootIdentity() { return Identity(ancestors[root], root); }
  public string RootPath { get { return root; } }
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
      nodes.Add(name, new Node { Handle = children[name], Captured = Check(children[name]), Key = name, Name = name, Directory = true });
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
    nodes.Remove(name);
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
    nodes.Remove(name);
  }

  static void Segment(string value) {
    if (String.IsNullOrEmpty(value) || value.Length > 255 || value == "." || value == ".." ||
        value.EndsWith(".") || value.EndsWith(" ") || value.IndexOfAny(new char[] {'\\','/',':','*','?','"','<','>','|'}) >= 0)
      throw new IOException("BOUNDARY_SEGMENT_DENIED");
    foreach (char c in value) if (c < 32 || c == 127) throw new IOException("BOUNDARY_SEGMENT_DENIED");
    string stem = value.Split('.')[0].ToUpperInvariant();
    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
        System.Text.RegularExpressions.Regex.IsMatch(stem, "\\A(COM|LPT)[0-9¹²³]\\z"))
      throw new IOException("BOUNDARY_SEGMENT_DENIED");
  }
  static FileInfo ObjectInfo(SafeFileHandle handle, bool directory) {
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 ||
        ((info.Attributes & 0x10) != 0) != directory || info.Volume == 0 || (info.IndexHigh == 0 && info.IndexLow == 0))
      throw new IOException("BOUNDARY_REPARSE_OR_IDENTITY_DENIED");
    return info;
  }
  static bool Same(FileInfo a, FileInfo b) {
    return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow &&
      a.Created.Low == b.Created.Low && a.Created.High == b.Created.High;
  }
  static SafeFileHandle Relative(SafeFileHandle parent, string name, bool directory, bool create, bool deleting, bool writable,
      uint share = 1, bool openIf = false) {
    Segment(name);
    IntPtr buffer = IntPtr.Zero, unicode = IntPtr.Zero;
    SafeFileHandle handle = null;
    try {
      buffer = Marshal.StringToHGlobalUni(name);
      UnicodeString value = new UnicodeString { Length = checked((ushort)(name.Length*2)), MaximumLength = checked((ushort)((name.Length+1)*2)), Buffer = buffer };
      unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
      Marshal.StructureToPtr(value, unicode, false);
      ObjectAttributes attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)), Root = parent.DangerousGetHandle(), Name = unicode, Attributes = 0x40 };
      IoStatus status;
      uint access = 0x100081u | (deleting ? 0x10000u : 0u) | (writable ? 0x2u : 0u);
      int result = NtCreateFile(out handle, access, ref attributes, out status, IntPtr.Zero,
        directory ? 0x10u : 0x80u, share, openIf ? 3u : create ? 2u : 1u, 0x200020u | (directory ? 1u : 0x40u), IntPtr.Zero, 0);
      if (result < 0 || handle == null || handle.IsInvalid) throw new IOException("BOUNDARY_OBJECT_OPEN_DENIED_" + unchecked((uint)result).ToString("X8"));
      ObjectInfo(handle, directory);
      SafeFileHandle answer = handle; handle = null; return answer;
    } finally {
      if (handle != null) handle.Dispose();
      if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
    }
  }
  Node Top(string child) {
    Name(child); RootIdentity();
    Node top;
    if (!nodes.TryGetValue(child, out top) || !children.ContainsKey(child)) throw new IOException("BOUNDARY_CHILD_NOT_CAPTURED");
    if (!Same(top.Captured, ObjectInfo(top.Handle, true))) throw new IOException("BOUNDARY_CHILD_IDENTITY_CHANGED");
    return top;
  }
  string Key(string child, string relative) {
    Top(child);
    if (String.IsNullOrEmpty(relative) || relative.Length > 30000) throw new IOException("BOUNDARY_SEGMENT_DENIED");
    foreach (string part in relative.Split('/')) Segment(part);
    return child + "/" + relative;
  }
  Node Parent(string key) {
    int split = key.LastIndexOf('/');
    Node parent;
    if (split < 0 || !nodes.TryGetValue(key.Substring(0, split), out parent) || !parent.Directory ||
        !Same(parent.Captured, ObjectInfo(parent.Handle, true))) throw new IOException("BOUNDARY_PARENT_NOT_CAPTURED");
    return parent;
  }
  Node Add(string key, Node parent, string name, bool directory, bool create) {
    if (nodes.Count >= MaxNodes || nodes.ContainsKey(key)) throw new IOException("BOUNDARY_OBJECT_ALREADY_CAPTURED_OR_LIMIT");
    SafeFileHandle handle = Relative(parent.Handle, name, directory, create, false, create && !directory);
    try {
      Node node = new Node { Handle = handle, Captured = ObjectInfo(handle, directory), Key = key,
        Parent = parent.Key, Name = name, Directory = directory, Writable = create && !directory };
      if (node.Captured.Volume != parent.Captured.Volume) throw new IOException("BOUNDARY_VOLUME_CHANGED");
      nodes.Add(key, node); handle = null; return node;
    } finally { if (handle != null) handle.Dispose(); }
  }
  public void CreateObject(string child, string relative, bool directory) {
    string key = Key(child, relative);
    if (sealedTrees.Contains(child)) throw new IOException("BOUNDARY_TREE_SEALED");
    Node parent = Parent(key);
    Add(key, parent, key.Substring(key.LastIndexOf('/')+1), directory, true);
  }
  public void Append(string child, string relative, string encoded) {
    string key = Key(child, relative); Node node;
    if (!nodes.TryGetValue(key, out node) || node.Directory || !node.Writable || sealedTrees.Contains(child))
      throw new IOException("BOUNDARY_FILE_NOT_CREATED");
    ObjectInfo(node.Handle, false);
    if (encoded == null || encoded.Length > 12000) throw new IOException("BOUNDARY_WRITE_LIMIT");
    byte[] data = Convert.FromBase64String(encoded);
    uint written;
    if (data.Length > 8192 || !WriteFile(node.Handle, data, (uint)data.Length, out written, IntPtr.Zero) || written != data.Length)
      throw new IOException("BOUNDARY_FILE_WRITE_DENIED");
    node.Written += data.Length;
  }
  public void Finish(string child, string relative, long expected) {
    string key = Key(child, relative); Node node;
    if (!nodes.TryGetValue(key, out node) || !node.Writable || node.Written != expected || !FlushFileBuffers(node.Handle))
      throw new IOException("BOUNDARY_FILE_INCOMPLETE");
    FileInfo captured = ObjectInfo(node.Handle, false);
    node.Handle.Dispose(); node.Handle = null;
    node.Handle = Relative(nodes[node.Parent].Handle, node.Name, false, false, false, false);
    if (!Same(captured, ObjectInfo(node.Handle, false))) throw new IOException("BOUNDARY_FILE_IDENTITY_CHANGED");
    node.Writable = false;
  }
  List<string> Names(SafeFileHandle handle) {
    List<string> names = new List<string>();
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool restart = true;
      for (;;) {
        IoStatus status;
        // FileDirectoryInformation: filename length at byte 60, UTF-16 name
        // at byte 64. This enumerates the captured object, never a path alias.
        int result = NtQueryDirectoryFile(handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out status,
          buffer, 65536, 1, false, IntPtr.Zero, restart);
        restart = false;
        if (result == unchecked((int)0x80000006)) break;
        long bytes = status.Information.ToInt64();
        if (result < 0 || bytes < 64 || bytes > 65536) throw new IOException("BOUNDARY_ENUMERATION_DENIED");
        int offset = 0;
        for (;;) {
          if (offset < 0 || offset+64 > bytes) throw new IOException("BOUNDARY_ENUMERATION_INVALID");
          int next = Marshal.ReadInt32(buffer, offset), length = Marshal.ReadInt32(buffer, offset+60);
          if (length < 0 || length > 510 || (length & 1) != 0 || offset+64+length > bytes)
            throw new IOException("BOUNDARY_ENUMERATION_INVALID");
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset+64), length/2);
          if (name != "." && name != "..") { Segment(name); names.Add(name); }
          if (names.Count > MaxNodes) throw new IOException("BOUNDARY_TREE_LIMIT");
          if (next == 0) break;
          if (next < 64 || offset+next >= bytes) throw new IOException("BOUNDARY_ENUMERATION_INVALID");
          offset += next;
        }
      }
      return names;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  void CaptureDescendants(Node parent, int depth) {
    if (depth > 256) throw new IOException("BOUNDARY_DEPTH_LIMIT");
    foreach (string name in Names(parent.Handle)) {
      string key = parent.Key + "/" + name; Node node;
      if (!nodes.TryGetValue(key, out node)) {
        // Determine type with a no-follow handle. A failed directory open may
        // be a regular file, but neither attempt follows a reparse point.
        try { node = Add(key, parent, name, true, false); }
        catch { node = Add(key, parent, name, false, false); }
      }
      if (!Same(node.Captured, ObjectInfo(node.Handle, node.Directory)) || node.Writable)
        throw new IOException("BOUNDARY_OBJECT_IDENTITY_CHANGED");
      if (node.Directory) CaptureDescendants(node, depth+1);
    }
  }
  public void SealTree(string child) {
    Node top = Top(child);
    CaptureDescendants(top, 0);
    sealedTrees.Add(child);
  }
  public string ReadCaptured(string child, string relative) {
    string key = Key(child, relative); Node node;
    if (!sealedTrees.Contains(child) || !nodes.TryGetValue(key, out node) || node.Directory || node.Writable)
      throw new IOException("BOUNDARY_READ_NOT_CAPTURED");
    FileInfo info = ObjectInfo(node.Handle, false);
    if (!Same(node.Captured, info) || info.SizeHigh != 0 || info.SizeLow > 8192) throw new IOException("BOUNDARY_READ_LIMIT_OR_IDENTITY");
    byte[] data = new byte[info.SizeLow]; uint read; long position;
    if (!SetFilePointerEx(node.Handle, 0, out position, 0) ||
        !ReadFile(node.Handle, data, info.SizeLow, out read, IntPtr.Zero) || read != info.SizeLow)
      throw new IOException("BOUNDARY_CAPTURED_READ_DENIED");
    if (!Same(info, ObjectInfo(node.Handle, false))) throw new IOException("BOUNDARY_READ_IDENTITY_CHANGED");
    return Convert.ToBase64String(data);
  }
  public string HashCaptured(string child, string relative) {
    string key = Key(child, relative); Node node;
    if (!sealedTrees.Contains(child) || !nodes.TryGetValue(key, out node) || node.Directory || node.Writable)
      throw new IOException("BOUNDARY_HASH_NOT_CAPTURED");
    FileInfo info = ObjectInfo(node.Handle, false);
    if (!Same(node.Captured, info) || info.SizeHigh != 0 || info.SizeLow > 67108864)
      throw new IOException("BOUNDARY_HASH_LIMIT_OR_IDENTITY");
    long position;
    if (!SetFilePointerEx(node.Handle, 0, out position, 0)) throw new IOException("BOUNDARY_HASH_READ_DENIED");
    using (var hash = System.Security.Cryptography.SHA256.Create()) {
      byte[] buffer = new byte[8192]; uint remaining = info.SizeLow;
      while (remaining > 0) {
        uint amount = Math.Min(remaining, (uint)buffer.Length), read;
        if (!ReadFile(node.Handle, buffer, amount, out read, IntPtr.Zero) || read != amount)
          throw new IOException("BOUNDARY_HASH_READ_DENIED");
        hash.TransformBlock(buffer, 0, (int)read, buffer, 0); remaining -= read;
      }
      hash.TransformFinalBlock(new byte[0], 0, 0);
      FileInfo after = ObjectInfo(node.Handle, false);
      if (!Same(info, after) || after.SizeHigh != info.SizeHigh || after.SizeLow != info.SizeLow)
        throw new IOException("BOUNDARY_HASH_IDENTITY_CHANGED");
      return BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
    }
  }
  public string ShapeCaptured(string child) {
    Top(child);
    if (!sealedTrees.Contains(child)) throw new IOException("BOUNDARY_SHAPE_NOT_SEALED");
    string prefix = child + "/";
    List<string> shape = new List<string>();
    foreach (Node node in nodes.Values) {
      if (!node.Key.StartsWith(prefix, StringComparison.Ordinal)) continue;
      if (!Same(node.Captured, ObjectInfo(node.Handle, node.Directory)) || node.Writable)
        throw new IOException("BOUNDARY_SHAPE_IDENTITY_CHANGED");
      shape.Add((node.Directory ? "D:" : "F:") + node.Key.Substring(prefix.Length));
    }
    shape.Sort(StringComparer.Ordinal);
    using (var hash = System.Security.Cryptography.SHA256.Create()) {
      byte[] data = Encoding.UTF8.GetBytes(String.Join(((char)0).ToString(), shape) + (char)0);
      return BitConverter.ToString(hash.ComputeHash(data)).Replace("-", "").ToLowerInvariant();
    }
  }
  public string AcquireOperationLock() {
    RootIdentity();
    if (operationLock != null) throw new IOException("BOUNDARY_OPERATION_ALREADY_HELD");
    operationLock = Relative(ancestors[root], ".agent-forge-worktree-operation.lock", false, false, true, true, 0, true);
    try {
      FileInfo info = ObjectInfo(operationLock, false);
      if (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 8192) throw new IOException("BOUNDARY_OPERATION_METADATA_DENIED");
      byte[] data = new byte[info.SizeLow]; uint read;
      if (!ReadFile(operationLock, data, info.SizeLow, out read, IntPtr.Zero) || read != info.SizeLow)
        throw new IOException("BOUNDARY_OPERATION_METADATA_DENIED");
      return Convert.ToBase64String(data);
    } catch { operationLock.Dispose(); operationLock = null; throw; }
  }
  public void ClaimOperationLock(string encoded) {
    RootIdentity();
    if (operationLock == null || encoded == null || encoded.Length > 4096) throw new IOException("BOUNDARY_OPERATION_NOT_HELD");
    FileInfo info = ObjectInfo(operationLock, false);
    if (info.Links != 1) throw new IOException("BOUNDARY_OPERATION_METADATA_DENIED");
    byte[] data = Convert.FromBase64String(encoded); uint written; long position;
    if (!SetFilePointerEx(operationLock, 0, out position, 0) ||
        !WriteFile(operationLock, data, (uint)data.Length, out written, IntPtr.Zero) || written != data.Length ||
        !SetEndOfFile(operationLock) || !FlushFileBuffers(operationLock) ||
        !SetFileInformationByHandle(operationLock, 4, new byte[] { 1 }, 1)) throw new IOException("BOUNDARY_OPERATION_CLAIM_DENIED");
    // The captured exclusive handle is the actual lease. Delete-on-close
    // releases it on normal exit or crash; age never breaks a live owner.
  }
  public void ReleaseOperationLock() {
    if (operationLock != null) { operationLock.Dispose(); operationLock = null; }
  }
  public void DeleteTree(string child) {
    Node top = Top(child);
    if (!sealedTrees.Contains(child)) throw new IOException("BOUNDARY_TREE_NOT_SEALED");
    List<Node> tree = new List<Node>();
    foreach (Node node in nodes.Values) if (node.Key == child || node.Key.StartsWith(child + "/", StringComparison.OrdinalIgnoreCase)) tree.Add(node);
    tree.Sort((a,b) => a.Key.Length.CompareTo(b.Key.Length));
    Dictionary<string, HashSet<string>> membership = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
    foreach (Node node in tree) if (node.Directory) membership.Add(node.Key, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
    foreach (Node node in tree) if (node.Parent != null) membership[node.Parent].Add(node.Name);
    Action checkMembership = () => {
      foreach (Node node in tree) if (node.Directory) {
        if (!membership[node.Key].SetEquals(Names(node.Handle))) throw new IOException("BOUNDARY_TREE_MEMBERSHIP_CHANGED");
      }
    };
    checkMembership();
    // Acquire and compare every DELETE handle before deleting any object.
    // Failure leaves a fenced tree; replacements are never deleted.
    foreach (Node node in tree) {
      FileInfo expected = ObjectInfo(node.Handle, node.Directory);
      node.Handle.Dispose(); node.Handle = null;
      SafeFileHandle parent = node.Parent == null ? ancestors[root] : nodes[node.Parent].Handle;
      node.Handle = Relative(parent, node.Name, node.Directory, false, true, false);
      if (node.Parent == null) children[child] = node.Handle;
      if (!Same(expected, ObjectInfo(node.Handle, node.Directory)) || !Same(node.Captured, expected))
        throw new IOException("BOUNDARY_DELETE_IDENTITY_CHANGED");
    }
    foreach (Node node in tree) ObjectInfo(node.Handle, node.Directory);
    checkMembership();
    // Child-first captured-handle disposition cannot follow even a reparse
    // conversion occurring after the final check. New children cause the
    // directory disposition to fail, never a recursive path fallback.
    for (int i=tree.Count-1;i>=0;i--) {
      Node node = tree[i];
      if (!SetFileInformationByHandle(node.Handle, 21, BitConverter.GetBytes(0x11u), 4))
        throw new IOException("BOUNDARY_CAPTURED_DELETE_DENIED");
      node.Handle.Dispose(); nodes.Remove(node.Key);
      if (node.Parent == null) children.Remove(child);
    }
    sealedTrees.Remove(child);
  }
  public void Dispose() {
    ReleaseOperationLock();
    foreach (Node node in nodes.Values) if (node.Handle != null) node.Handle.Dispose(); nodes.Clear(); children.Clear();
    List<SafeFileHandle> values = new List<SafeFileHandle>(ancestors.Values);
    for (int i=values.Count-1;i>=0;i--) values[i].Dispose(); ancestors.Clear();
  }
}
'@
$pins = $null
try {
  $first = [Console]::ReadLine() | ConvertFrom-Json
  $pins = [AgentForgeDirectoryPins]::new([string]$first.root, ($first.initialize -eq '1'), [string]$first.anchor, [string]$first.anchorId, [string]$first.anchorCreated)
  @{ ok = $true; identity = $pins.RootIdentity(); root = $pins.RootPath } | ConvertTo-Json -Compress -Depth 5
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      $data = $null
      if ($request.op -eq 'close') { break }
      if ($request.op -eq 'reserve') { $identity = $pins.Child([string]$request.name, $true) }
      elseif ($request.op -eq 'capture') { $identity = $pins.Child([string]$request.name, $false) }
      elseif ($request.op -eq 'delete-empty') { $pins.DeleteEmptyChild([string]$request.name); $identity = $null }
      elseif ($request.op -eq 'mkdir') { $pins.CreateObject([string]$request.name, [string]$request.path, $true); $identity = $null }
      elseif ($request.op -eq 'file') { $pins.CreateObject([string]$request.name, [string]$request.path, $false); $identity = $null }
      elseif ($request.op -eq 'append') { $pins.Append([string]$request.name, [string]$request.path, [string]$request.data); $identity = $null }
      elseif ($request.op -eq 'finish') { $pins.Finish([string]$request.name, [string]$request.path, [long]$request.length); $identity = $null }
      elseif ($request.op -eq 'seal') { $pins.SealTree([string]$request.name); $identity = $null }
      elseif ($request.op -eq 'delete-tree') { $pins.DeleteTree([string]$request.name); $identity = $null }
      elseif ($request.op -eq 'read') { $data = $pins.ReadCaptured([string]$request.name, [string]$request.path); $identity = $null }
      elseif ($request.op -eq 'hash') { $data = $pins.HashCaptured([string]$request.name, [string]$request.path); $identity = $null }
      elseif ($request.op -eq 'shape') { $data = $pins.ShapeCaptured([string]$request.name); $identity = $null }
      elseif ($request.op -eq 'operation-acquire') { $data = $pins.AcquireOperationLock(); $identity = $null }
      elseif ($request.op -eq 'operation-claim') { $pins.ClaimOperationLock([string]$request.data); $identity = $null }
      elseif ($request.op -eq 'operation-release') { $pins.ReleaseOperationLock(); $identity = $null }
      else { throw 'BOUNDARY_COMMAND_DENIED' }
      @{ ok = $true; identity = $identity; data = $data } | ConvertTo-Json -Compress -Depth 5
    } catch {
      $reason = $_.Exception.GetBaseException().Message
      if ($reason -notmatch '^BOUNDARY_[A-Z0-9_]{1,80}$' -and $reason -ne 'UNSUPPORTED_MUTATION_BOUNDARY') { $reason = 'BOUNDARY_OPERATION_DENIED' }
      @{ ok = $false; error = $reason } | ConvertTo-Json -Compress
    }
  }
} catch {
  $reason = $_.Exception.GetBaseException().Message
  if ($reason -notmatch '^BOUNDARY_[A-Z0-9_]{1,80}$' -and $reason -ne 'UNSUPPORTED_MUTATION_BOUNDARY') { $reason = 'BOUNDARY_ACQUIRE_DENIED' }
  @{ ok = $false; error = $reason } | ConvertTo-Json -Compress
}
finally { if ($null -ne $pins) { $pins.Dispose() } }
`;
