import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { connect } from './connection.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
void connect();
