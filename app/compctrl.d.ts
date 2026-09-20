export {};

declare global {
  interface Document {
    readonly modelContext?: {
      registerTool(
        tool: {
          name: string;
          title?: string;
          description: string;
          inputSchema: object;
          annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
          execute(input: unknown): unknown;
        },
        options?: { signal?: AbortSignal },
      ): void | Promise<void>;
    };
  }

  interface Window {
    compCtrl?: {
      getSettings(): Promise<{
        computerName: string;
        pairingCode: string;
        controllerUrl: string;
        jigglerEnabled: boolean;
        screenBlanked: boolean;
        autoStart: boolean;
        groqKeyConfigured: boolean;
        transcriptionProvider: 'groq' | 'local';
        transcriptionReady: boolean;
        localWhisper: { installed: boolean; modelName: string; modelSizeMb: number; build: string };
        trustedPeerId: string;
        trustedDevices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number }>;
        security: import('@/lib/protocol').SecuritySettings;
        version: string;
      }>;
      saveSettings(settings: {
        pairingCode?: string;
        controllerUrl?: string;
        autoStart?: boolean;
        transcriptionProvider?: 'groq' | 'local';
        security?: import('@/lib/protocol').SecuritySettings;
      }): Promise<void>;
      setGroqApiKey(key: string): Promise<boolean>;
      installLocalWhisper(): Promise<{ installed: boolean; modelName: string; modelSizeMb: number; build: string }>;
      removeLocalWhisper(): Promise<{ installed: boolean; modelName: string; modelSizeMb: number; build: string }>;
      transcribeAudio(chunks: string[], mimeType: string): Promise<string>;
      issueTrustedDevice(deviceId: string, deviceName: string): Promise<{
        deviceId: string;
        hostId: string;
        token: string;
        expiresAt: number;
        devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number }>;
      }>;
      verifyTrustedDevice(deviceId: string, challenge: string, nonce: string, proof: string): Promise<
        { ok: false; devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number }> }
        | { ok: true; deviceId: string; hostId: string; token: string; expiresAt: number; devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number }> }
      >;
      revokeTrustedDevice(deviceId: string): Promise<Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number }>>;
      panicLockdown(): Promise<void>;
      readClipboard(): Promise<string>;
      writeClipboard(text: string): Promise<void>;
      dispatch(message: import('@/lib/protocol').ControllerMessage): Promise<void>;
      setJiggler(enabled: boolean): Promise<void>;
      setDisplayBlanked(enabled: boolean): Promise<boolean>;
      authorizeDisplayCapture(audioRequested: boolean): Promise<void>;
      systemAction(action: 'restart' | 'shutdown'): Promise<void>;
      onDisplayState(callback: (enabled: boolean) => void): () => void;
      onLockdown(callback: (state: {
        pairingCode: string;
        trustedPeerId: string;
        security: import('@/lib/protocol').SecuritySettings;
      }) => void): () => void;
      onBeforeQuit(callback: () => void): () => void;
    };
  }
}
