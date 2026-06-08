import { createRoot } from 'react-dom/client';
import LegacyShell from './LegacyShell.jsx';
import desktopShell from './templates/desktop-shell.html?raw';

createRoot(document.getElementById('react-root')).render(
  <LegacyShell html={desktopShell} scriptSrc="/app.js?v=20260603" />
);
