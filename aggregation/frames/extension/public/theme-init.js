// Apply the saved theme before rendering, using an extension-local CSP-safe script.
try {
  const theme = localStorage.getItem('nt_theme');
  document.documentElement.dataset.theme = theme === 'slate' || theme === 'stone' ? theme : 'stone';
} catch {
  document.documentElement.dataset.theme = 'stone';
}
