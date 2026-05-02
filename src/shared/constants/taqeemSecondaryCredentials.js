/**
 * Taqeem secondary-browser (report approval) login hints.
 * Values come from process.env (e.g. project .env loaded in main.js before IPC).
 * Read via getTaqeemSecondaryCredentials() so values stay current after dotenv.config.
 */

function trimEnv(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function getTaqeemSecondaryCredentials() {
  return {
    loginId: trimEnv(process.env.TAQEEM_SECONDARY_LOGIN_ID),
    password: trimEnv(process.env.TAQEEM_SECONDARY_PASSWORD),
  };
}

module.exports = {
  getTaqeemSecondaryCredentials,
};
