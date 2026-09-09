'use client';

import {
  ArrowRight,
  Camera,
  Clipboard,
  Copy,
  Gauge,
  Keyboard,
  Menu,
  Monitor,
  MousePointer2,
  MousePointerClick,
  Power,
  RefreshCw,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Unplug,
  WifiOff,
  X,
} from 'lucide-react';
import type { DataConnection, MediaConnection } from 'peerjs';
import type QrScanner from 'qr-scanner';
import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { newPeer } from '@/lib/peer';
import {
  CODE_LENGTH,
  type ConnectionState,
  type ControllerMessage,
  type HostMessage,
  cleanCode,
  pairingCodeFromQr,
  peerIdForCode,
} from '@/lib/protocol';

type Modifier = 'Control' | 'Alt' | 'Shift' | 'Meta';

const keyRows = [
  ['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'],
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Backspace'],
  ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\'],
  ['CapsLock', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter'],
  ['Shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'Delete'],
  ['Control', 'Meta', 'Alt', 'Space', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'],
] as const;

const extraKeys = [
  'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'PrintScreen', 'Pause', 'ContextMenu',
  'NumLock', 'ScrollLock',
  'Numpad7', 'Numpad8', 'Numpad9', 'NumpadDivide',
  'Numpad4', 'Numpad5', 'Numpad6', 'NumpadMultiply',
  'Numpad1', 'Numpad2', 'Numpad3', 'NumpadSubtract',
  'Numpad0', 'NumpadDecimal', 'NumpadAdd',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24',
] as const;

const keyLabels: Record<string, string> = {
  Escape: 'Esc',
  Backspace: '⌫',
  CapsLock: 'Caps',
  Control: 'Ctrl',
  Meta: 'Win',
  Alt: 'Alt',
  Shift: 'Shift',
  Enter: 'Enter',
  Delete: 'Del',
  Space: 'Space',
  Tab: 'Tab',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowRight: '→',
  PrintScreen: 'PrtSc',
  ContextMenu: 'Menu',
  ScrollLock: 'ScrLk',
  NumpadDivide: 'Num ÷',
  NumpadMultiply: 'Num ×',
  NumpadSubtract: 'Num −',
  NumpadAdd: 'Num +',
  NumpadDecimal: 'Num .',
};

function keyLabel(key: string) {
  return keyLabels[key] ?? key;
}

function readInitialCode() {
  if (typeof window === 'undefined') return '';
  const linked = cleanCode(window.location.hash.slice(1));
  if (linked.length === CODE_LENGTH) return linked;
  return cleanCode(window.localStorage.getItem('compctrl.lastCode') ?? '');
}

function cameraErrorMessage(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/notallowed|permission|denied/i.test(message)) {
    return 'Camera access was blocked. Allow camera access in your browser settings, then try again.';
  }
  if (/notfound|no camera|devicesnotfound/i.test(message)) {
    return 'No camera was found on this device. You can still enter the pairing code manually.';
  }
  if (!window.isSecureContext) {
    return 'Camera scanning requires HTTPS. Open the published GitHub Pages address and try again.';
  }
  return 'The camera could not start. Close other camera apps, then try again.';
}

export function RemoteController() {
  const [code, setCode] = useState('');
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [retryCount, setRetryCount] = useState(0);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [computerName, setComputerName] = useState('Windows PC');
  const [jigglerEnabled, setJigglerEnabled] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerStatus, setScannerStatus] = useState('Starting camera…');
  const connectionRef = useRef<DataConnection | null>(null);
  const callRef = useRef<MediaConnection | null>(null);
  const lastPongRef = useRef(0);
  const scannerVideoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  useEffect(() => {
    const initial = readInitialCode();
    if (!initial) return;
    setCode(initial);
    const linked = cleanCode(window.location.hash.slice(1));
    const shouldReconnect = window.localStorage.getItem('compctrl.autoReconnect') === 'true';
    if (linked.length === CODE_LENGTH || shouldReconnect) setSessionCode(initial);
  }, []);

  const send = useCallback((message: ControllerMessage) => {
    const connection = connectionRef.current;
    if (!connection?.open) return false;
    void connection.send(message);
    return true;
  }, []);

  const beginSession = useCallback((value: string) => {
    const nextCode = cleanCode(value);
    if (nextCode.length !== CODE_LENGTH) return false;
    setCode(nextCode);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${nextCode}`);
    setSessionCode(nextCode);
    return true;
  }, []);

  useEffect(() => {
    if (!scannerOpen || sessionCode) return;
    let disposed = false;

    const startScanner = async () => {
      setScannerStatus('Starting camera…');
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('No camera API');
        const { default: Scanner } = await import('qr-scanner');
        if (disposed || !scannerVideoRef.current) return;
        if (!(await Scanner.hasCamera())) throw new Error('No camera found');

        const scanner = new Scanner(
          scannerVideoRef.current,
          (result) => {
            const scannedCode = pairingCodeFromQr(result.data);
            if (!scannedCode) {
              setScannerStatus('That is not a CompCtrl pairing QR code. Point at the code shown on your computer.');
              return;
            }
            scanner.stop();
            setScannerOpen(false);
            beginSession(scannedCode);
          },
          {
            preferredCamera: 'environment',
            maxScansPerSecond: 10,
            highlightScanRegion: true,
            highlightCodeOutline: true,
            returnDetailedScanResult: true,
          },
        );
        scannerRef.current = scanner;
        await scanner.start();
        if (!disposed) setScannerStatus('Point your camera at the QR code in the Windows companion.');
      } catch (error) {
        if (!disposed) setScannerStatus(cameraErrorMessage(error));
      }
    };

    void startScanner();
    return () => {
      disposed = true;
      scannerRef.current?.stop();
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, [beginSession, scannerOpen, sessionCode]);

  useEffect(() => {
    if (!sessionCode) return;

    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let peer = newPeer();
    let connection: DataConnection | null = null;

    const cleanTransport = () => {
      connection?.close();
      callRef.current?.close();
      callRef.current = null;
      connectionRef.current = null;
      if (!peer.destroyed) peer.destroy();
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      setConnectionState(navigator.onLine ? 'reconnecting' : 'offline');
      setStream(null);
      const delay = navigator.onLine ? Math.min(1000 * 2 ** attempt, 8000) : 2500;
      attempt += 1;
      setRetryCount(attempt);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        cleanTransport();
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      setConnectionState(attempt === 0 ? 'connecting' : 'reconnecting');
      peer = newPeer();

      peer.on('open', () => {
        if (disposed) return;
        connection = peer.connect(peerIdForCode(sessionCode), {
          reliable: true,
          serialization: 'json',
          metadata: { role: 'controller', protocol: 1 },
        });
        connectionRef.current = connection;

        connection.on('open', () => {
          attempt = 0;
          setRetryCount(0);
          lastPongRef.current = Date.now();
          setConnectionState('connected');
          window.localStorage.setItem('compctrl.lastCode', sessionCode);
          window.localStorage.setItem('compctrl.autoReconnect', 'true');
        });
        connection.on('data', (data) => {
          const message = data as HostMessage;
          if (message.type === 'ready') {
            setComputerName(message.computerName);
            setJigglerEnabled(message.jigglerEnabled);
          } else if (message.type === 'status') {
            setJigglerEnabled(message.jigglerEnabled);
          } else if (message.type === 'pong') {
            lastPongRef.current = Date.now();
          }
        });
        connection.on('close', scheduleReconnect);
        connection.on('error', scheduleReconnect);
      });

      peer.on('call', (incomingCall) => {
        callRef.current?.close();
        callRef.current = incomingCall;
        incomingCall.answer();
        incomingCall.on('stream', (remoteStream) => setStream(remoteStream));
        incomingCall.on('close', () => setStream(null));
        incomingCall.on('error', scheduleReconnect);
      });

      peer.on('disconnected', scheduleReconnect);
      peer.on('close', scheduleReconnect);
      peer.on('error', scheduleReconnect);
    };

    connect();
    const heartbeat = window.setInterval(() => {
      if (!connectionRef.current?.open) return;
      if (Date.now() - lastPongRef.current > 25_000) {
        scheduleReconnect();
        return;
      }
      send({ type: 'ping', sentAt: Date.now() });
    }, 8000);

    const reconnectWhenOnline = () => {
      if (!disposed && !connectionRef.current?.open) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        cleanTransport();
        attempt = 0;
        connect();
      }
    };
    window.addEventListener('online', reconnectWhenOnline);

    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('online', reconnectWhenOnline);
      cleanTransport();
    };
  }, [reconnectNonce, send, sessionCode]);

  const startSession = () => { beginSession(code); };

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'connect_to_computer',
      title: 'Connect to computer',
      description: 'Start the visible CompCtrl session using an eight-character pairing code supplied by the user.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', pattern: '^[A-HJ-NP-Z2-9]{8}$' } },
        required: ['code'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const candidate = cleanCode((input as { code?: unknown })?.code as string ?? '');
        if (candidate.length !== CODE_LENGTH) throw new Error('A valid eight-character pairing code is required.');
        beginSession(candidate);
        return { status: 'connecting', code: `${candidate.slice(0, 4)} ${candidate.slice(4)}` };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [beginSession]);

  const disconnect = () => {
    window.localStorage.removeItem('compctrl.autoReconnect');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setSessionCode(null);
    setStream(null);
    setConnectionState('idle');
  };

  if (sessionCode) {
    return (
      <RemoteSurface
        code={sessionCode}
        computerName={computerName}
        connectionState={connectionState}
        retryCount={retryCount}
        stream={stream}
        jigglerEnabled={jigglerEnabled}
        setJigglerEnabled={(enabled) => {
          setJigglerEnabled(enabled);
          send({ type: 'jiggler', enabled });
        }}
        send={send}
        disconnect={disconnect}
        reconnect={() => setReconnectNonce((value) => value + 1)}
      />
    );
  }

  return (
    <main className="controller-shell min-h-dvh overflow-hidden text-[var(--ink)]">
      <div className="signal-grid" aria-hidden="true" />
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8 sm:py-7">
        <div className="flex items-center gap-3" aria-label="CompCtrl">
          <span className="brand-mark"><MousePointer2 className="size-[18px]" strokeWidth={2.4} /></span>
          <span className="text-[0.95rem] font-semibold tracking-[-0.02em]">CompCtrl</span>
        </div>
        <span className="status-pill"><span className="status-dot" /> End-to-end P2P</span>
      </header>

      <section className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-10 pt-4 sm:px-8 lg:grid-cols-[0.86fr_1.14fr] lg:gap-16 lg:pt-12">
        <div className="mx-auto w-full max-w-md lg:mx-0">
          <div className="eyebrow"><Gauge className="size-3.5" /> Remote session</div>
          <h1 className="mt-5 max-w-[11ch] text-[clamp(2.6rem,8vw,5.4rem)] font-semibold leading-[0.94] tracking-[-0.065em]">
            Your PC,<br /><span className="text-[var(--accent)]">within reach.</span>
          </h1>
          <p className="mt-6 max-w-sm text-base leading-7 text-[var(--muted-ink)]">
            Enter the code shown by the Windows companion. Your phone becomes the mouse, keyboard, and live display.
          </p>

          <form
            className="mt-8"
            onSubmit={(event) => { event.preventDefault(); startSession(); }}
          >
            <label htmlFor="pair-code" className="mb-2 block text-sm font-medium">Pairing code</label>
            <div className="pairing-field">
              <ShieldCheck className="ml-4 size-[18px] shrink-0 text-[var(--muted-ink)]" />
              <Input
                id="pair-code"
                value={code}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setCode(cleanCode(event.target.value))}
                className="h-14 flex-1 border-0 bg-transparent px-3 font-mono text-lg font-semibold uppercase tracking-[0.2em] shadow-none focus-visible:ring-0"
                placeholder="ABCD 2345"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
              />
              <Button
                type="submit"
                size="icon-lg"
                className="mr-1.5 size-11 rounded-xl bg-[var(--accent)] text-white hover:bg-[var(--accent-strong)]"
                disabled={code.length !== CODE_LENGTH}
                aria-label="Connect to computer"
              >
                <ArrowRight className="size-5" />
              </Button>
            </div>
            <div className="pairing-secondary">
              <Button type="button" variant="outline" className="scan-code-button" onClick={() => setScannerOpen(true)}>
                <Camera className="size-[18px]" /> Scan QR code
              </Button>
              <span>or enter the 8-character code</span>
            </div>
            <p className="mt-3 flex items-center gap-2 text-[0.8rem] text-[var(--muted-ink)]">
              <ShieldCheck className="size-4 text-[var(--safe)]" /> Video and controls travel directly between your devices.
            </p>
          </form>
        </div>

        <div className="device-stage" aria-label="Remote desktop controller preview">
          <div className="screen-card">
            <div className="screen-topbar">
              <div className="flex items-center gap-2"><span className="mini-dot bg-[#ff695e]" /><span className="mini-dot bg-[#ffbd45]" /><span className="mini-dot bg-[#31c653]" /></div>
              <div className="flex items-center gap-2 text-[0.68rem] text-white/50"><Monitor className="size-3" /> Ready to pair</div>
            </div>
            <div className="mock-desktop">
              <aside className="mock-sidebar"><span /><span /><span /><span /></aside>
              <div className="mock-workspace">
                <div className="mock-window mock-window-one"><div /><div /><div /></div>
                <div className="mock-window mock-window-two"><div /><div /></div>
                <MousePointer2 className="absolute left-[58%] top-[44%] size-7 fill-white text-[#121723] drop-shadow-lg" />
              </div>
            </div>
          </div>
          <div className="floating-chip chip-keyboard"><Keyboard className="size-4" /> Full keyboard</div>
          <div className="floating-chip chip-live"><span className="status-dot" /> Live screen</div>
          <div className="phone-bar">
            <div className="phone-shortcut"><span>Ctrl</span><b>C</b></div>
            <div className="phone-shortcut"><span>Ctrl</span><b>V</b></div>
            <div className="phone-primary"><Monitor className="size-4" /> Desktop</div>
            <Keyboard className="size-5 text-white/55" />
          </div>
        </div>
      </section>

      <Drawer open={scannerOpen} onOpenChange={setScannerOpen} showSwipeHandle>
        <DrawerContent className="scanner-drawer">
          <DrawerHeader className="scanner-header text-left">
            <div>
              <DrawerTitle>Scan the computer QR code</DrawerTitle>
              <DrawerDescription>The code stays on your Windows companion while it waits for your phone.</DrawerDescription>
            </div>
            <button type="button" className="scanner-close" onClick={() => setScannerOpen(false)} aria-label="Close camera scanner">
              <X />
            </button>
          </DrawerHeader>
          <div className="scanner-content">
            <div className="scanner-viewfinder">
              <video ref={scannerVideoRef} muted playsInline aria-label="Camera preview for QR scanning" />
              <span className="scanner-target" aria-hidden="true"><ScanLine /></span>
            </div>
            <output className="scanner-status" aria-live="polite">{scannerStatus}</output>
            <Button variant="outline" className="scanner-manual" onClick={() => setScannerOpen(false)}>
              Enter code manually
            </Button>
          </div>
        </DrawerContent>
      </Drawer>

      <footer className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 pb-6 text-[0.72rem] text-[var(--muted-ink)] sm:px-8">
        <span>No account. No stored video.</span><span className="hidden sm:block">Peer-to-peer WebRTC</span>
      </footer>
    </main>
  );
}

type RemoteSurfaceProps = {
  code: string;
  computerName: string;
  connectionState: ConnectionState;
  retryCount: number;
  stream: MediaStream | null;
  jigglerEnabled: boolean;
  setJigglerEnabled(enabled: boolean): void;
  send(message: ControllerMessage): boolean;
  disconnect(): void;
  reconnect(): void;
};

function RemoteSurface({
  code,
  computerName,
  connectionState,
  retryCount,
  stream,
  jigglerEnabled,
  setJigglerEnabled,
  send,
  disconnect,
  reconnect,
}: RemoteSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const keyboardInputRef = useRef<HTMLInputElement>(null);
  const pointerState = useRef({
    points: new Map<number, { clientX: number; clientY: number }>(),
    mouseDown: false,
    pressTimer: 0 as number | ReturnType<typeof setTimeout>,
    lastScrollY: 0,
    lastX: 0.5,
    lastY: 0.5,
  });
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [powerAction, setPowerAction] = useState<'restart' | 'shutdown' | null>(null);
  const [activeModifiers, setActiveModifiers] = useState<Modifier[]>([]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    const pointer = pointerState.current;
    return () => {
      if (pointer.pressTimer) clearTimeout(pointer.pressTimer);
    };
  }, []);

  const handleHardwareKey = (event: ReactKeyboardEvent<HTMLButtonElement>, action: 'down' | 'up') => {
    if (event.nativeEvent.isComposing || event.key === 'Unidentified') return;
    event.preventDefault();
    send({ type: 'key', action: event.repeat ? 'tap' : action, key: event.key });
  };

  const normalizedPoint = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const video = videoRef.current;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const videoWidth = video?.videoWidth || 16;
    const videoHeight = video?.videoHeight || 9;
    const contentRatio = videoWidth / videoHeight;
    const boxRatio = rect.width / rect.height;
    let width = rect.width;
    let height = rect.height;
    let left = rect.left;
    let top = rect.top;
    if (boxRatio > contentRatio) {
      width = rect.height * contentRatio;
      left += (rect.width - width) / 2;
    } else {
      height = rect.width / contentRatio;
      top += (rect.height - height) / 2;
    }
    return {
      x: Math.max(0, Math.min(1, (event.clientX - left) / width)),
      y: Math.max(0, Math.min(1, (event.clientY - top) / height)),
    };
  }, []);

  const sendPointer = useCallback((action: 'move' | 'down' | 'up' | 'click', button: 'left' | 'right' = 'left') => {
    const state = pointerState.current;
    send({ type: 'pointer', action, x: state.lastX, y: state.lastY, button });
  }, [send]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = normalizedPoint(event);
    const state = pointerState.current;
    state.points.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    state.lastX = point.x;
    state.lastY = point.y;
    send({ type: 'pointer', action: 'move', ...point });
    if (state.points.size === 1) {
      state.pressTimer = window.setTimeout(() => {
        if (state.points.size === 1) {
          state.mouseDown = true;
          sendPointer('down');
        }
      }, 90);
    } else {
      clearTimeout(state.pressTimer);
      if (state.mouseDown) sendPointer('up');
      state.mouseDown = false;
      state.lastScrollY = Array.from(state.points.values()).reduce((sum, p) => sum + p.clientY, 0) / state.points.size;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = pointerState.current;
    const previous = state.points.get(event.pointerId);
    if (!previous) return;
    state.points.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (state.points.size >= 2) {
      const averageY = Array.from(state.points.values()).reduce((sum, p) => sum + p.clientY, 0) / state.points.size;
      const deltaY = (state.lastScrollY - averageY) * 2.2;
      state.lastScrollY = averageY;
      if (Math.abs(deltaY) > 0.5) send({ type: 'wheel', deltaX: 0, deltaY });
      return;
    }
    const point = normalizedPoint(event);
    state.lastX = point.x;
    state.lastY = point.y;
    if (!state.mouseDown && Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) > 3) {
      clearTimeout(state.pressTimer);
      state.mouseDown = true;
      send({ type: 'pointer', action: 'down', ...point, button: 'left' });
    }
    send({ type: 'pointer', action: 'move', ...point });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = pointerState.current;
    const wasSingle = state.points.size === 1;
    state.points.delete(event.pointerId);
    if (wasSingle) {
      clearTimeout(state.pressTimer);
      if (state.mouseDown) sendPointer('up');
      else sendPointer('click');
      state.mouseDown = false;
    } else if (state.points.size === 1) {
      state.lastScrollY = Array.from(state.points.values())[0]?.clientY ?? 0;
    }
  };

  const toggleModifier = (modifier: Modifier) => {
    setActiveModifiers((current) => current.includes(modifier) ? current.filter((item) => item !== modifier) : [...current, modifier]);
  };

  const tapVirtualKey = (key: string) => {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
      toggleModifier(key as Modifier);
      return;
    }
    send({ type: 'key', action: 'tap', key, modifiers: activeModifiers });
    setActiveModifiers([]);
  };

  const connected = connectionState === 'connected';
  const statusText = connected
    ? stream ? 'Live' : 'Securing video'
    : connectionState === 'offline' ? 'Phone offline' : retryCount ? `Reconnecting · ${retryCount}` : 'Connecting';

  return (
    <main className="remote-shell">
      <header className="remote-topbar">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className={`remote-state-dot ${connected ? 'is-live' : ''}`} /><strong className="truncate">{computerName}</strong></div>
          <p>{statusText} · {code.slice(0, 4)} {code.slice(4)}</p>
        </div>
        <Button variant="ghost" size="icon-lg" className="remote-icon-button" onClick={() => setControlsOpen(true)} aria-label="Open session controls">
          <Menu className="size-5" />
        </Button>
      </header>

      <button
        type="button"
        className="remote-video-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => handleHardwareKey(event, 'down')}
        onKeyUp={(event) => handleHardwareKey(event, 'up')}
        onContextMenu={(event) => event.preventDefault()}
        aria-label="Remote computer screen. Touch a point to move and click there; drag with two fingers to scroll."
      >
        <video ref={videoRef} autoPlay muted playsInline className={`remote-video ${stream ? 'is-visible' : ''}`} />
        {!stream && (
          <span className="remote-empty">
            {connected ? <Monitor className="size-8" /> : <WifiOff className="size-8" />}
            <strong>{connected ? 'Starting live screen…' : 'Finding your computer…'}</strong>
            <span>{connected ? 'The companion is preparing the display.' : 'We will reconnect automatically when it is available.'}</span>
            {!connected && <span className="retry-note"><RefreshCw /> Retrying automatically</span>}
          </span>
        )}
        {stream && <span className="touch-hint">Tap anywhere · drag to move · two fingers to scroll</span>}
      </button>

      <nav className="remote-toolbar" aria-label="Remote control shortcuts">
        <Button className="shortcut-button" onClick={() => send({ type: 'key', action: 'tap', key: 'c', modifiers: ['Control'] })}>
          <Copy /><span><small>Ctrl</small>C</span>
        </Button>
        <Button className="shortcut-button" onClick={() => send({ type: 'key', action: 'tap', key: 'v', modifiers: ['Control'] })}>
          <Clipboard /><span><small>Ctrl</small>V</span>
        </Button>
        <Button variant="secondary" className="toolbar-button" onClick={() => { setKeyboardOpen(true); setTimeout(() => keyboardInputRef.current?.focus(), 350); }}>
          <Keyboard /><span>Keys</span>
        </Button>
        <Button variant="secondary" className="toolbar-button" onClick={() => sendPointer('click')}>
          <MousePointerClick /><span>Click</span>
        </Button>
        <Button variant="secondary" className="toolbar-button" onClick={() => sendPointer('click', 'right')}>
          <MousePointer2 /><span>Right</span>
        </Button>
      </nav>

      <Drawer open={keyboardOpen} onOpenChange={setKeyboardOpen} showSwipeHandle>
        <DrawerContent className="keyboard-drawer">
          <DrawerHeader className="text-left">
            <DrawerTitle>Windows keyboard</DrawerTitle>
            <DrawerDescription>Use the typing field for your phone keyboard, or tap any PC key below.</DrawerDescription>
          </DrawerHeader>
          <div className="keyboard-content">
            <Input
              ref={keyboardInputRef}
              className="h-12 bg-white text-base"
              placeholder="Tap here, then type…"
              autoCapitalize="sentences"
              autoCorrect="on"
              onInput={(event) => {
                const input = event.currentTarget;
                if (input.value) send({ type: 'text', text: input.value });
                input.value = '';
              }}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Backspace' || event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') {
                  event.preventDefault();
                  send({ type: 'key', action: 'tap', key: event.key, modifiers: activeModifiers });
                  setActiveModifiers([]);
                }
              }}
            />
            <fieldset className="pc-keyboard" aria-label="Full PC keyboard">
              {keyRows.map((row, rowIndex) => (
                <div className="key-row" key={rowIndex}>
                  {row.map((key) => {
                    const active = activeModifiers.includes(key as Modifier);
                    return (
                      <button
                        type="button"
                        key={key}
                        className={`pc-key ${active ? 'is-active' : ''} key-${key.toLowerCase()}`}
                        onClick={() => tapVirtualKey(key)}
                        aria-pressed={['Control', 'Alt', 'Shift', 'Meta'].includes(key) ? active : undefined}
                      >
                        {keyLabel(key)}
                      </button>
                    );
                  })}
                </div>
              ))}
            </fieldset>
            <div className="extra-keys">
              {extraKeys.map((key) => (
                <button type="button" className="pc-key" key={key} onClick={() => tapVirtualKey(key)}>{keyLabel(key)}</button>
              ))}
            </div>
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer open={controlsOpen} onOpenChange={setControlsOpen} showSwipeHandle>
        <DrawerContent className="control-drawer">
          <DrawerHeader className="text-left">
            <DrawerTitle>Session controls</DrawerTitle>
            <DrawerDescription>Connection, keep-awake, and computer power.</DrawerDescription>
          </DrawerHeader>
          <div className="control-list">
            {!connected && (
              <button type="button" className="control-row" onClick={reconnect}>
                <span className="control-row-icon"><RefreshCw /></span><span><strong>Retry connection</strong><small>Start a fresh rendezvous now</small></span><ArrowRight />
              </button>
            )}
            <div className="control-row">
              <span className="control-row-icon safe"><Gauge /></span>
              <span><strong>Screen jiggler</strong><small>Move the pointer slightly every 30 seconds</small></span>
              <Switch checked={jigglerEnabled} onCheckedChange={setJigglerEnabled} aria-label="Toggle screen jiggler" />
            </div>
            <button type="button" className="control-row" onClick={() => setPowerAction('restart')}>
              <span className="control-row-icon"><RotateCcw /></span><span><strong>Restart computer</strong><small>Requires a hold to confirm</small></span><ArrowRight />
            </button>
            <button type="button" className="control-row danger" onClick={() => setPowerAction('shutdown')}>
              <span className="control-row-icon danger"><Power /></span><span><strong>Shut down computer</strong><small>Requires a hold to confirm</small></span><ArrowRight />
            </button>
            <button type="button" className="control-row" onClick={disconnect}>
              <span className="control-row-icon"><Unplug /></span><span><strong>Disconnect phone</strong><small>The companion keeps running</small></span><ArrowRight />
            </button>
          </div>
        </DrawerContent>
      </Drawer>

      <PowerDialog action={powerAction} setAction={setPowerAction} send={send} />
    </main>
  );
}

function PowerDialog({
  action,
  setAction,
  send,
}: {
  action: 'restart' | 'shutdown' | null;
  setAction(action: 'restart' | 'shutdown' | null): void;
  send(message: ControllerMessage): boolean;
}) {
  const [progress, setProgress] = useState(0);
  const animationRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const stop = () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    if (!firedRef.current) setProgress(0);
  };

  const start = () => {
    if (!action) return;
    firedRef.current = false;
    const started = performance.now();
    const tick = (now: number) => {
      const next = Math.min(1, (now - started) / 1800);
      setProgress(next);
      if (next >= 1) {
        firedRef.current = true;
        send({ type: 'system', action });
        setTimeout(() => setAction(null), 180);
        return;
      }
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); }, []);
  useEffect(() => { setProgress(0); firedRef.current = false; }, [action]);

  const restart = action === 'restart';
  return (
    <AlertDialog open={action !== null} onOpenChange={(open) => { if (!open) setAction(null); }}>
      <AlertDialogContent className="power-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia className="power-media">{restart ? <RotateCcw /> : <Power />}</AlertDialogMedia>
          <AlertDialogTitle>{restart ? 'Restart this computer?' : 'Shut down this computer?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {restart ? 'Open work may be lost. The companion will return after Windows starts.' : 'Open work may be lost and remote access will end.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="power-cancel" onClick={stop}>Cancel</AlertDialogCancel>
          <button
            type="button"
            className={`hold-button ${restart ? '' : 'is-danger'}`}
            onPointerDown={start}
            onPointerUp={stop}
            onPointerCancel={stop}
            onPointerLeave={stop}
            onKeyDown={(event) => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) start(); }}
            onKeyUp={stop}
            style={{ '--hold': progress } as CSSProperties}
          >
            <span className="hold-fill" />
            <span>Hold to {restart ? 'restart' : 'shut down'}</span>
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
