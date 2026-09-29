// 浏览器入口：挂载 React 页面，并加载全局样式。
import React from 'react';
import { createRoot } from 'react-dom/client';
import Home from './page';
import './style.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
