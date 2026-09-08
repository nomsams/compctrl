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
        autoStart: boolean;
        version: string;
      }>;
      saveSettings(settings: {
        pairingCode?: string;
        controllerUrl?: string;
        autoStart?: boolean;
      }): Promise<void>;
      dispatch(message: import('@/lib/protocol').ControllerMessage): Promise<void>;
      setJiggler(enabled: boolean): Promise<void>;
      systemAction(action: 'restart' | 'shutdown'): Promise<void>;
      onBeforeQuit(callback: () => void): () => void;
    };
  }
}
