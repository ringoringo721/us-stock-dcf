(function () {
  'use strict';
  const key = 'RADAR_THEME';
  let stored = null;
  try {
    stored = localStorage.getItem(key);
  } catch (error) {
    console.warn('Theme preference could not be read; using dark mode', error);
  }
  document.documentElement.dataset.theme = stored === 'light' ? 'light' : 'dark';
  window.SiteTheme = {
    get current() { return document.documentElement.dataset.theme; },
    color(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); },
    set(theme) {
      if (!['dark', 'light'].includes(theme)) throw new RangeError('Invalid theme');
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem(key, theme);
      } catch (error) {
        console.warn('Theme preference could not be saved', error);
      }
      window.dispatchEvent(new CustomEvent('themechange'));
    },
    toggle() { this.set(this.current === 'dark' ? 'light' : 'dark'); }
  };
})();
