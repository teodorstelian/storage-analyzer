using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class AtaIdentity {
    public string Model;
    public string Serial;
    public string WindowsSerial;
    public int LogicalSectorBytes;
    public long? LifetimeWritesBytes;
    public string WritesReadError;
    public Dictionary<string, long> SmartErrors;
    public string SmartReadError;
}

public static class NativeAta {
    [StructLayout(LayoutKind.Sequential)]
    struct ScsiPassThrough {
        public ushort Length;
        public byte ScsiStatus, PathId, TargetId, Lun, CdbLength, SenseInfoLength, DataIn;
        public uint DataTransferLength, TimeOutValue;
        public UIntPtr DataBufferOffset;
        public uint SenseInfoOffset;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] Cdb;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);

    public static byte[] IdentifyCdb(int length) {
        byte[] cdb = new byte[16];
        cdb[1] = 8; // PIO data-in protocol; no extend
        cdb[2] = 14; // data-in, blocks, length in sector count; no CK_COND
        if (length == 16) { cdb[0] = 0x85; cdb[6] = 1; cdb[14] = 0xEC; }
        else if (length == 12) { cdb[0] = 0xA1; cdb[4] = 1; cdb[9] = 0xEC; }
        else throw new ArgumentException("Only SAT-12 and SAT-16 are supported.");
        return cdb;
    }

    static string AtaString(byte[] data, int offset, int length) {
        byte[] text = new byte[length];
        for (int i = 0; i < length; i += 2) { text[i] = data[offset + i + 1]; text[i + 1] = data[offset + i]; }
        foreach (byte value in text) if (value != 0 && (value < 32 || value > 126)) throw new InvalidOperationException("Invalid ATA identity string.");
        return Encoding.ASCII.GetString(text).Trim(' ', '\0');
    }

    public static AtaIdentity Decode(byte[] data) {
        if (data == null || data.Length != 512 || (data[0] == 0 && data[1] == 0) || (data[0] == 255 && data[1] == 255))
            throw new InvalidOperationException("Invalid ATA Identify response.");
        string model = AtaString(data, 54, 40), serial = AtaString(data, 20, 20);
        if (model.Length == 0) throw new InvalidOperationException("ATA model was empty.");
        int sectorBytes = 512;
        ushort info = BitConverter.ToUInt16(data, 212); // IDENTIFY word 106
        if ((info & 0xC000) == 0x4000 && (info & 0x1000) != 0) {
            uint words = BitConverter.ToUInt32(data, 234); // words 117-118
            if (words <= 256 || words > 1048576) throw new InvalidOperationException("Invalid ATA logical sector size.");
            sectorBytes = (int)words * 2;
        }
        return new AtaIdentity { Model = model, Serial = serial, LogicalSectorBytes = sectorBytes };
    }

    static byte[] Transfer(SafeFileHandle handle, byte[] cdb, int cdbLength) {
        int header = Marshal.SizeOf(typeof(ScsiPassThrough));
        int dataOffset = (header + 32 + 7) & ~7;
        byte[] buffer = new byte[dataOffset + 512];
        ScsiPassThrough request = new ScsiPassThrough {
            Length = (ushort)header, CdbLength = (byte)cdbLength, SenseInfoLength = 32,
            DataIn = 1, DataTransferLength = 512, TimeOutValue = 4,
            DataBufferOffset = new UIntPtr((uint)dataOffset), SenseInfoOffset = (uint)header,
            Cdb = cdb
        };
        IntPtr memory = Marshal.AllocHGlobal(header);
        try { Marshal.StructureToPtr(request, memory, false); Marshal.Copy(memory, buffer, 0, header); }
        finally { Marshal.FreeHGlobal(memory); }
        int returned;
        // Read-only ATA Identify or Device Statistics via buffered SAT.
        if (!DeviceIoControl(handle, 0x0004D004, buffer, buffer.Length, buffer, buffer.Length, out returned, IntPtr.Zero)) {
            int code = Marshal.GetLastWin32Error();
            throw new InvalidOperationException(new Win32Exception(code).Message + " (Win32 " + code + ")");
        }
        if (returned < dataOffset + 512 || buffer[2] != 0 || BitConverter.ToUInt32(buffer, 12) != 512) {
            byte[] sense = new byte[Math.Max(0, Math.Min(32, returned - header))];
            Array.Copy(buffer, header, sense, 0, sense.Length);
            throw new InvalidOperationException("ATA " + (cdb[cdbLength == 16 ? 14 : 9] == 0xEC ? "Identify" : "Device Statistics") +
                " via SAT-" + cdbLength + " failed (SCSI status " + buffer[2] + "). " + SenseDescription(sense));
        }
        byte[] identify = new byte[512]; Array.Copy(buffer, dataOffset, identify, 0, 512);
        return identify;
    }

    public static string SenseDescription(byte[] sense) {
        if (sense == null || sense.Length < 4) return "No SCSI sense details returned.";
        int response = sense[0] & 0x7F, key, asc, ascq;
        if ((response == 0x70 || response == 0x71) && sense.Length >= 14 && sense[7] >= 6) {
            key = sense[2] & 15; asc = sense[12]; ascq = sense[13];
        } else if (response == 0x72 || response == 0x73) {
            key = sense[1] & 15; asc = sense[2]; ascq = sense[3];
        } else return "No recognized SCSI sense details returned.";
        string meaning = "The device returned an error; these codes do not establish whether the bridge or drive rejected the request.";
        if (key == 5 && asc == 0x20) meaning = "Unsupported command reported by the drive or USB bridge.";
        else if (key == 5 && asc == 0x24) meaning = "Invalid command field reported by the drive or USB bridge.";
        else if (key == 5 && asc == 0x21) meaning = "Requested log address is outside the supported range.";
        else if (key == 2) meaning = "Device is not ready.";
        else if (key == 0xB) meaning = "Command was aborted by the device or transport.";
        return String.Format("Sense key 0x{0:X2}, ASC 0x{1:X2}, ASCQ 0x{2:X2}. {3}", key, asc, ascq, meaning);
    }

    public static byte[] WritesCdb() {
        byte[] cdb = IdentifyCdb(16);
        cdb[1] = 9; // PIO data-in, 48-bit EXTEND
        cdb[8] = 4; // Device Statistics log address
        cdb[10] = 1; // General Statistics page
        cdb[14] = 0x2F; // READ LOG EXT
        return cdb;
    }

    public static byte[] SmartCdb(int length) {
        byte[] cdb = IdentifyCdb(length);
        if (length == 16) { cdb[4] = 0xD0; cdb[10] = 0x4F; cdb[12] = 0xC2; cdb[14] = 0xB0; }
        else { cdb[3] = 0xD0; cdb[6] = 0x4F; cdb[7] = 0xC2; cdb[9] = 0xB0; }
        return cdb;
    }

    public static Dictionary<string, long> DecodeSmartErrors(byte[] data, string model) {
        if (data == null || data.Length != 512) throw new InvalidOperationException("Truncated SMART data.");
        int sum = 0; foreach (byte b in data) sum += b;
        if ((sum & 255) != 0 || BitConverter.ToUInt16(data, 0) == 0)
            throw new InvalidOperationException("Invalid SMART revision or checksum.");
        // Attribute meanings/raw encodings are vendor-specific. Only use the
        // conventional counters on the WD/Seagate ATA families supported here.
        if (String.IsNullOrEmpty(model) || !(model.StartsWith("WDC ", StringComparison.OrdinalIgnoreCase) || model.StartsWith("WD", StringComparison.OrdinalIgnoreCase) || model.StartsWith("ST", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("SMART raw-counter decoding is not defined for this drive family.");
        Dictionary<int, string> ids = new Dictionary<int, string> { { 5, "reallocatedSectors" }, { 197, "pendingSectors" }, { 198, "uncorrectableSectors" }, { 199, "crcErrors" } };
        Dictionary<string, long> result = new Dictionary<string, long>();
        for (int offset = 2; offset + 12 <= 362; offset += 12) {
            string key;
            if (!ids.TryGetValue(data[offset], out key)) continue;
            if (result.ContainsKey(key)) throw new InvalidOperationException("Duplicate SMART counter.");
            long value = 0;
            for (int i = 0; i < 6; i++) value |= (long)data[offset + 5 + i] << (8 * i);
            result.Add(key, value);
        }
        return result;
    }

    public static long DecodeWrites(byte[] log, int sectorBytes) {
        if (log == null || log.Length != 512 || log[0] != 1 || log[1] != 0 || log[2] != 1)
            throw new InvalidOperationException("Invalid ATA General Statistics page.");
        // Logical Sectors Written at 0x18: supported/valid bits, no normalized values.
        byte flags = log[31];
        if ((flags & 0xC0) != 0xC0 || (flags & 0x20) != 0)
            throw new InvalidOperationException("ATA lifetime write counter is unsupported, invalid, or normalized.");
        ulong sectors = BitConverter.ToUInt64(log, 24) & 0x0000FFFFFFFFFFFFUL;
        if (sectorBytes < 512 || sectors > (ulong)(9007199254740991L / sectorBytes))
            throw new InvalidOperationException("ATA lifetime writes exceeds the supported numeric range.");
        return (long)sectors * sectorBytes;
    }

    public static AtaIdentity Read(int diskNumber, string expectedWindowsSerial) {
        if (diskNumber < 0 || String.IsNullOrWhiteSpace(expectedWindowsSerial)) throw new ArgumentException("Disk identity is required.");
        // Windows requires read/write handle access for this IOCTL; no write commands are issued.
        using (SafeFileHandle handle = CreateFile(@"\\.\PhysicalDrive" + diskNumber, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            string windowsSerial = NativeNvme.ReadWindowsSerial(handle);
            if (!String.Equals(windowsSerial, expectedWindowsSerial.Trim(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("USB physical-drive identity changed; model was not attached.");
            List<string> errors = new List<string>();
            foreach (int length in new int[] { 16, 12 }) {
                try {
                    AtaIdentity identity = Decode(Transfer(handle, IdentifyCdb(length), length));
                    identity.WindowsSerial = windowsSerial;
                    try { identity.LifetimeWritesBytes = DecodeWrites(Transfer(handle, WritesCdb(), 16), identity.LogicalSectorBytes); }
                    catch (Exception error) { identity.WritesReadError = error.Message; }
                    List<string> smartErrors = new List<string>();
                    foreach (int smartLength in new int[] { length, length == 16 ? 12 : 16 }) {
                        try { identity.SmartErrors = DecodeSmartErrors(Transfer(handle, SmartCdb(smartLength), smartLength), identity.Model); break; }
                        catch (Exception error) { smartErrors.Add("SAT-" + smartLength + ": " + error.Message); }
                    }
                    if (identity.SmartErrors == null) identity.SmartReadError = String.Join("; ", smartErrors.ToArray());
                    return identity;
                }
                catch (Exception error) { errors.Add("SAT-" + length + ": " + error.Message); }
            }
            throw new InvalidOperationException(String.Join("; ", errors.ToArray()));
        }
    }
}
