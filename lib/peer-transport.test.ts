import assert from 'node:assert/strict';
import test from 'node:test';

import { queuePeerMessage, sendPeerMessage, type SendableConnection } from './peer-transport.ts';

function mockConnection(send: SendableConnection<string>['send']) {
  let closeCount = 0;
  const connection: SendableConnection<string> & { closeCount(): number } = {
    open: true,
    send,
    close() { closeCount += 1; connection.open = false; },
    closeCount: () => closeCount,
  };
  return connection;
}

void test('queues messages without blocking interactive controls', async () => {
  let resolveSend: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => { resolveSend = resolve; });
  const connection = mockConnection(() => sent);

  assert.equal(queuePeerMessage(connection, 'move'), true);
  assert.equal(connection.open, true);
  resolveSend();
  await sent;
  assert.equal(connection.closeCount(), 0);
});

void test('closes a channel whose asynchronous send fails', async () => {
  const connection = mockConnection(() => Promise.reject(new Error('buffer failed')));
  assert.equal(queuePeerMessage(connection, 'move'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(connection.open, false);
  assert.equal(connection.closeCount(), 1);
});

void test('reports failed ordered bulk sends and closes the channel', async () => {
  const connection = mockConnection(() => Promise.reject(new Error('channel closed')));
  assert.equal(await sendPeerMessage(connection, 'audio'), false);
  assert.equal(connection.closeCount(), 1);
});

void test('does not send on a closed channel', async () => {
  let sends = 0;
  const connection = mockConnection(() => { sends += 1; });
  connection.open = false;
  assert.equal(queuePeerMessage(connection, 'ping'), false);
  assert.equal(await sendPeerMessage(connection, 'audio'), false);
  assert.equal(sends, 0);
});
