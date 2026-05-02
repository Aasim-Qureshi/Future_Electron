const SUPER_ADMIN_PHONE = "000";

/** @deprecated Single-mode app: no extra view restrictions */
const ADMIN_ONLY_VIEW_IDS = new Set();

const UPLOAD_SINGLE_REPORT_VIEW_IDS = [];

const isSuperAdminUser = (user) =>
  String(user?.phone || "").trim() === SUPER_ADMIN_PHONE;

const canAccessView = () => true;

const canAccessGroup = () => true;

const filterTabsByAccess = (tabs = []) => (Array.isArray(tabs) ? tabs : []);

const getFirstAccessibleTabId = (tabs = []) =>
  (Array.isArray(tabs) ? tabs : [])[0]?.id || null;

export {
  SUPER_ADMIN_PHONE,
  ADMIN_ONLY_VIEW_IDS,
  UPLOAD_SINGLE_REPORT_VIEW_IDS,
  isSuperAdminUser,
  canAccessView,
  canAccessGroup,
  filterTabsByAccess,
  getFirstAccessibleTabId,
};
