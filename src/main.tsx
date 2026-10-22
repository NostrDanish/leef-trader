import { createRoot } from 'react-dom/client';

// Import polyfills first
import './lib/polyfills.ts';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import App from './App.tsx';
import './index.css';
// Latin woff2 only. The full @fontsource CSS also emits woff fallbacks and
// Vietnamese / Cyrillic / Greek subsets this English terminal never paints.
import './styles/fonts.css';

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
