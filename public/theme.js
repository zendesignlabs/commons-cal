try {
  const preference = localStorage.getItem('commons-theme') || 'system';
  document.documentElement.dataset.theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
} catch {}
