'use client';

import {
  ArrowRight,
  Camera,
  Clipboard,
  Copy,
  CornerDownLeft,
  Crosshair,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Gauge,
  Hand,
  Keyboard,
  Maximize2,
  Menu,
  Minimize2,
  Monitor,
  Mic,
  MicOff,
  MousePointer2,
  MousePointerClick,
  PictureInPicture2,
  Power,
  RefreshCw,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Unplug,
  WifiOff,
  X,
  ZoomOut,
} from 'lucide-react';
import type { DataConnection, MediaConnection } from 'peerjs';
import type QrScanner from 'qr-scanner';
import {
  type ChangeEvent,
  type SyntheticEvent as ReactSyntheticEvent,
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
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { newPeer } from '@/lib/peer';
import {
  MAX_VIEW_SCALE,
  clamp,
  clampPoint,
  containedRect,
  displayToScreen,
  screenToDisplay,
  type RemotePoint,
  type RemoteRect,
  type RemoteView,
  viewAroundAnchor,
} from '@/lib/remote-geometry';
import {
  CODE_LENGTH,
  type ConnectionState,
  type ControllerMessage,
  type HostMessage,
  PROTOCOL_VERSION,
  authProofForCode,
  cleanCode,
  createSecurityToken,
  isHostMessage,
  pairingCodeFromQr,
  peerIdForCode,
} from '@/lib/protocol';

type Modifier = 'Control' | 'Alt' | 'Shift' | 'Meta';
type DictationState = 'idle' | 'recording' | 'sending' | 'transcribing' | 'done' | 'error';

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type WebkitPiPVideo = HTMLVideoElement & {
  webkitPresentationMode?: string;
  webkitSetPresentationMode?(mode: 'inline' | 'picture-in-picture'): void;
  webkitSupportsPresentationMode?(mode: 'picture-in-picture'): boolean;
};

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
  const [screenBlanked, setScreenBlanked] = useState(false);
  const [displayControlSupported, setDisplayControlSupported] = useState(false);
  const [dictationAvailable, setDictationAvailable] = useState(false);
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const [dictationMessage, setDictationMessage] = useState('');
  const [hostNotice, setHostNotice] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerStatus, setScannerStatus] = useState('Starting camera…');
  const connectionRef = useRef<DataConnection | null>(null);
  const callRef = useRef<MediaConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastPongRef = useRef(0);
  const scannerVideoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const dictationChunksRef = useRef<Blob[]>([]);
  const dictationIdRef = useRef('');
  const dictationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const stopRecorderTracks = useCallback(() => {
    recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    recorderStreamRef.current = null;
    if (dictationTimerRef.current) clearTimeout(dictationTimerRef.current);
    dictationTimerRef.current = null;
  }, []);

  const stopDictation = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  }, []);

  const startDictation = useCallback(async () => {
    if (!dictationAvailable) {
      setDictationState('error');
      setDictationMessage('Add a Groq API key in the Windows companion first.');
      return;
    }
    if (!connectionRef.current?.open || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setDictationState('error');
      setDictationMessage('Voice recording is unavailable in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('This browser cannot create a supported voice recording.');
      }

      const id = createSecurityToken(12);
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorderStreamRef.current = stream;
      dictationChunksRef.current = [];
      dictationIdRef.current = id;
      recorder.ondataavailable = (event) => {
        if (event.data.size) dictationChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setDictationState('error');
        setDictationMessage('The microphone recording failed.');
        stopRecorderTracks();
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        stopRecorderTracks();
        setDictationState('sending');
        setDictationMessage('Sending encrypted audio to the computer…');
        void (async () => {
          const audio = new Uint8Array(await new Blob(dictationChunksRef.current, { type: mimeType }).arrayBuffer());
          dictationChunksRef.current = [];
          if (!audio.length) throw new Error('No audio was recorded.');
          if (audio.length > 20 * 1024 * 1024) throw new Error('Recording is too large. Keep dictation under 90 seconds.');
          const chunkSize = 45 * 1024;
          const totalChunks = Math.ceil(audio.length / chunkSize);
          for (let index = 0; index < totalChunks; index += 1) {
            const data = bytesToBase64(audio.subarray(index * chunkSize, Math.min(audio.length, (index + 1) * chunkSize)));
            if (!send({ type: 'dictation-chunk', id, index, data })) throw new Error('The computer connection was lost.');
          }
          if (!send({ type: 'dictation-end', id, totalChunks })) throw new Error('The computer connection was lost.');
        })().catch((error) => {
          send({ type: 'dictation-cancel', id });
          setDictationState('error');
          setDictationMessage(error instanceof Error ? error.message : 'Could not send the recording.');
        });
      };

      if (!send({ type: 'dictation-start', id, mimeType })) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('The computer connection was lost.');
      }
      recorder.start(1_000);
      setDictationState('recording');
      setDictationMessage('Listening… tap again to transcribe.');
      dictationTimerRef.current = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 90_000);
    } catch (error) {
      stopRecorderTracks();
      recorderRef.current = null;
      setDictationState('error');
      const detail = error instanceof Error ? error.message : 'Microphone access failed.';
      setDictationMessage(/notallowed|permission|denied/i.test(detail) ? 'Allow microphone access in the browser, then try again.' : detail);
    }
  }, [dictationAvailable, send, stopRecorderTracks]);

  const toggleDictation = useCallback(() => {
    if (dictationState === 'recording') stopDictation();
    else if (!['sending', 'transcribing'].includes(dictationState)) void startDictation();
  }, [dictationState, startDictation, stopDictation]);

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
    let mediaRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let peer: ReturnType<typeof newPeer> | null = null;
    let connection: DataConnection | null = null;

    const cleanTransport = () => {
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') {
        recorder.onstop = null;
        recorder.stop();
      }
      recorderRef.current = null;
      stopRecorderTracks();
      setDictationState('idle');
      setDictationAvailable(false);
      connection?.close();
      const activeCall = callRef.current;
      callRef.current = null;
      activeCall?.close();
      streamRef.current = null;
      setStream(null);
      connectionRef.current = null;
      if (peer && !peer.destroyed) peer.destroy();
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      setDictationAvailable(false);
      setConnectionState(navigator.onLine ? 'reconnecting' : 'offline');
      setHostNotice(navigator.onLine ? 'Control connection lost. Reconnecting…' : 'Phone is offline.');
      streamRef.current = null;
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
      setDisplayControlSupported(false);
      const activePeer = newPeer();
      peer = activePeer;

      activePeer.on('open', () => {
        if (disposed) return;
        void peerIdForCode(sessionCode).then((hostId) => {
          if (disposed || activePeer.destroyed) return;
          connection = activePeer.connect(hostId, {
            reliable: true,
            serialization: 'json',
            metadata: { role: 'controller', protocol: PROTOCOL_VERSION },
          });

          connection.on('open', () => {
            setHostNotice('Authenticating this phone…');
          });
          connection.on('data', (data) => {
            if (!isHostMessage(data)) {
              connection?.close();
              return;
            }
            const message: HostMessage = data;
            if (message.type === 'auth-challenge') {
              const nonce = createSecurityToken();
              void authProofForCode(sessionCode, message.challenge, nonce).then((proof) => {
                if (!disposed && connection?.open) {
                  void connection.send({ type: 'auth-response', challenge: message.challenge, nonce, proof } satisfies ControllerMessage);
                }
              }).catch(scheduleReconnect);
              return;
            }
            if (message.type === 'auth-ok') {
              if (!connection) return;
              connectionRef.current = connection;
              attempt = 0;
              setRetryCount(0);
              lastPongRef.current = Date.now();
              setConnectionState('connected');
              setHostNotice('Authenticated. Waiting for desktop video…');
              window.localStorage.setItem('compctrl.lastCode', sessionCode);
              window.localStorage.setItem('compctrl.autoReconnect', 'true');
              if (mediaRetryTimer) clearTimeout(mediaRetryTimer);
              mediaRetryTimer = setTimeout(() => {
                if (!disposed && connectionRef.current?.open && !callRef.current) {
                  setHostNotice('Requesting the desktop video again…');
                  send({ type: 'stream', action: 'request' });
                }
              }, 4500);
              return;
            }
          if (message.type === 'ready') {
            setComputerName(message.computerName);
            setJigglerEnabled(message.jigglerEnabled);
            setDictationAvailable(message.dictationAvailable);
            const supported = typeof message.screenBlanked === 'boolean';
            setDisplayControlSupported(supported);
            setScreenBlanked(supported && message.screenBlanked);
            setHostNotice('Connected. Starting desktop video…');
            if (!callRef.current) send({ type: 'stream', action: 'request' });
          } else if (message.type === 'status') {
            setJigglerEnabled(message.jigglerEnabled);
            setDictationAvailable(message.dictationAvailable);
            if (typeof message.screenBlanked === 'boolean') {
              setDisplayControlSupported(true);
              setScreenBlanked(message.screenBlanked);
            }
          } else if (message.type === 'pong') {
            lastPongRef.current = Date.now();
          } else if (message.type === 'notice') {
            setHostNotice(message.message);
          } else if (message.type === 'dictation-status' && message.id === dictationIdRef.current) {
            setDictationMessage(message.message);
            if (message.status === 'transcribing') setDictationState('transcribing');
            else if (message.status === 'done') setDictationState('done');
            else if (message.status === 'error') setDictationState('error');
          }
          });
          connection.on('close', scheduleReconnect);
          connection.on('error', scheduleReconnect);
        }).catch(scheduleReconnect);
      });

      activePeer.on('call', (incomingCall) => {
        const metadata = incomingCall.metadata as { protocol?: number } | undefined;
        if (!connectionRef.current?.open || incomingCall.peer !== connectionRef.current.peer || metadata?.protocol !== PROTOCOL_VERSION) {
          incomingCall.close();
          return;
        }
        const previousCall = callRef.current;
        callRef.current = null;
        previousCall?.close();
        callRef.current = incomingCall;
        streamRef.current = null;
        setStream(null);
        if (mediaRetryTimer) clearTimeout(mediaRetryTimer);
        mediaRetryTimer = null;
        setHostNotice('Receiving desktop video…');
        const streamTimeout = window.setTimeout(() => {
          if (callRef.current !== incomingCall) return;
          setHostNotice('Desktop video timed out. Retrying…');
          incomingCall.close();
        }, 12_000);
        let remoteVideoTrack: MediaStreamTrack | null = null;
        const markMediaLive = () => {
          if (callRef.current !== incomingCall) return;
          window.clearTimeout(streamTimeout);
          setHostNotice('');
        };
        const recoverMedia = () => {
          window.clearTimeout(streamTimeout);
          remoteVideoTrack?.removeEventListener('unmute', markMediaLive);
          remoteVideoTrack?.removeEventListener('ended', recoverMedia);
          if (callRef.current !== incomingCall) return;
          callRef.current = null;
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          setStream(null);
          if (!disposed && connectionRef.current?.open) {
            setHostNotice('Video connection interrupted. Requesting it again…');
            if (mediaRetryTimer) clearTimeout(mediaRetryTimer);
            mediaRetryTimer = setTimeout(() => send({ type: 'stream', action: 'request' }), 900);
          }
        };
        incomingCall.answer();
        incomingCall.on('stream', (remoteStream) => {
          if (callRef.current !== incomingCall) {
            remoteStream.getTracks().forEach((track) => track.stop());
            return;
          }
          remoteVideoTrack = remoteStream.getVideoTracks()[0] ?? null;
          if (!remoteVideoTrack || remoteVideoTrack.readyState !== 'live') {
            setHostNotice('The desktop stream contained no live video. Retrying…');
            incomingCall.close();
            return;
          }
          streamRef.current = remoteStream;
          setStream(remoteStream);
          remoteVideoTrack.addEventListener('ended', recoverMedia, { once: true });
          if (remoteVideoTrack.muted) {
            setHostNotice('Connected. Waiting for the first desktop frame…');
            remoteVideoTrack.addEventListener('unmute', markMediaLive, { once: true });
          } else {
            markMediaLive();
          }
        });
        incomingCall.on('close', recoverMedia);
        incomingCall.on('error', recoverMedia);
      });

      activePeer.on('disconnected', scheduleReconnect);
      activePeer.on('close', scheduleReconnect);
      activePeer.on('error', scheduleReconnect);
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

    const resumeWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (connectionRef.current?.open) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        lastPongRef.current = Date.now();
        setConnectionState('connected');
        send({ type: 'ping', sentAt: Date.now() });
        if (!callRef.current) send({ type: 'stream', action: 'request' });
        return;
      }
      reconnectWhenOnline();
    };
    document.addEventListener('visibilitychange', resumeWhenVisible);
    window.addEventListener('pageshow', resumeWhenVisible);
    window.addEventListener('focus', resumeWhenVisible);

    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      if (retryTimer) clearTimeout(retryTimer);
      if (mediaRetryTimer) clearTimeout(mediaRetryTimer);
      window.removeEventListener('online', reconnectWhenOnline);
      document.removeEventListener('visibilitychange', resumeWhenVisible);
      window.removeEventListener('pageshow', resumeWhenVisible);
      window.removeEventListener('focus', resumeWhenVisible);
      cleanTransport();
    };
  }, [reconnectNonce, send, sessionCode, stopRecorderTracks]);

  const startSession = () => { beginSession(code); };

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'connect_to_computer',
      title: 'Connect to computer',
      description: 'Start the visible CompCtrl session using a twelve-character pairing code supplied by the user.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', pattern: '^[A-HJ-NP-Z2-9]{12}$' } },
        required: ['code'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const candidate = cleanCode((input as { code?: unknown })?.code as string ?? '');
        if (candidate.length !== CODE_LENGTH) throw new Error('A valid twelve-character pairing code is required.');
        beginSession(candidate);
        return { status: 'connecting', code: `${candidate.slice(0, 4)} ${candidate.slice(4, 8)} ${candidate.slice(8)}` };
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
        hostNotice={hostNotice}
        jigglerEnabled={jigglerEnabled}
        setJigglerEnabled={(enabled) => {
          setJigglerEnabled(enabled);
          send({ type: 'jiggler', enabled });
        }}
        screenBlanked={screenBlanked}
        displayControlSupported={displayControlSupported}
        dictationAvailable={dictationAvailable}
        dictationState={dictationState}
        dictationMessage={dictationMessage}
        toggleDictation={toggleDictation}
        setScreenBlanked={(blanked) => {
          if (!displayControlSupported) return;
          setScreenBlanked(blanked);
          send({ type: 'display', blanked });
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
                placeholder="ABCD 2345 WXYZ"
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
              <span>or enter the 12-character code</span>
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
  hostNotice: string;
  jigglerEnabled: boolean;
  setJigglerEnabled(enabled: boolean): void;
  screenBlanked: boolean;
  displayControlSupported: boolean;
  dictationAvailable: boolean;
  dictationState: DictationState;
  dictationMessage: string;
  toggleDictation(): void;
  setScreenBlanked(blanked: boolean): void;
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
  hostNotice,
  jigglerEnabled,
  setJigglerEnabled,
  screenBlanked,
  displayControlSupported,
  dictationAvailable,
  dictationState,
  dictationMessage,
  toggleDictation,
  setScreenBlanked,
  send,
  disconnect,
  reconnect,
}: RemoteSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLButtonElement>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement>(null);
  const keyboardInputRef = useRef<HTMLInputElement>(null);
  const quickKeyboardInputRef = useRef<HTMLInputElement>(null);
  const inputHistoryRef = useRef(new WeakMap<HTMLInputElement, string>());
  const composingInputsRef = useRef(new WeakSet<HTMLInputElement>());
  const nativeFullscreenRef = useRef(false);
  const pointerState = useRef({
    points: new Map<number, {
      clientX: number;
      clientY: number;
      startX: number;
      startY: number;
    }>(),
    mouseDown: false,
    pressTimer: 0 as number | ReturnType<typeof setTimeout>,
    primaryId: null as number | null,
    moved: false,
    suppressTap: false,
    longPressed: false,
    cursor: { x: 0.5, y: 0.5 } as RemotePoint,
    multi: null as null | {
      mode: 'pending' | 'pinch' | 'scroll';
      startDistance: number;
      startMidpoint: RemotePoint;
      lastMidpoint: RemotePoint;
      startZoom: number;
      anchorScreen: RemotePoint;
      movedPointers: Set<number>;
    },
  });
  const contentBoxRef = useRef<RemoteRect>({ left: 0, top: 0, width: 0, height: 0 });
  const viewRef = useRef<RemoteView>({ scale: 1, centerX: 0.5, centerY: 0.5 });
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [powerAction, setPowerAction] = useState<'restart' | 'shutdown' | null>(null);
  const [activeModifiers, setActiveModifiers] = useState<Modifier[]>([]);
  const [cursor, setCursor] = useState<RemotePoint>({ x: 0.5, y: 0.5 });
  const [contentBox, setContentBox] = useState<RemoteRect>({ left: 0, top: 0, width: 0, height: 0 });
  const [view, setView] = useState<RemoteView>({ scale: 1, centerX: 0.5, centerY: 0.5 });
  const [magnifierOpen, setMagnifierOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [immersiveToolbarOpen, setImmersiveToolbarOpen] = useState(false);
  const [nativeKeyboardActive, setNativeKeyboardActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [pointerMode, setPointerMode] = useState<'touchpad' | 'direct'>(() => {
    if (typeof window === 'undefined') return 'touchpad';
    return window.localStorage.getItem('compctrl.pointerMode') === 'direct' ? 'direct' : 'touchpad';
  });
  const [dragSelectionEnabled, setDragSelectionEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('compctrl.dragSelection') === 'true';
  });
  const [tapToClick, setTapToClick] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('compctrl.tapToClick') !== 'false';
  });
  const [sensitivity, setSensitivity] = useState(() => {
    if (typeof window === 'undefined') return 1.25;
    return clamp(Number(window.localStorage.getItem('compctrl.sensitivity')) || 1.25, 0.6, 2);
  });
  const [magnifierPinned, setMagnifierPinned] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('compctrl.magnifierPinned') === 'true';
  });
  const [keyboardPanelEnabled, setKeyboardPanelEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('compctrl.keyboardPanel') === 'true';
  });

  const vibrate = useCallback((duration = 18) => {
    if ('vibrate' in navigator) navigator.vibrate(duration);
  }, []);

  const updateView = useCallback((next: RemoteView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const setImmersiveMode = useCallback(async (enabled: boolean) => {
    setImmersive(enabled);
    setImmersiveToolbarOpen(false);
    if (enabled) {
      try {
        if (document.fullscreenEnabled && !document.fullscreenElement) {
          await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
          nativeFullscreenRef.current = true;
        }
      } catch {
        nativeFullscreenRef.current = false;
      }
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }
    nativeFullscreenRef.current = false;
  }, []);

  const measureStage = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const video = videoRef.current;
    const next = containedRect(
      stage.clientWidth,
      stage.clientHeight,
      video?.videoWidth || 16,
      video?.videoHeight || 9,
    );
    contentBoxRef.current = next;
    setContentBox((current) => (
      Math.abs(current.left - next.left) < 0.5
      && Math.abs(current.top - next.top) < 0.5
      && Math.abs(current.width - next.width) < 0.5
      && Math.abs(current.height - next.height) < 0.5
        ? current
        : next
    ));
  }, []);

  const sendPointerAt = useCallback((action: 'move' | 'down' | 'up' | 'click', point: RemotePoint, button: 'left' | 'right' = 'left') => {
    send({ type: 'pointer', action, x: point.x, y: point.y, button });
  }, [send]);

  const moveCursor = useCallback((point: RemotePoint) => {
    const next = clampPoint(point);
    pointerState.current.cursor = next;
    setCursor(next);
    sendPointerAt('move', next);
    return next;
  }, [sendPointerAt]);

  const endActiveGesture = useCallback(() => {
    const state = pointerState.current;
    if (state.pressTimer) clearTimeout(state.pressTimer);
    state.pressTimer = 0;
    if (state.mouseDown) sendPointerAt('up', state.cursor);
    state.points.clear();
    state.mouseDown = false;
    state.primaryId = null;
    state.moved = false;
    state.suppressTap = false;
    state.longPressed = false;
    state.multi = null;
    setMagnifierOpen(false);
  }, [sendPointerAt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setVideoReady(false);
    video.srcObject = stream;
    const markVideoReady = () => {
      setVideoReady(true);
      measureStage();
    };
    if (stream) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) markVideoReady();
      void video.play().catch(() => setVideoReady(false));
    }
    measureStage();
    video.addEventListener('resize', measureStage);
    video.addEventListener('loadeddata', markVideoReady);
    video.addEventListener('playing', markVideoReady);
    return () => {
      video.removeEventListener('resize', measureStage);
      video.removeEventListener('loadeddata', markVideoReady);
      video.removeEventListener('playing', markVideoReady);
    };
  }, [measureStage, stream]);

  useEffect(() => {
    const video = videoRef.current as WebkitPiPVideo | null;
    if (!video) return;
    const standardSupported = Boolean(document.pictureInPictureEnabled && video.requestPictureInPicture);
    const webkitSupported = Boolean(video.webkitSupportsPresentationMode?.('picture-in-picture'));
    setPipSupported(standardSupported || webkitSupported);

    const entered = () => setPipActive(true);
    const left = () => setPipActive(false);
    const webkitChanged = () => setPipActive(video.webkitPresentationMode === 'picture-in-picture');
    video.addEventListener('enterpictureinpicture', entered);
    video.addEventListener('leavepictureinpicture', left);
    video.addEventListener('webkitpresentationmodechanged', webkitChanged);
    return () => {
      video.removeEventListener('enterpictureinpicture', entered);
      video.removeEventListener('leavepictureinpicture', left);
      video.removeEventListener('webkitpresentationmodechanged', webkitChanged);
    };
  }, []);

  useEffect(() => {
    if (!stream) setPipActive(false);
  }, [stream]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(measureStage);
    observer.observe(stage);
    window.addEventListener('resize', measureStage);
    window.addEventListener('orientationchange', endActiveGesture);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measureStage);
      window.removeEventListener('orientationchange', endActiveGesture);
    };
  }, [endActiveGesture, measureStage]);

  useEffect(() => {
    const shell = stageRef.current?.closest<HTMLElement>('.remote-shell');
    const viewport = window.visualViewport;
    if (!shell) return;
    const syncViewport = () => {
      shell.style.setProperty('--controller-visual-height', `${viewport?.height ?? window.innerHeight}px`);
      shell.style.setProperty('--controller-visual-top', `${viewport?.offsetTop ?? 0}px`);
      window.requestAnimationFrame(measureStage);
    };
    syncViewport();
    viewport?.addEventListener('resize', syncViewport);
    viewport?.addEventListener('scroll', syncViewport);
    return () => {
      viewport?.removeEventListener('resize', syncViewport);
      viewport?.removeEventListener('scroll', syncViewport);
      shell.style.removeProperty('--controller-visual-height');
      shell.style.removeProperty('--controller-visual-top');
    };
  }, [measureStage]);

  useEffect(() => () => endActiveGesture(), [endActiveGesture]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && nativeFullscreenRef.current) {
        nativeFullscreenRef.current = false;
        setImmersive(false);
        setImmersiveToolbarOpen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('compctrl.pointerMode', pointerMode);
    window.localStorage.setItem('compctrl.dragSelection', String(dragSelectionEnabled));
    window.localStorage.setItem('compctrl.tapToClick', String(tapToClick));
    window.localStorage.setItem('compctrl.sensitivity', String(sensitivity));
    window.localStorage.setItem('compctrl.magnifierPinned', String(magnifierPinned));
    window.localStorage.setItem('compctrl.keyboardPanel', String(keyboardPanelEnabled));
  }, [dragSelectionEnabled, keyboardPanelEnabled, magnifierPinned, pointerMode, sensitivity, tapToClick]);

  const magnifierVisible = Boolean(stream) && (magnifierOpen || magnifierPinned);

  useEffect(() => {
    if (!magnifierVisible) return;
    let frame = 0;
    const draw = () => {
      const video = videoRef.current;
      const canvas = magnifierCanvasRef.current;
      const box = contentBoxRef.current;
      if (video && canvas && video.readyState >= 2 && video.videoWidth && box.width) {
        const cssSize = 176;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const pixelSize = Math.round(cssSize * ratio);
        if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
          canvas.width = pixelSize;
          canvas.height = pixelSize;
        }
        const cropWidth = Math.min(video.videoWidth, video.videoWidth * cssSize / (box.width * 3));
        const cropHeight = Math.min(video.videoHeight, video.videoHeight * cssSize / (box.height * 3));
        const desiredX = pointerState.current.cursor.x * video.videoWidth - cropWidth / 2;
        const desiredY = pointerState.current.cursor.y * video.videoHeight - cropHeight / 2;
        const sourceX = clamp(desiredX, 0, video.videoWidth);
        const sourceY = clamp(desiredY, 0, video.videoHeight);
        const sourceRight = clamp(desiredX + cropWidth, 0, video.videoWidth);
        const sourceBottom = clamp(desiredY + cropHeight, 0, video.videoHeight);
        const sourceWidth = Math.max(0, sourceRight - sourceX);
        const sourceHeight = Math.max(0, sourceBottom - sourceY);
        const destinationX = (sourceX - desiredX) / cropWidth * pixelSize;
        const destinationY = (sourceY - desiredY) / cropHeight * pixelSize;
        const destinationWidth = sourceWidth / cropWidth * pixelSize;
        const destinationHeight = sourceHeight / cropHeight * pixelSize;
        const context = canvas.getContext('2d');
        if (context) {
          context.fillStyle = '#080b11';
          context.fillRect(0, 0, pixelSize, pixelSize);
          if (sourceWidth && sourceHeight) {
            context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, destinationX, destinationY, destinationWidth, destinationHeight);
          }
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [magnifierVisible]);

  const handleHardwareKey = (event: ReactKeyboardEvent<HTMLButtonElement>, action: 'down' | 'up') => {
    if (event.nativeEvent.isComposing || event.key === 'Unidentified') return;
    event.preventDefault();
    send({ type: 'key', action: event.repeat ? 'tap' : action, key: event.key });
  };

  const sendPointer = useCallback((action: 'move' | 'down' | 'up' | 'click', button: 'left' | 'right' = 'left') => {
    sendPointerAt(action, pointerState.current.cursor, button);
    if (action === 'click') vibrate();
  }, [sendPointerAt, vibrate]);

  const clientToDisplay = useCallback((clientX: number, clientY: number): RemotePoint => {
    const stageRect = stageRef.current?.getBoundingClientRect();
    const box = contentBoxRef.current;
    if (!stageRect || !box.width || !box.height) return { x: 0.5, y: 0.5 };
    return {
      x: (clientX - stageRect.left - box.left) / box.width,
      y: (clientY - stageRect.top - box.top) / box.height,
    };
  }, []);

  const midpointForPoints = (points: Array<{ clientX: number; clientY: number }>) => ({
    x: points.reduce((sum, point) => sum + point.clientX, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.clientY, 0) / points.length,
  });

  const beginMultiGesture = () => {
    const state = pointerState.current;
    const points = Array.from(state.points.values()).slice(0, 2);
    if (points.length < 2) return;
    const midpoint = midpointForPoints(points);
    const distance = Math.hypot(points[1].clientX - points[0].clientX, points[1].clientY - points[0].clientY);
    state.multi = {
      mode: 'pending',
      startDistance: Math.max(distance, 1),
      startMidpoint: midpoint,
      lastMidpoint: midpoint,
      startZoom: viewRef.current.scale,
      anchorScreen: displayToScreen(clientToDisplay(midpoint.x, midpoint.y), viewRef.current),
      movedPointers: new Set(),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const state = pointerState.current;
    state.points.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    if (state.points.size === 1) {
      state.primaryId = event.pointerId;
      state.moved = false;
      state.suppressTap = false;
      state.longPressed = false;
      if (pointerMode === 'direct') {
        moveCursor(displayToScreen(clientToDisplay(event.clientX, event.clientY), viewRef.current));
      }
      state.pressTimer = window.setTimeout(() => {
        if (state.points.size === 1 && !state.moved) {
          state.longPressed = true;
          setMagnifierOpen(true);
          vibrate(28);
        }
      }, 420);
    } else {
      clearTimeout(state.pressTimer);
      state.pressTimer = 0;
      if (state.mouseDown) sendPointerAt('up', state.cursor);
      state.mouseDown = false;
      state.longPressed = false;
      state.moved = true;
      state.suppressTap = true;
      setMagnifierOpen(false);
      beginMultiGesture();
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const state = pointerState.current;
    const previous = state.points.get(event.pointerId);
    if (!previous) return;
    const current = { ...previous, clientX: event.clientX, clientY: event.clientY };
    state.points.set(event.pointerId, current);
    if (state.points.size >= 2) {
      if (!state.multi) beginMultiGesture();
      const multi = state.multi;
      const points = Array.from(state.points.values()).slice(0, 2);
      if (!multi || points.length < 2) return;
      const midpoint = midpointForPoints(points);
      const distance = Math.hypot(points[1].clientX - points[0].clientX, points[1].clientY - points[0].clientY);
      const spreadChange = Math.abs(distance - multi.startDistance);
      const midpointTravel = Math.hypot(midpoint.x - multi.startMidpoint.x, midpoint.y - multi.startMidpoint.y);
      multi.movedPointers.add(event.pointerId);
      if (multi.mode === 'pending' && multi.movedPointers.size >= 2 && (spreadChange > 7 || midpointTravel > 8)) {
        multi.mode = spreadChange > midpointTravel * 0.7 ? 'pinch' : 'scroll';
      }
      if (multi.mode === 'pinch') {
        const nextScale = clamp(multi.startZoom * distance / multi.startDistance, 1, MAX_VIEW_SCALE);
        updateView(viewAroundAnchor(nextScale, multi.anchorScreen, clientToDisplay(midpoint.x, midpoint.y)));
      } else if (multi.mode === 'scroll') {
        const deltaX = (multi.lastMidpoint.x - midpoint.x) * 1.35;
        const deltaY = (multi.lastMidpoint.y - midpoint.y) * 2.2;
        if (Math.abs(deltaX) > 0.4 || Math.abs(deltaY) > 0.4) send({ type: 'wheel', deltaX, deltaY });
      }
      multi.lastMidpoint = midpoint;
      return;
    }

    if (state.primaryId !== event.pointerId) return;
    const totalMovement = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    if (totalMovement > 6) {
      state.moved = true;
      if (!state.longPressed) {
        clearTimeout(state.pressTimer);
        state.pressTimer = 0;
      }
    }
    if (dragSelectionEnabled && state.moved && !state.longPressed && !state.mouseDown) {
      state.mouseDown = true;
      sendPointerAt('down', state.cursor);
    }

    let next: RemotePoint;
    if (pointerMode === 'direct' && !state.longPressed) {
      next = displayToScreen(clientToDisplay(event.clientX, event.clientY), viewRef.current);
    } else {
      const box = contentBoxRef.current;
      const speed = state.longPressed ? 0.32 : sensitivity;
      next = {
        x: state.cursor.x + (event.clientX - previous.clientX) / Math.max(box.width, 1) * speed,
        y: state.cursor.y + (event.clientY - previous.clientY) / Math.max(box.height, 1) * speed,
      };
    }
    moveCursor(next);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    event.preventDefault();
    const state = pointerState.current;
    const wasPrimarySingle = state.points.size === 1 && state.primaryId === event.pointerId;
    state.points.delete(event.pointerId);
    if (wasPrimarySingle) {
      clearTimeout(state.pressTimer);
      state.pressTimer = 0;
      if (state.mouseDown) sendPointerAt('up', state.cursor);
      else if (!cancelled && !state.longPressed && !state.moved && !state.suppressTap && tapToClick) sendPointer('click');
      state.mouseDown = false;
      state.primaryId = null;
      state.longPressed = false;
      state.moved = false;
      state.suppressTap = false;
      state.multi = null;
      setMagnifierOpen(false);
      return;
    }

    state.multi = null;
    if (state.points.size === 1) {
      const [remainingId, remaining] = Array.from(state.points.entries())[0];
      remaining.startX = remaining.clientX;
      remaining.startY = remaining.clientY;
      state.primaryId = remainingId;
      state.moved = false;
      state.suppressTap = true;
    } else {
      state.primaryId = null;
      state.moved = false;
      state.suppressTap = false;
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

  const relayInputValue = (input: HTMLInputElement) => {
    const previous = inputHistoryRef.current.get(input) ?? '';
    const next = input.value;
    if (previous === next) return;
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
    // The Windows caret is kept at the end of this relay buffer. Rebuild the
    // changed tail so mobile autocorrect, swipe typing, and mid-word edits stay
    // in sync instead of inserting replacement text in the wrong position.
    const removed = previous.length - prefix;
    const inserted = next.slice(prefix);
    for (let index = 0; index < removed; index += 1) {
      send({ type: 'key', action: 'tap', key: 'Backspace' });
    }
    if (inserted) send({ type: 'text', text: inserted });
    inputHistoryRef.current.set(input, next);
  };

  const relayKeyboardInput = (event: ReactSyntheticEvent<HTMLInputElement>) => {
    if (!composingInputsRef.current.has(event.currentTarget)) relayInputValue(event.currentTarget);
  };

  const relayKeyboardKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      if (event.currentTarget.value.length === 0) {
        event.preventDefault();
        send({ type: 'key', action: 'tap', key: 'Backspace', modifiers: activeModifiers });
        setActiveModifiers([]);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') {
      event.preventDefault();
      send({ type: 'key', action: 'tap', key: event.key, modifiers: activeModifiers });
      setActiveModifiers([]);
      if (event.key === 'Enter') {
        event.currentTarget.value = '';
        inputHistoryRef.current.set(event.currentTarget, '');
      }
    }
  };

  const beginKeyboardComposition = (event: ReactSyntheticEvent<HTMLInputElement>) => {
    composingInputsRef.current.add(event.currentTarget);
  };

  const finishKeyboardComposition = (event: ReactSyntheticEvent<HTMLInputElement>) => {
    composingInputsRef.current.delete(event.currentTarget);
    relayInputValue(event.currentTarget);
  };

  const openPhoneKeyboard = () => {
    if (keyboardPanelEnabled) {
      setKeyboardOpen(true);
      window.setTimeout(() => keyboardInputRef.current?.focus(), 350);
      return;
    }
    const input = quickKeyboardInputRef.current;
    if (input && !nativeKeyboardActive) {
      input.value = '';
      inputHistoryRef.current.set(input, '');
    }
    setNativeKeyboardActive(true);
    input?.focus({ preventScroll: true });
  };

  const setPictureInPicture = async (enabled: boolean) => {
    const video = videoRef.current as WebkitPiPVideo | null;
    if (!video || !stream) return;
    try {
      if (enabled) {
        if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
          await video.requestPictureInPicture();
        } else if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
          video.webkitSetPresentationMode?.('picture-in-picture');
        }
      } else if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.webkitPresentationMode === 'picture-in-picture') {
        video.webkitSetPresentationMode?.('inline');
      }
    } catch {
      setPipActive(false);
    }
  };

  const connected = connectionState === 'connected';
  const dictationBusy = dictationState === 'sending' || dictationState === 'transcribing';
  const dictationLabel = dictationState === 'recording' ? 'Stop' : dictationBusy ? 'Wait' : 'Voice';
  const statusText = connected
    ? stream ? 'Live' : 'Securing video'
    : connectionState === 'offline' ? 'Phone offline' : retryCount ? `Reconnecting · ${retryCount}` : 'Connecting';
  const cursorDisplay = screenToDisplay(cursor, view);
  const cursorVisible = cursorDisplay.x >= 0 && cursorDisplay.x <= 1 && cursorDisplay.y >= 0 && cursorDisplay.y <= 1;
  const videoStyle = {
    transform: `matrix(${view.scale}, 0, 0, ${view.scale}, ${contentBox.width * (0.5 - view.scale * view.centerX)}, ${contentBox.height * (0.5 - view.scale * view.centerY)})`,
  } as CSSProperties;
  const viewportStyle = {
    left: contentBox.left,
    top: contentBox.top,
    width: contentBox.width,
    height: contentBox.height,
  } as CSSProperties;

  return (
    <main className={`remote-shell ${immersive ? 'is-immersive' : ''} ${immersive && !immersiveToolbarOpen ? 'controls-hidden' : ''} ${nativeKeyboardActive ? 'has-native-keyboard' : ''} ${screenBlanked ? 'screen-blanked' : ''}`}>
      <header className="remote-topbar">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className={`remote-state-dot ${connected ? 'is-live' : ''}`} /><strong className="truncate">{computerName}</strong></div>
          <p>{statusText}{screenBlanked ? ' · Displays powered off' : ''} · {code.slice(0, 4)} {code.slice(4, 8)} {code.slice(8)}</p>
        </div>
        <div className="remote-topbar-actions">
          <Button variant="ghost" size="icon-lg" className="remote-icon-button" onClick={() => void setImmersiveMode(true)} aria-label="Enter fullscreen controller">
            <Maximize2 className="size-5" />
          </Button>
          <Button variant="ghost" size="icon-lg" className="remote-icon-button" onClick={() => setControlsOpen(true)} aria-label="Open session controls">
            <Menu className="size-5" />
          </Button>
        </div>
      </header>

      <div className="remote-stage-wrap">
        <button
          ref={stageRef}
          type="button"
          className="remote-video-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finishPointer(event)}
          onPointerCancel={(event) => finishPointer(event, true)}
          onKeyDown={(event) => handleHardwareKey(event, 'down')}
          onKeyUp={(event) => handleHardwareKey(event, 'up')}
          onContextMenu={(event) => event.preventDefault()}
          aria-label="Remote computer touchpad. Swipe to move, tap to click, hold for a magnified precision view, use two fingers to scroll, or pinch to zoom."
        >
        <span className="remote-video-viewport" style={viewportStyle}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className={`remote-video ${stream ? 'is-visible' : ''}`}
            style={videoStyle}
            onLoadedMetadata={measureStage}
          />
          {stream && cursorVisible && (
            <span
              className={`remote-cursor ${magnifierOpen ? 'is-precision' : ''}`}
              style={{ left: `${cursorDisplay.x * 100}%`, top: `${cursorDisplay.y * 100}%` }}
              aria-hidden="true"
            >
              <MousePointer2 />
            </span>
          )}
        </span>
        {!stream && (
          <span className="remote-empty">
            {connected ? <Monitor className="size-8" /> : <WifiOff className="size-8" />}
            <strong>{connected ? 'Starting live screen…' : 'Finding your computer…'}</strong>
            <span>{connected ? hostNotice || 'The companion is preparing the display.' : 'We will reconnect automatically when it is available.'}</span>
            {!connected && <span className="retry-note"><RefreshCw /> Retrying automatically</span>}
          </span>
        )}
        {magnifierVisible && (
          <span className={`precision-loupe ${cursorDisplay.x > 0.5 ? 'is-left' : 'is-right'}`} aria-live="polite">
            <canvas ref={magnifierCanvasRef} />
            <span className="loupe-crosshair" aria-hidden="true"><Crosshair /></span>
            <strong>{magnifierOpen ? '3× precision' : '3× magnifier'}</strong>
          </span>
        )}
        {stream && (
          <span className="touch-hint">
            {pointerMode === 'touchpad' ? 'Swipe to move' : 'Touch to position'} · Hold for 3× precision · Pinch to zoom
          </span>
        )}
        </button>
        {connected && (!stream || !videoReady) && (
          <button type="button" className="stream-retry-button" onClick={() => send({ type: 'stream', action: 'request' })}>
            <RefreshCw /> {stream ? 'Restart screen' : 'Retry screen'}
          </button>
        )}
        {stream && view.scale > 1.01 && (
          <button
            type="button"
            className="view-zoom-reset"
            onClick={() => updateView({ scale: 1, centerX: 0.5, centerY: 0.5 })}
          >
            <ZoomOut /> {view.scale.toFixed(1)}× · Reset
          </button>
        )}
        {screenBlanked && (
          <button type="button" className="screen-blank-chip" onClick={() => setScreenBlanked(false)}>
            <EyeOff /> Displays off <small>Turn on</small>
          </button>
        )}
        {dictationState !== 'idle' && dictationMessage && (
          <output className={`dictation-chip is-${dictationState}`} aria-live="polite">
            {dictationState === 'recording' ? <MicOff /> : <Mic />} {dictationMessage}
          </output>
        )}
        <div className={`scroll-buttons ${immersive ? 'has-clicks' : ''}`} aria-label="Pointer and scroll controls">
          {immersive && (
            <>
              <button type="button" className="is-primary" onClick={() => sendPointer('click')} disabled={!connected} aria-label="Left click">
                <MousePointerClick /><span>Left</span>
              </button>
              <button type="button" onClick={() => sendPointer('click', 'right')} disabled={!connected} aria-label="Right click">
                <MousePointer2 /><span>Right</span>
              </button>
            </>
          )}
          <button type="button" onClick={() => send({ type: 'wheel', deltaX: 0, deltaY: -360 })} disabled={!connected} aria-label="Scroll up">
            <ChevronUp /><span>Up</span>
          </button>
          <button type="button" onClick={() => send({ type: 'wheel', deltaX: 0, deltaY: 360 })} disabled={!connected} aria-label="Scroll down">
            <ChevronDown /><span>Down</span>
          </button>
          {immersive && (
            <>
              <button type="button" onClick={() => send({ type: 'key', action: 'tap', key: 'Enter' })} disabled={!connected} aria-label="Press Enter">
                <CornerDownLeft /><span>Enter</span>
              </button>
              <button type="button" className={dictationState === 'recording' ? 'is-recording' : ''} onClick={toggleDictation} disabled={!connected || !dictationAvailable || dictationBusy} aria-label={dictationState === 'recording' ? 'Stop and transcribe voice recording' : 'Start voice dictation'}>
                {dictationState === 'recording' ? <MicOff /> : <Mic />}<span>{dictationLabel}</span>
              </button>
            </>
          )}
        </div>
      </div>

      <nav className="remote-toolbar" aria-label="Remote control shortcuts">
        <Button className="shortcut-button" onClick={() => send({ type: 'key', action: 'tap', key: 'c', modifiers: ['Control'] })}>
          <Copy /><span><small>Ctrl</small>C</span>
        </Button>
        <Button className="shortcut-button" onClick={() => send({ type: 'key', action: 'tap', key: 'v', modifiers: ['Control'] })}>
          <Clipboard /><span><small>Ctrl</small>V</span>
        </Button>
        <Button variant="secondary" className="toolbar-button" onClick={openPhoneKeyboard}>
          <Keyboard /><span>{keyboardPanelEnabled ? 'PC keys' : 'Type'}</span>
        </Button>
        <Button variant="secondary" className="toolbar-button" onClick={() => sendPointer('click')}>
          <MousePointerClick /><span>Click</span>
        </Button>
        <Button variant="secondary" className="toolbar-button" onClick={() => sendPointer('click', 'right')}>
          <MousePointer2 /><span>Right</span>
        </Button>
        <Button variant="secondary" className={`toolbar-button ${dictationState === 'recording' ? 'is-recording' : ''}`} onClick={toggleDictation} disabled={!connected || !dictationAvailable || dictationBusy}>
          {dictationState === 'recording' ? <MicOff /> : <Mic />}<span>{dictationLabel}</span>
        </Button>
      </nav>

      {immersive && (
        <>
          <Button variant="secondary" size="icon-lg" className="immersive-exit" onClick={() => void setImmersiveMode(false)} aria-label="Exit fullscreen controller">
            <Minimize2 />
          </Button>
          <Button
            variant="secondary"
            size="icon-lg"
            className={`immersive-toolbar-toggle ${immersiveToolbarOpen ? 'is-raised' : ''}`}
            onClick={() => setImmersiveToolbarOpen((open) => !open)}
            aria-label={immersiveToolbarOpen ? 'Hide controller toolbar' : 'Show controller toolbar'}
          >
            {immersiveToolbarOpen ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </>
      )}

      <div
        className={`native-keyboard-capture ${nativeKeyboardActive ? 'is-active' : ''}`}
        aria-label="Phone keyboard input"
        aria-hidden={!nativeKeyboardActive}
      >
        <Keyboard aria-hidden="true" />
        <Input
          ref={quickKeyboardInputRef}
          className="native-keyboard-input"
          placeholder="Type directly to Windows…"
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
          enterKeyHint="enter"
          tabIndex={nativeKeyboardActive ? 0 : -1}
          onFocus={() => setNativeKeyboardActive(true)}
          onInput={relayKeyboardInput}
          onKeyDown={relayKeyboardKey}
          onCompositionStart={beginKeyboardComposition}
          onCompositionEnd={finishKeyboardComposition}
          onBlur={() => setNativeKeyboardActive(false)}
        />
        <button
          type="button"
          className="native-keyboard-special"
          tabIndex={nativeKeyboardActive ? 0 : -1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            quickKeyboardInputRef.current?.blur();
            setNativeKeyboardActive(false);
            setKeyboardOpen(true);
          }}
        >
          PC keys
        </button>
        <button
          type="button"
          className="native-keyboard-close"
          tabIndex={nativeKeyboardActive ? 0 : -1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            quickKeyboardInputRef.current?.blur();
            setNativeKeyboardActive(false);
          }}
          aria-label="Close phone keyboard"
        >
          <X />
        </button>
      </div>

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
              spellCheck
              enterKeyHint="enter"
              onInput={relayKeyboardInput}
              onKeyDown={relayKeyboardKey}
              onCompositionStart={beginKeyboardComposition}
              onCompositionEnd={finishKeyboardComposition}
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
            <DrawerDescription>Screen space, pointer feel, keyboard, connection, and computer power.</DrawerDescription>
          </DrawerHeader>
          <div className="control-list">
            <div className="control-section-label">View</div>
            <div className="control-row">
              <span className="control-row-icon"><Maximize2 /></span>
              <span><strong>Immersive fullscreen</strong><small>Hide the top bar; reveal the bottom controls when needed</small></span>
              <Switch
                checked={immersive}
                onCheckedChange={(checked) => {
                  setControlsOpen(false);
                  void setImmersiveMode(checked);
                }}
                aria-label="Toggle immersive fullscreen"
              />
            </div>
            <div className="control-row">
              <span className="control-row-icon"><Crosshair /></span>
              <span><strong>Permanent magnifier</strong><small>Keep the 3× crosshair view visible while moving</small></span>
              <Switch checked={magnifierPinned} onCheckedChange={setMagnifierPinned} aria-label="Always show precision magnifier" />
            </div>
            <div className="control-row">
              <span className="control-row-icon"><PictureInPicture2 /></span>
              <span>
                <strong>Floating mini video</strong>
                <small>{pipSupported ? 'Keep the computer visible over other apps' : 'Not available in this browser'}</small>
              </span>
              <Switch
                checked={pipActive}
                disabled={!pipSupported || !stream}
                onCheckedChange={(checked) => void setPictureInPicture(checked)}
                aria-label="Show the computer in picture-in-picture"
              />
            </div>
            <div className="control-section-label">Pointer</div>
            <div className="control-row">
              <span className="control-row-icon"><Hand /></span>
              <span><strong>Touchpad mode</strong><small>Swipe anywhere to move the pointer relatively</small></span>
              <Switch checked={pointerMode === 'touchpad'} onCheckedChange={(checked) => setPointerMode(checked ? 'touchpad' : 'direct')} aria-label="Use touchpad mode" />
            </div>
            <div className="control-row">
              <span className="control-row-icon"><MousePointerClick /></span>
              <span><strong>Tap to click</strong><small>Two quick taps work as a double-click</small></span>
              <Switch checked={tapToClick} onCheckedChange={setTapToClick} aria-label="Toggle tap to click" />
            </div>
            <div className="control-row">
              <span className="control-row-icon"><Crosshair /></span>
              <span><strong>Drag and select</strong><small>Hold the Windows mouse button while swiping</small></span>
              <Switch checked={dragSelectionEnabled} onCheckedChange={setDragSelectionEnabled} aria-label="Toggle drag and text selection" />
            </div>
            <div className="control-row control-slider-row">
              <span className="control-row-icon"><Gauge /></span>
              <span><strong>Pointer speed</strong><small>Long-press precision always stays slow</small></span>
              <span className="pointer-speed-control">
                <output>{sensitivity.toFixed(1)}×</output>
                <Slider value={[sensitivity]} min={0.6} max={2} step={0.1} onValueChange={(value) => setSensitivity(typeof value === 'number' ? value : value[0] ?? 1.25)} aria-label="Pointer speed" />
              </span>
            </div>
            {view.scale > 1.01 && (
              <button type="button" className="control-row" onClick={() => updateView({ scale: 1, centerX: 0.5, centerY: 0.5 })}>
                <span className="control-row-icon"><ZoomOut /></span><span><strong>Reset screen zoom</strong><small>Return to the full desktop view</small></span><ArrowRight />
              </button>
            )}
            <div className="control-section-label">Keyboard</div>
            <div className="control-row">
              <span className="control-row-icon"><Keyboard /></span>
              <span><strong>Show full PC key panel</strong><small>When off, Type opens only your phone keyboard</small></span>
              <Switch
                checked={keyboardPanelEnabled}
                onCheckedChange={(checked) => {
                  setKeyboardPanelEnabled(checked);
                  if (checked) {
                    quickKeyboardInputRef.current?.blur();
                    setNativeKeyboardActive(false);
                  } else {
                    setKeyboardOpen(false);
                  }
                }}
                aria-label="Open the full PC key panel from the keyboard button"
              />
            </div>
            <div className="control-row">
              <span className="control-row-icon"><Mic /></span>
              <span><strong>Groq voice dictation</strong><small>{dictationAvailable ? 'Ready · focuses the current Windows text field' : 'Add an API key in the Windows companion'}</small></span>
              <ShieldCheck className={dictationAvailable ? 'text-emerald-400' : 'opacity-30'} />
            </div>
            <div className="control-section-label">Session</div>
            {connected && (
              <button
                type="button"
                className="control-row"
                onClick={() => {
                  setVideoReady(false);
                  setControlsOpen(false);
                  send({ type: 'stream', action: 'request' });
                }}
              >
                <span className="control-row-icon"><RefreshCw /></span><span><strong>Restart screen stream</strong><small>Recapture the desktop if video is black or frozen</small></span><ArrowRight />
              </button>
            )}
            {!connected && (
              <button type="button" className="control-row" onClick={reconnect}>
                <span className="control-row-icon"><RefreshCw /></span><span><strong>Retry connection</strong><small>Start a fresh rendezvous now</small></span><ArrowRight />
              </button>
            )}
            <div className="control-row">
              <span className="control-row-icon"><EyeOff /></span>
              <span>
                <strong>Power local displays off</strong>
                <small>{displayControlSupported ? 'Hardware power-off · kept off after remote input' : 'Install the latest Windows companion to enable'}</small>
              </span>
              <Switch
                checked={screenBlanked}
                disabled={!displayControlSupported}
                onCheckedChange={setScreenBlanked}
                aria-label="Turn the computer screens off locally"
              />
            </div>
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
