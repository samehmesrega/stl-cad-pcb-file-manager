import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import { App } from './App.tsx';
import { applyLanguage } from './i18n.ts';
import './styles.css';
import { applyTheme, currentTheme } from './theme.ts';

applyLanguage();
applyTheme(currentTheme());

createRoot(document.getElementById('root')!).render(<App />);
