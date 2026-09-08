import Peer, { type PeerOptions } from 'peerjs';

const iceServers: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function peerOptions(): PeerOptions {
  return {
    debug: 1,
    config: { iceServers, iceCandidatePoolSize: 4 },
  };
}

export function newPeer(id?: string) {
  return id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
}
