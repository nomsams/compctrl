'use client';

import { useEffect, useState } from 'react';

import { HostController } from './host';
import { RemoteController } from './remote';

export default function Home() {
  const [role, setRole] = useState<'loading' | 'host' | 'remote'>('loading');

  useEffect(() => {
    setRole(window.compCtrl ? 'host' : 'remote');
  }, []);

  if (role === 'loading') {
    return <main className="min-h-dvh bg-[#10141e]" aria-label="Loading CompCtrl" />;
  }

  return role === 'host' ? <HostController /> : <RemoteController />;
}
