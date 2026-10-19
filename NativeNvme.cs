using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using Microsoft.Win32.SafeHandles;

public sealed class NvmeReading {
    public string Serial;
    public string WindowsSerial;
    public long? PowerOnHours;
    public long? LifetimeWritesBytes;
    public int? Temperature;
    public int Wear;
}

public static class NativeNvme {
    const long MaxSafeInteger = 9007199254740991L;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);

    static void Put(byte[] buffer, int offset, uint value) { Array.Copy(BitConverter.GetBytes(value), 0, buffer, offset, 4); }
    static uint Get(byte[] buffer, int offset) { return BitConverter.ToUInt32(buffer, offset); }

    public static string DescriptorSerial(byte[] buffer, int returned) {
        if (buffer == null || returned < 36 || returned > buffer.Length)
            throw new InvalidOperationException("Truncated Windows disk descriptor.");
        uint size = Get(buffer, 4), offset = Get(buffer, 24);
        if (size < 36 || size > returned || offset < 36 || offset >= size)
            throw new InvalidOperationException("Windows disk serial offset unavailable or invalid.");
        int end = (int)offset;
        while (end < size && buffer[end] != 0) end++;
        if (end == size) throw new InvalidOperationException("Unterminated Windows disk serial.");
        return Encoding.ASCII.GetString(buffer, (int)offset, end - (int)offset).Trim();
    }

    public static string ReadWindowsSerial(SafeFileHandle handle) {
        byte[] query = new byte[12]; // StorageDeviceProperty=0, PropertyStandardQuery=0
        byte[] buffer = new byte[4096];
        int returned;
        if (!DeviceIoControl(handle, 0x002D1400, query, query.Length, buffer, buffer.Length, out returned, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return DescriptorSerial(buffer, returned);
    }

    public static bool MatchesIdentity(string expected, NvmeReading reading) {
        if (String.IsNullOrWhiteSpace(expected) || reading == null) return false;
        expected = expected.Trim();
        return String.Equals(expected, reading.Serial, StringComparison.OrdinalIgnoreCase) ||
            String.Equals(expected, reading.WindowsSerial, StringComparison.OrdinalIgnoreCase);
    }

    // IOCTL_STORAGE_QUERY_PROPERTY; no raw reads, writes, or state-changing commands.
    public static byte[] BuildQuery(uint property, uint type, uint request, int length) {
        if ((property != 49 && property != 50) || length < 512 || length > 4096)
            throw new ArgumentException("Invalid NVMe query parameters.");
        byte[] buffer = new byte[48 + length];
        Put(buffer, 0, property); // Adapter=49, Device=50
        Put(buffer, 8, 3); // ProtocolTypeNvme
        Put(buffer, 12, type); // Identify=1, LogPage=2
        Put(buffer, 16, request);
        Put(buffer, 24, 40); // offset relative to protocol-specific structure
        Put(buffer, 28, (uint)length);
        return buffer;
    }

    static byte[] Query(SafeFileHandle handle, uint type, uint request, int length) {
        return QueryWithFallback(type, delegate(uint property) {
            byte[] buffer = BuildQuery(property, type, request, length);
        int returned;
        if (!DeviceIoControl(handle, 0x002D1400, buffer, buffer.Length, buffer, buffer.Length, out returned, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return Extract(buffer, returned, type, length);
        });
    }

    public static byte[] QueryWithFallback(uint type, Func<uint, byte[]> query) {
        // Microsoft's SMART example uses DeviceProtocolSpecificProperty. Some
        // drivers only support adapter queries; Identify Controller prefers adapter.
        uint[] properties = type == 2 ? new uint[] { 50, 49 } : new uint[] { 49, 50 };
        List<string> errors = new List<string>();
        foreach (uint property in properties) {
            try { return query(property); }
            catch (Exception error) {
                Win32Exception win32 = error as Win32Exception;
                errors.Add((type == 1 ? "Identify" : "SMART") + " property " + property + ": " + error.Message +
                    (win32 == null ? "" : " (Win32 " + win32.NativeErrorCode + ")"));
            }
        }
        throw new InvalidOperationException(String.Join("; ", errors.ToArray()));
    }

    public static byte[] Extract(byte[] buffer, int returned, uint type, int length) {
        if (buffer == null || returned < 48 || returned > buffer.Length || Get(buffer, 0) != 48 || Get(buffer, 4) != 48 || Get(buffer, 8) != 3 || Get(buffer, 12) != type)
            throw new InvalidOperationException("Invalid NVMe protocol descriptor.");
        uint offset = Get(buffer, 24), available = Get(buffer, 28);
        if (offset < 40 || available < length || (ulong)8 + offset + available > (ulong)returned)
            throw new InvalidOperationException("Truncated NVMe protocol response.");
        byte[] result = new byte[length];
        Array.Copy(buffer, (long)8 + offset, result, 0, length);
        return result;
    }

    static long? Counter(byte[] log, int offset, long scale) {
        for (int i = 8; i < 16; i++) if (log[offset + i] != 0) return null;
        ulong value = BitConverter.ToUInt64(log, offset);
        if (value > (ulong)(MaxSafeInteger / scale)) return null;
        return (long)value * scale;
    }

    public static NvmeReading Decode(string serial, byte[] log) {
        if (log == null || log.Length != 512) throw new ArgumentException("Expected a 512-byte NVMe health log.");
        int kelvin = log[1] | (log[2] << 8);
        return new NvmeReading {
            Serial = serial.Trim(), PowerOnHours = Counter(log, 128, 1),
            LifetimeWritesBytes = Counter(log, 48, 512000),
            Temperature = kelvin >= 273 ? (int?)(kelvin - 273) : null,
            Wear = log[5]
        };
    }

    public static NvmeReading Read(int diskNumber) {
        if (diskNumber < 0) throw new ArgumentOutOfRangeException("diskNumber");
        List<string> errors = new List<string>();
        foreach (uint access in new uint[] { 0, 0x80000000 }) {
          try {
            using (SafeFileHandle handle = CreateFile(@"\\.\PhysicalDrive" + diskNumber, access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (handle.IsInvalid) {
                int code = Marshal.GetLastWin32Error();
                throw new InvalidOperationException("Open disk: " + new Win32Exception(code).Message + " (Win32 " + code + ")");
            }
            byte[] identify = Query(handle, 1, 1, 4096); // Identify Controller
            string serial = Encoding.ASCII.GetString(identify, 4, 20).Trim(' ', '\0');
            if (serial.Length == 0) throw new InvalidOperationException("NVMe serial number unavailable.");
            NvmeReading reading = Decode(serial, Query(handle, 2, 2, 512)); // SMART / Health log 02h
            // Windows may expose a namespace identifier instead of the controller
            // serial. Read that identity from the exact same physical-drive handle.
            try { reading.WindowsSerial = ReadWindowsSerial(handle); }
            catch (Exception) { /* Controller serial matching remains available. */ }
            return reading;
            }
          } catch (Exception error) {
            errors.Add((access == 0 ? "Metadata access: " : "Read access: ") + error.Message);
          }
        }
        throw new InvalidOperationException(String.Join("; ", errors.ToArray()));
    }
}
