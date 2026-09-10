'use client';

import type { DataConnection, MediaConnection } from 'peerjs';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleHelp,
  Copy,
  EyeOff,
  ExternalLink,
  Laptop,
  Link2,
  KeyRound,
  MonitorUp,
  MousePointer2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unplug,
  Wifi,
  WifiOff,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { newPeer } from '@/lib/peer';
import {
  type ControllerMessage,
  type HostMessage,
  CODE_LENGTH,
  PROTOCOL_VERSION,
  authProofForCode,
  cleanCode,
  createPairingCode,
  createSecurityToken,
  isControllerMessage,
  peerIdForCode,
} from '@/lib/protocol';

type HostState = 'starting' | 'ready' | 'connected' | 'reconnecting' | 'error';

function normalizeControllerUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function HostController() {
  const api = window.compCtrl;
  const [hostState, setHostState] = useState<HostState>('starting');
  const [pairingCode, setPairingCode] = useState('');
  const [hostPeerId, setHostPeerId] = useState('');
  const [computerName, setComputerName] = useState('Windows PC');
  const [controllerUrl, setControllerUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [jigglerEnabled, setJigglerEnabled] = useState(false);
  const [screenBlanked, setScreenBlanked] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [groqKeyConfigured, setGroqKeyConfigured] = useState(false);
  const [groqKeyDraft, setGroqKeyDraft] = useState('');
  const [controllerName, setControllerName] = useState('Phone');
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('Starting secure session…');
  const jigglerRef = useRef(false);
  const screenBlankedRef = useRef(false);
  const groqKeyConfiguredRef = useRef(false);
  const dictationsRef = useRef(new Map<string, { mimeType: string; chunks: Map<number, string>; encodedBytes: number }>());
  const connectionRef = useRef<DataConnection | null>(null);
  const callRef = useRef<MediaConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<ReturnType<typeof newPeer> | null>(null);
  const shareScreenRef = useRef<(() => Promise<void>) | null>(null);
  const capturePendingRef = useRef(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const activeCall = callRef.current;
    callRef.current = null;
    activeCall?.close();
  }, []);

  useEffect(() => { jigglerRef.current = jigglerEnabled; }, [jigglerEnabled]);
  useEffect(() => { screenBlankedRef.current = screenBlanked; }, [screenBlanked]);
  useEffect(() => { groqKeyConfiguredRef.current = groqKeyConfigured; }, [groqKeyConfigured]);

  useEffect(() => {
    if (!pairingCode) {
      setHostPeerId('');
      return;
    }
    let disposed = false;
    setHostPeerId('');
    void peerIdForCode(pairingCode).then((id) => { if (!disposed) setHostPeerId(id); });
    return () => { disposed = true; };
  }, [pairingCode]);

  const send = useCallback((message: HostMessage) => {
    if (connectionRef.current?.open) void connectionRef.current.send(message);
  }, []);

  const handleControllerMessage = useCallback(async (message: ControllerMessage) => {
    if (!api) return;
    if (message.type === 'ping') {
      send({ type: 'pong', sentAt: message.sentAt });
      return;
    }
    if (message.type === 'jiggler') {
      await api.setJiggler(message.enabled);
      setJigglerEnabled(message.enabled);
      send({ type: 'status', jigglerEnabled: message.enabled, screenBlanked: screenBlankedRef.current, dictationAvailable: groqKeyConfiguredRef.current });
      return;
    }
    if (message.type === 'display') {
      const blanked = await api.setDisplayBlanked(message.blanked);
      setScreenBlanked(blanked);
      setNotice(blanked ? 'Local displays powered off' : 'Local displays restored');
      send({ type: 'status', jigglerEnabled: jigglerRef.current, screenBlanked: blanked, dictationAvailable: groqKeyConfiguredRef.current });
      return;
    }
    if (message.type === 'dictation-start') {
      if (!groqKeyConfiguredRef.current) {
        send({ type: 'dictation-status', id: message.id, status: 'error', message: 'Add a Groq API key in the Windows companion first.' });
        return;
      }
      dictationsRef.current.clear();
      dictationsRef.current.set(message.id, { mimeType: message.mimeType, chunks: new Map(), encodedBytes: 0 });
      send({ type: 'dictation-status', id: message.id, status: 'receiving', message: 'Receiving voice recording…' });
      return;
    }
    if (message.type === 'dictation-chunk') {
      const recording = dictationsRef.current.get(message.id);
      if (!recording || recording.chunks.has(message.index)) return;
      recording.encodedBytes += message.data.length;
      if (recording.encodedBytes > 28 * 1024 * 1024) {
        dictationsRef.current.delete(message.id);
        send({ type: 'dictation-status', id: message.id, status: 'error', message: 'Recording is too large. Keep dictation under 90 seconds.' });
        return;
      }
      recording.chunks.set(message.index, message.data);
      return;
    }
    if (message.type === 'dictation-end') {
      const recording = dictationsRef.current.get(message.id);
      if (!recording || recording.chunks.size !== message.totalChunks) {
        dictationsRef.current.delete(message.id);
        send({ type: 'dictation-status', id: message.id, status: 'error', message: 'Some recorded audio was lost. Please try again.' });
        return;
      }
      const chunks = Array.from({ length: message.totalChunks }, (_, index) => recording.chunks.get(index) ?? '');
      if (chunks.some((chunk) => !chunk)) {
        dictationsRef.current.delete(message.id);
        send({ type: 'dictation-status', id: message.id, status: 'error', message: 'Some recorded audio was lost. Please try again.' });
        return;
      }
      dictationsRef.current.delete(message.id);
      send({ type: 'dictation-status', id: message.id, status: 'transcribing', message: 'Groq is transcribing…' });
      try {
        const transcript = await api.transcribeAudio(chunks, recording.mimeType);
        await api.dispatch({ type: 'text', text: transcript });
        send({ type: 'dictation-status', id: message.id, status: 'done', message: `Inserted ${transcript.length} characters.` });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Transcription failed.';
        send({ type: 'dictation-status', id: message.id, status: 'error', message: detail.slice(0, 256) });
      }
      return;
    }
    if (message.type === 'dictation-cancel') {
      dictationsRef.current.delete(message.id);
      return;
    }
    if (message.type === 'stream') {
      await shareScreenRef.current?.();
      return;
    }
    if (message.type === 'system') {
      await api.systemAction(message.action);
      return;
    }
    await api.dispatch(message);
  }, [api, send]);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    void api.getSettings().then((settings) => {
      if (disposed) return;
      const storedCode = cleanCode(settings.pairingCode);
      const code = storedCode.length === CODE_LENGTH ? storedCode : createPairingCode();
      setPairingCode(code);
      setComputerName(settings.computerName);
      setControllerUrl(settings.controllerUrl);
      setUrlDraft(settings.controllerUrl);
      setJigglerEnabled(settings.jigglerEnabled);
      setScreenBlanked(settings.screenBlanked);
      setAutoStart(settings.autoStart);
      setGroqKeyConfigured(settings.groqKeyConfigured);
      void api.saveSettings({ pairingCode: code });
    });
    return () => { disposed = true; };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.onDisplayState((blanked) => {
      setScreenBlanked(blanked);
      setNotice(blanked ? 'Local displays powered off' : 'Local displays restored');
      send({ type: 'status', jigglerEnabled: jigglerRef.current, screenBlanked: blanked, dictationAvailable: groqKeyConfiguredRef.current });
    });
  }, [api, send]);

  useEffect(() => {
    if (!api || !pairingCode || !hostPeerId) return;
    let disposed = false;
    const peer = newPeer(hostPeerId);
    const pendingConnections = new Set<DataConnection>();
    peerRef.current = peer;
    setHostState('starting');
    setNotice('Opening P2P rendezvous…');

    const returnToReady = (closedConnection?: DataConnection) => {
      if (disposed || (closedConnection && connectionRef.current !== closedConnection)) return;
      connectionRef.current = null;
      shareScreenRef.current = null;
      stopStream();
      setControllerName('Phone');
      setHostState('ready');
      setNotice('Waiting for your phone');
    };

    const shareScreenWith = async (remoteId: string) => {
      if (capturePendingRef.current || !connectionRef.current?.open) return;
      capturePendingRef.current = true;
      setNotice('Starting desktop capture…');
      send({ type: 'notice', message: 'Starting desktop capture…' });
      try {
        stopStream();
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 24, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (disposed || !connectionRef.current?.open) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setNotice('Desktop captured — connecting video…');
        send({ type: 'notice', message: 'Desktop captured. Connecting video…' });
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (!disposed && streamRef.current === stream && connectionRef.current?.open) {
            send({ type: 'notice', message: 'Screen sharing stopped on the computer.' });
            setNotice('Screen sharing stopped');
          }
        });
        const call = peer.call(remoteId, stream, { metadata: { protocol: PROTOCOL_VERSION } });
        callRef.current = call;
        call.on('close', stopStream);
        call.on('error', stopStream);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        setNotice(`Could not start screen sharing: ${detail}`);
        send({ type: 'notice', message: `Screen capture failed: ${detail}` });
      } finally {
        capturePendingRef.current = false;
      }
    };

    peer.on('open', () => {
      setHostState('ready');
      setNotice('Waiting for your phone');
    });

    peer.on('connection', (incoming) => {
      const metadata = incoming.metadata as { role?: string; protocol?: number; deviceName?: string } | undefined;
      if (metadata?.role !== 'controller' || metadata.protocol !== PROTOCOL_VERSION || pendingConnections.size >= 3) {
        incoming.close();
        return;
      }
      pendingConnections.add(incoming);
      let authenticated = false;
      let authenticating = false;
      let challenge = '';
      let messageWindowStarted = Date.now();
      let messagesInWindow = 0;
      const authDeadline = window.setTimeout(() => incoming.close(), 8_000);

      incoming.on('open', () => {
        challenge = createSecurityToken();
        setNotice('Phone found — verifying pairing secret…');
        void incoming.send({ type: 'auth-challenge', challenge } satisfies HostMessage);
      });
      incoming.on('data', (data) => {
        if (!isControllerMessage(data)) {
          incoming.close();
          return;
        }
        if (!authenticated) {
          if (authenticating || data.type !== 'auth-response' || data.challenge !== challenge) {
            incoming.close();
            return;
          }
          authenticating = true;
          void authProofForCode(pairingCode, challenge, data.nonce).then((expectedProof) => {
            if (disposed || data.proof !== expectedProof) {
              incoming.close();
              return;
            }
            authenticated = true;
            window.clearTimeout(authDeadline);
            pendingConnections.delete(incoming);
            const previous = connectionRef.current;
            connectionRef.current = incoming;
            previous?.close();
            stopStream();
            const safeName = typeof metadata.deviceName === 'string'
              ? metadata.deviceName.replace(/[^\p{L}\p{N} ._'()-]/gu, '').slice(0, 48) || 'Phone'
              : 'Phone';
            setControllerName(safeName);
            setHostState('connected');
            setNotice('Phone authenticated — starting screen…');
            shareScreenRef.current = () => shareScreenWith(incoming.peer);
            void incoming.send({ type: 'auth-ok' } satisfies HostMessage);
            void incoming.send({
              type: 'ready',
              computerName,
              jigglerEnabled: jigglerRef.current,
              screenBlanked: screenBlankedRef.current,
              dictationAvailable: groqKeyConfiguredRef.current,
            } satisfies HostMessage);
            void shareScreenWith(incoming.peer);
          }).catch(() => incoming.close());
          return;
        }
        if (connectionRef.current !== incoming) {
          incoming.close();
          return;
        }
        const now = Date.now();
        if (now - messageWindowStarted >= 1_000) {
          messageWindowStarted = now;
          messagesInWindow = 0;
        }
        messagesInWindow += 1;
        if (messagesInWindow > 400) {
          setNotice('Disconnected a controller that exceeded the safety rate limit.');
          incoming.close();
          return;
        }
        if (data.type !== 'auth-response') void handleControllerMessage(data);
      });
      incoming.on('close', () => {
        window.clearTimeout(authDeadline);
        pendingConnections.delete(incoming);
        returnToReady(incoming);
      });
      incoming.on('error', () => {
        window.clearTimeout(authDeadline);
        pendingConnections.delete(incoming);
        returnToReady(incoming);
      });
    });

    peer.on('disconnected', () => {
      if (disposed) return;
      setHostState('reconnecting');
      setNotice('Rendezvous interrupted — reconnecting…');
      window.setTimeout(() => { if (!disposed && peer.disconnected && !peer.destroyed) peer.reconnect(); }, 1200);
    });
    peer.on('error', (error) => {
      if (disposed) return;
      if (error.type === 'unavailable-id') {
        const replacement = createPairingCode();
        setPairingCode(replacement);
        void api.saveSettings({ pairingCode: replacement });
        return;
      }
      setHostState('error');
      setNotice('Could not reach the P2P rendezvous. Retrying…');
      window.setTimeout(() => {
        if (!disposed && peer.disconnected && !peer.destroyed) peer.reconnect();
      }, 3000);
    });

    return () => {
      disposed = true;
      shareScreenRef.current = null;
      capturePendingRef.current = false;
      stopStream();
      connectionRef.current?.close();
      connectionRef.current = null;
      if (!peer.destroyed) peer.destroy();
      peerRef.current = null;
    };
  }, [api, computerName, handleControllerMessage, hostPeerId, pairingCode, send, stopStream]);

  const pairingUrl = useMemo(() => {
    const base = normalizeControllerUrl(controllerUrl);
    return base && pairingCode ? `${base}#${pairingCode}` : '';
  }, [controllerUrl, pairingCode]);

  const rotateCode = () => {
    if (!api) return;
    const code = createPairingCode();
    setPairingCode(code);
    void api.saveSettings({ pairingCode: code });
  };

  const saveControllerUrl = () => {
    if (!api) return;
    const next = normalizeControllerUrl(urlDraft);
    if (!next) {
      setNotice('Use the HTTPS address of your published GitHub Pages controller.');
      return;
    }
    setControllerUrl(next);
    setUrlDraft(next);
    void api.saveSettings({ controllerUrl: next });
    setNotice('Controller address saved');
  };

  const saveGroqKey = async () => {
    if (!api || !groqKeyDraft.trim()) return;
    try {
      const configured = await api.setGroqApiKey(groqKeyDraft);
      setGroqKeyConfigured(configured);
      setGroqKeyDraft('');
      setNotice('Groq key encrypted for this Windows account');
      send({ type: 'status', jigglerEnabled: jigglerRef.current, screenBlanked: screenBlankedRef.current, dictationAvailable: configured });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the Groq key');
    }
  };

  const removeGroqKey = async () => {
    if (!api) return;
    await api.setGroqApiKey('');
    setGroqKeyConfigured(false);
    setGroqKeyDraft('');
    setNotice('Saved Groq key removed');
    send({ type: 'status', jigglerEnabled: jigglerRef.current, screenBlanked: screenBlankedRef.current, dictationAvailable: false });
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(pairingCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <main className="host-shell">
      <header className="host-header">
        <div className="flex items-center gap-3">
          <span className="brand-mark"><MousePointer2 className="size-[18px]" /></span>
          <div><strong>CompCtrl companion</strong><p>{computerName}</p></div>
        </div>
        <span className={`host-status host-status-${hostState}`}><span />{hostState === 'connected' ? 'Connected' : hostState === 'ready' ? 'Ready' : hostState === 'starting' ? 'Starting' : 'Reconnecting'}</span>
      </header>

      <section className="host-content">
        <div className="host-primary-card">
          <div className="host-card-copy">
            <span className="host-kicker"><Smartphone /> Connect your phone</span>
            <h1>{hostState === 'connected' ? `${controllerName} is connected` : 'Scan or enter this code'}</h1>
            <p>{hostState === 'connected' ? 'Your screen and controls are traveling directly between this PC and your phone.' : 'Open the controller on your phone. This code stays valid while the companion is running.'}</p>
            <div className="pair-code-display" aria-label={`Pairing code ${pairingCode}`}>
              <button type="button" onClick={copyCode}>{pairingCode.slice(0, 4)} <span>{pairingCode.slice(4, 8)}</span> {pairingCode.slice(8)}{copied ? <Check /> : <Copy />}</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {hostState === 'connected' ? (
                <Button variant="outline" onClick={() => connectionRef.current?.close()}><Unplug /> Disconnect phone</Button>
              ) : (
                <Button variant="outline" onClick={rotateCode}><RefreshCw /> New code</Button>
              )}
              {pairingUrl && <Button variant="ghost" onClick={() => window.open(pairingUrl, '_blank')}><ExternalLink /> Open controller link</Button>}
            </div>
          </div>
          <div className="qr-panel">
            {pairingUrl ? (
              <>
                <strong className="qr-title">Scan to connect</strong>
                <QRCodeSVG
                  value={pairingUrl}
                  title={`CompCtrl pairing code ${pairingCode}`}
                  size={188}
                  bgColor="#ffffff"
                  fgColor="#141923"
                  level="M"
                  marginSize={2}
                />
              </>
            ) : (
              <div className="qr-placeholder"><Link2 /><span>Add your GitHub Pages address below to enable QR pairing.</span></div>
            )}
            <small>{pairingUrl ? 'On your phone, tap Scan QR code and point the camera here' : 'Manual code pairing still works'}</small>
          </div>
        </div>

        <div className="host-grid">
          <section className="host-settings-card">
            <div className="section-heading"><div><h2>Always available</h2><p>Closing this window minimizes the companion to the tray.</p></div><ShieldCheck /></div>
            <div className="host-setting-row">
              <span className="host-setting-icon"><MonitorUp /></span>
              <span><strong>Start with Windows</strong><small>Restore remote access after sign-in or a restart</small></span>
              <Switch
                checked={autoStart}
                onCheckedChange={(enabled) => {
                  setAutoStart(enabled);
                  void api?.saveSettings({ autoStart: enabled });
                }}
              />
            </div>
            <div className="host-setting-row">
              <span className="host-setting-icon"><Wifi /></span>
              <span><strong>Screen jiggler</strong><small>Move the pointer slightly every 30 seconds</small></span>
              <Switch
                checked={jigglerEnabled}
                onCheckedChange={(enabled) => {
                  setJigglerEnabled(enabled);
                  void api?.setJiggler(enabled);
                  send({ type: 'status', jigglerEnabled: enabled, screenBlanked: screenBlankedRef.current, dictationAvailable: groqKeyConfiguredRef.current });
                }}
              />
            </div>
            <div className="host-setting-row">
              <span className="host-setting-icon"><EyeOff /></span>
              <span><strong>Power displays off</strong><small>Hardware power-off · Recovery: Ctrl+Alt+Shift+F12</small></span>
              <Switch
                checked={screenBlanked}
                onCheckedChange={(blanked) => {
                  setScreenBlanked(blanked);
                  void api?.setDisplayBlanked(blanked);
                  send({ type: 'status', jigglerEnabled: jigglerRef.current, screenBlanked: blanked, dictationAvailable: groqKeyConfiguredRef.current });
                }}
              />
            </div>
          </section>

          <section className="host-settings-card">
            <div className="section-heading"><div><h2>Controller address</h2><p>Used only to create the QR code.</p></div><Link2 /></div>
            <div className="url-setting">
              <Input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} placeholder="https://name.github.io/compctrl/" />
              <Button onClick={saveControllerUrl}>Save</Button>
            </div>
            <p className="host-note"><CircleHelp /> Paste the address shown by GitHub Pages after publishing this project.</p>
          </section>

          <section className="host-settings-card host-wide-card">
            <div className="section-heading"><div><h2>Groq voice dictation</h2><p>The key is encrypted locally and used only by this companion for Whisper transcription.</p></div><KeyRound /></div>
            <div className="secret-setting">
              <Input
                type="password"
                value={groqKeyDraft}
                onChange={(event) => setGroqKeyDraft(event.target.value)}
                placeholder={groqKeyConfigured ? 'Groq key saved — enter a replacement' : 'Paste Groq API key'}
                autoComplete="off"
                spellCheck={false}
              />
              <Button onClick={() => void saveGroqKey()} disabled={!groqKeyDraft.trim()}>Save key</Button>
              {groqKeyConfigured && <Button variant="outline" size="icon" onClick={() => void removeGroqKey()} aria-label="Remove saved Groq API key"><Trash2 /></Button>}
            </div>
            <p className="host-note"><ShieldCheck /> {groqKeyConfigured ? 'Dictation is ready. Focus a Windows text field, then tap Voice on your phone.' : 'The phone never receives or stores this key.'}</p>
          </section>
        </div>

        <div className="host-activity">
          <span className="activity-icon">{hostState === 'connected' ? <Laptop /> : hostState === 'error' ? <WifiOff /> : <Wifi />}</span>
          <span><strong>{notice}</strong><small>{hostState === 'connected' ? 'Touch, keyboard, clipboard shortcuts, and power controls are active.' : 'The companion will keep retrying automatically if the network changes.'}</small></span>
        </div>
      </section>
    </main>
  );
}
