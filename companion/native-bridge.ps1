$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CompCtrlNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
    [DllImport("user32.dll")] private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern short VkKeyScan(char character);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private static readonly Dictionary<string, byte> Keys = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase)
    {
        {"Backspace", 0x08}, {"Tab", 0x09}, {"Enter", 0x0D}, {"Shift", 0x10},
        {"Control", 0x11}, {"Ctrl", 0x11}, {"Alt", 0x12}, {"Pause", 0x13},
        {"CapsLock", 0x14}, {"Escape", 0x1B}, {"Esc", 0x1B}, {"Space", 0x20},
        {"PageUp", 0x21}, {"PageDown", 0x22}, {"End", 0x23}, {"Home", 0x24},
        {"ArrowLeft", 0x25}, {"ArrowUp", 0x26}, {"ArrowRight", 0x27}, {"ArrowDown", 0x28},
        {"PrintScreen", 0x2C}, {"Insert", 0x2D}, {"Delete", 0x2E}, {"Meta", 0x5B},
        {"OS", 0x5B}, {"ContextMenu", 0x5D},
        {"Numpad0", 0x60}, {"Numpad1", 0x61}, {"Numpad2", 0x62}, {"Numpad3", 0x63},
        {"Numpad4", 0x64}, {"Numpad5", 0x65}, {"Numpad6", 0x66}, {"Numpad7", 0x67},
        {"Numpad8", 0x68}, {"Numpad9", 0x69}, {"NumpadMultiply", 0x6A}, {"NumpadAdd", 0x6B},
        {"NumpadSubtract", 0x6D}, {"NumpadDecimal", 0x6E}, {"NumpadDivide", 0x6F},
        {"NumLock", 0x90}, {"ScrollLock", 0x91}
    };

    private static byte ResolveKey(string key)
    {
        byte value;
        if (Keys.TryGetValue(key, out value)) return value;
        if (key.Length > 1 && key.StartsWith("F", StringComparison.OrdinalIgnoreCase))
        {
            int functionNumber;
            if (Int32.TryParse(key.Substring(1), out functionNumber) && functionNumber >= 1 && functionNumber <= 24)
                return (byte)(0x6F + functionNumber);
        }
        if (key.Length == 1)
        {
            char character = key[0];
            if (Char.IsLetter(character)) return (byte)Char.ToUpperInvariant(character);
            short scan = VkKeyScan(character);
            if (scan != -1) return (byte)(scan & 0xFF);
        }
        return 0;
    }

    public static void Move(double x, double y)
    {
        int width = Math.Max(1, GetSystemMetrics(0));
        int height = Math.Max(1, GetSystemMetrics(1));
        SetCursorPos((int)Math.Round(Math.Max(0, Math.Min(1, x)) * (width - 1)), (int)Math.Round(Math.Max(0, Math.Min(1, y)) * (height - 1)));
    }

    public static void Button(string button, bool down)
    {
        uint flag;
        if (String.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) flag = down ? 0x0008u : 0x0010u;
        else if (String.Equals(button, "middle", StringComparison.OrdinalIgnoreCase)) flag = down ? 0x0020u : 0x0040u;
        else flag = down ? 0x0002u : 0x0004u;
        mouse_event(flag, 0, 0, 0, UIntPtr.Zero);
    }

    public static void Wheel(int deltaX, int deltaY)
    {
        if (deltaY != 0) mouse_event(0x0800, 0, 0, -deltaY, UIntPtr.Zero);
        if (deltaX != 0) mouse_event(0x01000, 0, 0, deltaX, UIntPtr.Zero);
    }

    public static void Key(string key, bool down)
    {
        byte virtualKey = ResolveKey(key);
        if (virtualKey == 0) return;
        keybd_event(virtualKey, 0, down ? 0u : KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void Text(string text)
    {
        if (String.IsNullOrEmpty(text)) return;
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (char character in text)
        {
            inputs.Add(new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = character, dwFlags = KEYEVENTF_UNICODE } } });
            inputs.Add(new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = character, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } });
        }
        SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Jiggle()
    {
        POINT point;
        if (!GetCursorPos(out point)) return;
        int width = Math.Max(1, GetSystemMetrics(0));
        int nextX = point.X < width - 1 ? point.X + 1 : point.X - 1;
        SetCursorPos(nextX, point.Y);
        SetCursorPos(point.X, point.Y);
    }

    public static void DisplayPower(bool off)
    {
        // HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER. State 2 powers the
        // physical displays off; -1 powers them back on.
        PostMessage(new IntPtr(0xFFFF), 0x0112u, new IntPtr(0xF170), new IntPtr(off ? 2 : -1));
        if (!off) Jiggle();
    }
}
'@

function Invoke-KeyMessage($message) {
    $modifiers = @($message.modifiers)
    foreach ($modifier in $modifiers) { [CompCtrlNative]::Key([string]$modifier, $true) }
    try {
        switch ([string]$message.action) {
            'down' { [CompCtrlNative]::Key([string]$message.key, $true) }
            'up' { [CompCtrlNative]::Key([string]$message.key, $false) }
            default {
                [CompCtrlNative]::Key([string]$message.key, $true)
                [CompCtrlNative]::Key([string]$message.key, $false)
            }
        }
    }
    finally {
        [array]::Reverse($modifiers)
        foreach ($modifier in $modifiers) { [CompCtrlNative]::Key([string]$modifier, $false) }
    }
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $message = $line | ConvertFrom-Json
        switch ([string]$message.type) {
            'pointer' {
                [CompCtrlNative]::Move([double]$message.x, [double]$message.y)
                $button = if ($message.button) { [string]$message.button } else { 'left' }
                if ($message.action -eq 'down') { [CompCtrlNative]::Button($button, $true) }
                elseif ($message.action -eq 'up') { [CompCtrlNative]::Button($button, $false) }
                elseif ($message.action -eq 'click') {
                    [CompCtrlNative]::Button($button, $true)
                    [CompCtrlNative]::Button($button, $false)
                }
            }
            'wheel' { [CompCtrlNative]::Wheel([int]$message.deltaX, [int]$message.deltaY) }
            'key' { Invoke-KeyMessage $message }
            'text' { [CompCtrlNative]::Text([string]$message.text) }
            'jiggle' { [CompCtrlNative]::Jiggle() }
            'display-power' { [CompCtrlNative]::DisplayPower(([string]$message.state) -eq 'off') }
        }
    }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}
