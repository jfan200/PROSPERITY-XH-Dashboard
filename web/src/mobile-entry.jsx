import { createRoot } from 'react-dom/client';
import LegacyShell from './LegacyShell.jsx';
import mobileShell from './templates/mobile-shell.html?raw';

createRoot(document.getElementById('react-root')).render(
  <LegacyShell html={mobileShell} scriptSrc="/mobile.js" />
);
