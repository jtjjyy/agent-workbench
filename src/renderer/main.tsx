import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing renderer root');
createRoot(root).render(<App />);
