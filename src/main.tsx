import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppStateProvider } from './state/store';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Root element missing');

createRoot(root).render(
  <StrictMode>
    <AppStateProvider>
      <App />
    </AppStateProvider>
  </StrictMode>,
);
