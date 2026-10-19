# Drive Health

A local, read-only Windows dashboard for HDD and SSD health. Uses Windows Storage to report physical drive inventory, health status, temperature, rated life used, power-on hours, and uncorrected error counts when supported. No dependencies, accounts, telemetry, or external requests.

## Run

Install Node.js 22.13 or newer (Node.js 24 LTS recommended), then run in this folder:

```powershell
npm.cmd start
```

Open http://127.0.0.1:4317. If Windows denies access to drive information, stop the server and run it again from an administrator terminal. Refresh to rescan. The server binds only to the local computer. Set `PORT` to change its port.

## Reading the results

- **Reported healthy** is the Windows Storage health status, not a prediction or guarantee.
- **Needs attention** indicates a Windows warning/unhealthy status, uncorrected errors, or a wear counter of at least 100%.
- **Health unknown** means no authoritative storage health status was available.
- **Rated life used** is the provider's wear counter, not free space or a calculated health score.
- Unsupported or inaccessible measurements show as unavailable, never as zero. USB bridges, RAID controllers, drivers, and permissions can limit visibility.
- If the Storage provider is unavailable, the app attempts a basic WMI inventory and leaves health unknown.

This does not perform surface tests, modify disks, or provide full vendor SMART attribute decoding. Keep backups regardless of reported health. Drive serial numbers are visible locally in diagnostics.

## Native Windows NVMe readings (no extra installation)

The app now reads NVMe Identify Controller and SMART / Health log 02h through Windows `IOCTL_STORAGE_QUERY_PROPERTY`. Supported NVMe drives can supply power-on hours, lifetime host writes, temperature, and wear without smartmontools. The helper is compiled by built-in PowerShell at scan time; no SDK or compiler installation is required. Run the app from an administrator terminal if access is denied. USB bridges, RAID, and some drivers may not expose this API.

Native readings are checked against the disk serial number, fill missing Windows Storage counters, and retain existing database identities. NVMe 128-bit counters that cannot be represented safely are left unavailable. The reader only queries information and does not modify drive settings. Implementation follows [Microsoft's NVMe query documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/working-with-nvme-devices).

Run native decoder checks with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native.test.ps1`.

## Optional smartmontools fallback

Windows Storage sometimes omits power-on hours even when tools such as Hard Disk Sentinel can read them. The app now tries a read-only `smartctl -a -j` fallback for missing power-on hours, temperature, and NVMe wear. It uses the decoded SMART hours field, not an assumed raw ATA attribute unit. Existing Windows readings and database drive identities are preserved. SMART devices are matched by serial number; missing or ambiguous serials are not matched.

If native queries are unsupported, optionally install the Windows package from [smartmontools](https://www.smartmontools.org/), then stop the app with Ctrl+C and restart it from an administrator PowerShell:

```powershell
cd D:\Github\storage-analyzer
npm.cmd start
```

The standard `C:\Program Files\smartmontools\bin\smartctl.exe` location and PATH are detected. For a custom installation, set `$env:SMARTCTL_PATH = 'D:\Tools\smartctl.exe'` before starting. No SMART tests or drive configuration changes are performed. Controller and driver support can still limit readings. Fallback readings are included in future saved scans; old missing values stay missing.

## Local database and records

Scans are saved to `data/drive-health.sqlite` automatically on each refresh and every five minutes while the Node server is running. Monitoring continues when the browser is closed, but stops when the server is stopped. No Windows service is installed. History begins with the first scan after this update; earlier readings cannot be recovered.

The Drive records section includes disconnected drives, first/last seen dates, all-time average and peak temperatures, wear and error counter changes, and the latest 200 individual readings. Statistics use all saved readings. Missing values are excluded from calculations. Negative counter changes can mean the counter was reset; these are not interpreted as recovery.

Drives are matched using the Windows unique identifier, or model and serial number when unavailable. Without either identifier, the app uses device slot, model, capacity, and bus; a replacement in the same slot may be treated as the same drive. Changing provider or controller can create a separate record.

SQLite is built into Node; no database installation or npm dependencies are required. Some Node releases print an experimental SQLite warning. Data is kept until you remove it. To back it up, stop the server and copy the `data` folder. That folder is excluded from Git and contains hardware identifiers and health history.

Restart your running server after updating the app. If port 4317 is occupied, use `$env:PORT = "4318"` before `npm.cmd start` and open http://127.0.0.1:4318.

Run database tests with `npm.cmd test`.

## Records page

Open Records from the sidebar (or `/records`) to rank all saved drives by most Lifetime Writes, longest power-on time, highest temperature, or most rated life used. Rankings use each drive's highest observed counter across all scans, including disconnected drives, and show when that value was first recorded. Missing counters remain unranked; ties share a rank. Cumulative counters are not summed across scans. Click a drive to open its detailed history on Overview. Refresh records reads the database without triggering a hardware scan.

## Native USB drive models

USB drives are queried with standard SAT-16, then SAT-12 ATA IDENTIFY DEVICE through Windows buffered SCSI pass-through. Run as administrator: Windows requires a read/write handle for this IOCTL, although the app only sends the identification command. No self-tests, sector writes, or settings changes are issued.

The Windows enclosure serial is verified on the same physical-drive handle before accepting the underlying ATA model. The original identity stays unchanged so improved display names do not split saved history. Unsupported bridges retain the Windows model or volume-label fallback; diagnostics show the identification failure. Proprietary bridge protocols are not implemented. This reads identity only, not additional ATA health or writes counters. Each SAT attempt has a four-second command timeout.

Run USB decoder checks with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\ata.test.ps1`.

### Native SATA Lifetime Writes

The native ATA reader now also sends read-only READ LOG EXT for Device Statistics log 04h, General Statistics page 01h. It converts the supported, valid Logical Sectors Written counter into bytes using the drive's IDENTIFY logical sector size (including 4Kn). Normalized, malformed, or unsafe counters are rejected. No model-specific SMART attribute units are assumed. Supported USB/SATA bridges and drives report the result in the existing Lifetime Writes cards, history, and Records rankings. Diagnostics expose a write-counter error when the log or bridge is unsupported. Earlier missing records are not backfilled.

## SMART error tracking

WD and Seagate ATA drives can report raw SMART attributes 5 (reallocated sectors), 197 (pending sectors), 198 (offline uncorrectable sectors), and 199 (communication CRC errors), read through SAT-16/12 SMART READ DATA. The reader validates the data checksum and leaves absent counters unavailable. Other families and NVMe do not use this ATA decoder.

Each card shows totals and changes since the previous available saved reading; the first reading establishes a baseline. Missing scans do not reset the baseline. Increased counters flag attention, as do nonzero sector error counts. Historical CRC totals alone do not flag attention. Decreases are labeled as resets, not recovery. All counters and comparisons are retained in scan history; they do not predict failure or replace backups. Monitoring requires the server to remain running; refresh the overview to see new scans. No SMART enable/settings commands or self-tests are sent.

## Lifetime Writes

Drive cards and saved records display total host writes in decimal TB (1 TB = 1,000,000,000,000 bytes). For NVMe drives, the native reader (or optional smartmontools fallback) reads Data Units Written and multiplies by 512,000 bytes. This is host data written, not internal NAND writes or remaining endurance.

History includes a change since the first available writes reading. Existing records without that counter remain unavailable. Unsupported drives, including ATA devices with vendor-specific write counter units, show unavailable rather than an estimated value. Byte totals beyond JavaScript's safe integer range are also left unavailable.
