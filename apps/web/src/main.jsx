import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App.jsx';
// the Kept components first, so Tailwind's utilities (responsive ones included) can override them
import '@/kept.css';
import '@/index.css';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
