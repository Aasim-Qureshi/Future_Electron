/**
 * Taqeem secondary-browser (report approval) login hints.
 * Override via env in deployment; defaults match the dedicated confirmer account.
 */
module.exports = {
  TAQEEM_SECONDARY_LOGIN_ID:
    process.env.TAQEEM_SECONDARY_LOGIN_ID ,
  TAQEEM_SECONDARY_PASSWORD:
    process.env.TAQEEM_SECONDARY_PASSWORD ,
};
