import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PlatformProvider } from './platform/context';
import { AppStateProvider } from './state/store';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Root element missing');

createRoot(root).render(
  <StrictMode>
    <PlatformProvider>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </PlatformProvider>
  </StrictMode>,
);
