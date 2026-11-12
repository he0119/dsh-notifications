/** Fixed .NET Framework GUI launcher for protocol activation, plus its PE contract helpers. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { NOTIFICATION_ACTIVATION_PATH, NOTIFICATION_PROTOCOL } from './scripts.ts'

export const LAUNCHER_SOURCE_VERSION = 'v2'
export const LAUNCHER_DIRECTORY_NAME = 'v2'
export const LAUNCHER_EXECUTABLE_NAME = 'activate.exe'
export const LAUNCHER_SOURCE_NAME = 'activate.cs'
export const LAUNCHER_HASH_NAME = 'activate.sha256'
export const WINDOWS_SUBSYSTEM_GUI = 2
export const WINDOWS_SUBSYSTEM_CUI = 3

const sourceTemplate = String.raw`/** Dsh Tools notification protocol launcher. Compiled as a Windows GUI subsystem executable. */
using System;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;

internal static class DshNotificationLauncher
{
    private const string Pattern = @"^__SCHEME__://activate/([1-9][0-9]{0,4})/([0-9a-f]{64})\z";
    private const string Route = "__ROUTE__";
    private const string DesktopUri = "dsh://open";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args == null || args.Length != 1) return 2;
        string uri = args[0];
        if (string.IsNullOrEmpty(uri) || uri.Length > 512) return 2;
        Match match = Regex.Match(uri, Pattern, RegexOptions.CultureInvariant);
        if (!match.Success) return 2;
        int port;
        if (!int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out port)) return 2;
        if (port < 1 || port > 65535) return 2;
        string ticket = match.Groups[2].Value;
        string url = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + Route + ticket;
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;
            request.ContentLength = 0;
            request.KeepAlive = false;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if ((int)response.StatusCode != 202) return 3;
            }
        }
        catch
        {
            return 3;
        }
        try
        {
            foreach (object key in Environment.GetEnvironmentVariables().Keys)
            {
                string name = key as string;
                if (name != null && string.Equals(name, "ELECTRON_RUN_AS_NODE", StringComparison.OrdinalIgnoreCase))
                {
                    Environment.SetEnvironmentVariable(name, null);
                }
            }
            ProcessStartInfo start = new ProcessStartInfo(DesktopUri);
            start.UseShellExecute = true;
            start.ErrorDialog = false;
            Process.Start(start);
            return 0;
        }
        catch
        {
            return 1;
        }
    }
}
`

/** Fixed C# source compiled by Windows PowerShell 5.1 Add-Type; no SDK or extra reference is required. */
export const LAUNCHER_SOURCE = sourceTemplate
  .replaceAll('__SCHEME__', NOTIFICATION_PROTOCOL)
  .replaceAll('__ROUTE__', NOTIFICATION_ACTIVATION_PATH)

export interface WindowsLauncherFiles {
  readonly directory: string
  readonly executable: string
  readonly source: string
  readonly hash: string
}

/** Stable per-user v2 directory; v1 files remain untouched for compatibility. */
export function windowsLauncherFiles(localAppData: string): WindowsLauncherFiles {
  const directory = join(localAppData, 'DshNotifications', 'Notifications', LAUNCHER_DIRECTORY_NAME)
  return {
    directory,
    executable: join(directory, LAUNCHER_EXECUTABLE_NAME),
    source: join(directory, LAUNCHER_SOURCE_NAME),
    hash: join(directory, LAUNCHER_HASH_NAME),
  }
}

/** Lowercase SHA-256 of the exact UTF-8 source Node writes beside the executable. */
export function launcherSourceHash(source: string = LAUNCHER_SOURCE): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

/** Read IMAGE_OPTIONAL_HEADER.Subsystem without trusting the file extension. */
export function windowsLauncherSubsystem(data: Uint8Array): number | undefined {
  if (data.length < 0x40) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint8(0) !== 0x4d || view.getUint8(1) !== 0x5a) return undefined
  const pe = view.getUint32(0x3c, true)
  if (pe < 0x40 || pe + 0x5e > data.length) return undefined
  if (view.getUint8(pe) !== 0x50 || view.getUint8(pe + 1) !== 0x45 || view.getUint8(pe + 2) !== 0 || view.getUint8(pe + 3) !== 0) return undefined
  return view.getUint16(pe + 0x5c, true)
}

/** True only for a PE image that Windows starts without a console window. */
export function isWindowsGuiLauncher(data: Uint8Array): boolean {
  return windowsLauncherSubsystem(data) === WINDOWS_SUBSYSTEM_GUI
}
