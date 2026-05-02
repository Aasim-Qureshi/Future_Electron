/**
 * Persistent Electron session partition for Taqeem (in-app BrowserWindows).
 * Must match authHandlers secondary login window so cookies are shared.
 */
module.exports = {
  TAQEEM_ELECTRON_PARTITION: "persist:taqeem-secondary",
};
