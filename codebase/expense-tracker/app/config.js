// Committed file. Picks the backend /exec URL based on where the page is loaded.
// Local file:// or localhost → dev. Hosted (GitHub Pages) → prod.
// Fill in PROD_SCRIPT_URL when you set up the prod GAS deployment.
window.CONFIG = (() => {
  const isHosted = location.hostname.endsWith('.github.io');
  const DEV_SCRIPT_URL  = 'https://script.google.com/macros/s/AKfycbxWTOuXeCkH4tsDvrmCjkjxlhIZqLyIhxfvXR51ymWRc1FGAOYkLt0rkeGjTfQmWAv2RA/exec';
  const PROD_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz21kZuwPCTVWKmLcUmogk2ZECYAL4Jibc8Dfs8dZmdUc-HSzqVLvqJPcpc6AhzUOWJUg/exec';
  return {
    SCRIPT_URL: isHosted ? PROD_SCRIPT_URL : DEV_SCRIPT_URL,
  };
})();
