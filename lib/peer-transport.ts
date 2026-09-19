export type SendableConnection<Message> = {
  open: boolean;
  send(message: Message): void | Promise<void>;
  close(): void;
};

function closeAfterSendFailure<Message>(connection: SendableConnection<Message>) {
  try { connection.close(); } catch { /* The transport may already be closed. */ }
}

export function queuePeerMessage<Message>(connection: SendableConnection<Message> | null | undefined, message: Message) {
  if (!connection?.open) return false;
  try {
    const pending = connection.send(message);
    if (pending && typeof pending.then === 'function') {
      void pending.catch(() => closeAfterSendFailure(connection));
    }
    return true;
  } catch {
    closeAfterSendFailure(connection);
    return false;
  }
}

export async function sendPeerMessage<Message>(connection: SendableConnection<Message> | null | undefined, message: Message) {
  if (!connection?.open) return false;
  try {
    await connection.send(message);
    return connection.open;
  } catch {
    closeAfterSendFailure(connection);
    return false;
  }
}
