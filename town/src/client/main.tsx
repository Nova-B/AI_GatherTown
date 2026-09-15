import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { connect } from './connection.js';
import { installAudioUnlock, loadSoundEnabled, playChime } from './sound.js';
import { store } from './store.js';
import './styles.css';

// Completion chime: live turn endings only (the store never reports DEMO or replay).
store.setSoundEnabled(loadSoundEnabled());
installAudioUnlock();
store.onTurnEnd(({ status }) => {
  if (!store.state.soundEnabled) return;
  playChime(status === 'completed' ? 'completed' : 'failed');
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
void connect();
