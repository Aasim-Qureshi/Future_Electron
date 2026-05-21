const { contextBridge, ipcRenderer, webUtils } = require("electron");

function safeInvoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    if (err && typeof err.message === "string") {
      // Strip Electron IPC prefix
      err.message = err.message.replace(
        new RegExp(`^Error invoking remote method '${channel}':\\s*`),
        "",
      );

      // Strip redundant "Error: " if present
      err.message = err.message.replace(/^Error:\s*/, "");
    }

    throw err;
  });
}

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  versions: process.versions,

  getDummyPdfPath: () => safeInvoke("get-dummy-pdf-path"),

  // Auth
  login: (credentials) => safeInvoke("login", credentials),
  publicLogin: (isAuth) => safeInvoke("public-login", isAuth),
  submitOtp: (otp) => safeInvoke("submit-otp", otp),
  checkStatus: () => safeInvoke("check-status"),
  getCompanies: () => safeInvoke("get-companies"),
  navigateToCompany: (company) => safeInvoke("navigate-to-company", company),
  register: (userData) => safeInvoke("register", userData),
  openTaqeemLogin: (opts = {}) => safeInvoke("open-taqeem-login", opts),
  // Complete flow pause/resume/stop controls
  pauseCompleteFlow: (reportId) => safeInvoke("pause-complete-flow", reportId),
  resumeCompleteFlow: (reportId) =>
    safeInvoke("resume-complete-flow", reportId),
  stopCompleteFlow: (reportId) => safeInvoke("stop-complete-flow", reportId),

  // Auth
  login: (credentials) => safeInvoke("login", credentials),
  publicLogin: (isAuth) => safeInvoke("public-login", isAuth),
  submitOtp: (otp) => safeInvoke("submit-otp", otp),
  checkStatus: () => safeInvoke("check-status"),
  getCompanies: () => safeInvoke("get-companies"),
  getTaqeemProfile: () => safeInvoke("get-profile"),
  navigateToCompany: (company) => safeInvoke("navigate-to-company", company),
  register: (userData) => safeInvoke("register", userData),
  openTaqeemLogin: (opts = {}) => safeInvoke("open-taqeem-login", opts),
  // Complete flow pause/resume/stop controls
  pauseCompleteFlow: (reportId) => safeInvoke("pause-complete-flow", reportId),
  resumeCompleteFlow: (reportId) =>
    safeInvoke("resume-complete-flow", reportId),
  stopCompleteFlow: (reportId) => safeInvoke("stop-complete-flow", reportId),
  // Set refresh token (stored as HttpOnly session cookie by default)
  setRefreshToken: (token, opts = {}) => {
    const payload = Object.assign(
      {
        baseUrl: opts.baseUrl || "http://localhost:3001",
        token,
        name: opts.name || "refreshToken",
        path: opts.path || "/",
        maxAgeDays:
          typeof opts.maxAgeDays === "number" ? opts.maxAgeDays : 1,
        sessionOnly: opts.sessionOnly === true,
        sameSite: opts.sameSite || "lax",
        secure:
          typeof opts.secure === "boolean"
            ? opts.secure
            : process.env.NODE_ENV === "production",
        httpOnly: typeof opts.httpOnly === "boolean" ? opts.httpOnly : true,
      },
      opts,
    );
    return safeInvoke("auth-set-refresh-token", payload);
  },

  clearRefreshToken: (opts = {}) => {
    const payload = {
      baseUrl: opts.baseUrl || "http://localhost:3001",
      name: opts.name || "refreshToken",
    };
    return safeInvoke("auth-clear-refresh-token", payload);
  },

  // Reports
  validateReport: (reportId, userId = null, companyOfficeId = null) =>
    safeInvoke("validate-report", reportId, userId, companyOfficeId),
  createMacros: (reportId, macroCount, tabsNum, batchSize) =>
    safeInvoke("create-macros", reportId, macroCount, tabsNum, batchSize),
  extractAssetData: (excelFilePath) =>
    safeInvoke("extract-asset-data", excelFilePath),
  completeFlow: (reportId, tabsNum) =>
    safeInvoke("complete-flow", reportId, tabsNum),

  grabMacroIds: (reportId, tabsNum) =>
    safeInvoke("grab-macro-ids", reportId, tabsNum),
  pauseGrabMacroIds: (reportId) => safeInvoke("pause-grab-macro-ids", reportId),
  resumeGrabMacroIds: (reportId) =>
    safeInvoke("resume-grab-macro-ids", reportId),
  stopGrabMacroIds: (reportId) => safeInvoke("stop-grab-macro-ids", reportId),

  retryMacroIds: (reportId, tabsNum) =>
    safeInvoke("retry-macro-ids", reportId, tabsNum),
  pauseRetryMacroIds: (reportId) =>
    safeInvoke("pause-retry-macro-ids", reportId),
  resumeRetryMacroIds: (reportId) =>
    safeInvoke("resume-retry-macro-ids", reportId),
  stopRetryMacroIds: (reportId) => safeInvoke("stop-retry-macro-ids", reportId),

  macroFill: (reportId, tabsNum) => safeInvoke("macro-fill", reportId, tabsNum),
  macroFillRetry: (reportId, tabsNum, recordId = null, assetData = null) =>
    safeInvoke("run-macro-edit-retry", reportId, tabsNum, recordId, assetData),

  elrajhiUploadReport: (batchId, tabsNum, pdfOnly, finalizeSubmission = true, company = null) =>
    safeInvoke("elrajhi-filler", batchId, tabsNum, pdfOnly, finalizeSubmission, company),

  pauseElrajiBatch: (batchId) => safeInvoke("pause-elrajhi-batch", batchId),
  resumeElrajiBatch: (batchId) => safeInvoke("resume-elrajhi-batch", batchId),
  stopElrajiBatch: (batchId) => safeInvoke("stop-elrajhi-batch", batchId),

  onCreateReportsByBatchProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("create-reports-by-batch-progress", subscription);
    return () => {
      ipcRenderer.removeListener(
        "create-reports-by-batch-progress",
        subscription,
      );
    };
  },

  checkElrajhiBatches: (batchId, tabsNum) =>
    safeInvoke("elrajhi-check-batches", batchId, tabsNum),
  downloadRegistrationCertificates: (payload) =>
    safeInvoke("download-registration-certificates", payload),
  reuploadElrajhiReport: (reportId) =>
    safeInvoke("elrajhi-reupload-report", reportId),
  duplicateReportNavigate: (recordId, company, tabsNum) =>
    safeInvoke("duplicate-report", recordId, company, tabsNum),
  createReportsByBatch: (batchId, tabsNum) =>
    safeInvoke("create-reports-by-batch", batchId, tabsNum),
  createReportById: (recordId, tabsNum) =>
    safeInvoke("create-report-by-id", recordId, tabsNum),
  retryCreateReportById: (recordId, tabsNum) =>
    safeInvoke("retry-create-report-by-id", recordId, tabsNum),
  retryElrajhiReport: (batchId, tabsNum) =>
    safeInvoke("retry-ElRajhi-report", batchId, tabsNum),
  retryElrajhiReportReportIds: (reportIds, tabsNum) =>
    safeInvoke("retry-ElRajhi-report-by-report-ids", reportIds, tabsNum),
  retryElrajhiReportRecordIds: (recordIds, tabsNum) =>
    safeInvoke("retry-ElRajhi-report-by-record-ids", recordIds, tabsNum),
  finalizeMultipleReports: (reportIds) =>
    safeInvoke("finalize-multiple-reports", reportIds),

  // Pause/Resume/Stop controls for macro-fill
  pauseMacroFill: (reportId) => safeInvoke("pause-macro-fill", reportId),
  resumeMacroFill: (reportId) => safeInvoke("resume-macro-fill", reportId),
  stopMacroFill: (reportId) => safeInvoke("stop-macro-fill", reportId),

  // NEW: Pause/Resume/Stop controls for create-macros
  pauseCreateMacros: (reportId) => safeInvoke("pause-create-macros", reportId),
  resumeCreateMacros: (reportId) =>
    safeInvoke("resume-create-macros", reportId),
  stopCreateMacros: (reportId) => safeInvoke("stop-create-macros", reportId),

  fullCheck: (reportId, tabsNum) => safeInvoke("full-check", reportId, tabsNum),
  pauseFullCheck: (reportId) => safeInvoke("pause-full-check", reportId),
  resumeFullCheck: (reportId) => safeInvoke("resume-full-check", reportId),
  stopFullCheck: (reportId) => safeInvoke("stop-full-check", reportId),

  halfCheck: (reportId, tabsNum) => safeInvoke("half-check", reportId, tabsNum),
  pauseHalfCheck: (reportId) => safeInvoke("pause-half-check", reportId),
  resumeHalfCheck: (reportId) => safeInvoke("resume-half-check", reportId),
  stopHalfCheck: (reportId) => safeInvoke("stop-half-check", reportId),

  deleteReport: (reportId, maxRounds, userId, companyOfficeId = null) =>
    safeInvoke("delete-report", reportId, maxRounds, userId, companyOfficeId),
  deleteMultipleReports: (reportIds, maxRounds) =>
    safeInvoke("delete-multiple-reports", reportIds, maxRounds),
  pauseDeleteReport: (reportId) => safeInvoke("pause-delete-report", reportId),
  resumeDeleteReport: (reportId) =>
    safeInvoke("resume-delete-report", reportId),
  stopDeleteReport: (reportId) => safeInvoke("stop-delete-report", reportId),

  deleteIncompleteAssets: (
    reportId,
    maxRounds,
    userId,
    companyOfficeId = null,
  ) =>
    safeInvoke(
      "delete-incomplete-assets",
      reportId,
      maxRounds,
      userId,
      companyOfficeId,
    ),
  pauseDeleteIncompleteAssets: (reportId) =>
    safeInvoke("pause-delete-incomplete-assets", reportId),
  resumeDeleteIncompleteAssets: (reportId) =>
    safeInvoke("resume-delete-incomplete-assets", reportId),
  stopDeleteIncompleteAssets: (reportId) =>
    safeInvoke("stop-delete-incomplete-assets", reportId),

  getReportDeletions: (
    userId,
    deleteType,
    page = 1,
    limit = 10,
    searchTerm = "",
    companyOfficeId = null,
  ) =>
    safeInvoke(
      "get-report-deletions",
      userId,
      deleteType,
      page,
      limit,
      searchTerm,
      companyOfficeId,
    ),

  storeReportDeletion: (deletionData) =>
    safeInvoke("store-report-deletion", deletionData),

  getValidationResults: (userId, reportIds) =>
    safeInvoke("get-validation-results", userId, reportIds),

  getCheckedReports: (
    userId,
    page = 1,
    limit = 10,
    searchTerm = "",
    companyOfficeId = null,
  ) =>
    safeInvoke(
      "get-checked-reports",
      userId,
      page,
      limit,
      searchTerm,
      companyOfficeId,
    ),

  handleCancelledReport: (reportId) =>
    safeInvoke("handle-cancelled-report", reportId),

  getToken: () => safeInvoke("get-token"),

  // Progress listener for macro fill
  onMacroFillProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("macro-fill-progress", subscription);
    return () => {
      ipcRenderer.removeListener("macro-fill-progress", subscription);
    };
  },

  // NEW: Progress listener for create-macros
  onCreateMacrosProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("create-macros-progress", subscription);
    return () => {
      ipcRenderer.removeListener("create-macros-progress", subscription);
    };
  },
  // Progress listener for delete-report
  onDeleteReportProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("delete-report-progress", subscription);
    return () => {
      ipcRenderer.removeListener("delete-report-progress", subscription);
    };
  },

  // Progress listener for delete-assets
  onDeleteAssetsProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("delete-assets-progress", subscription);
    return () => {
      ipcRenderer.removeListener("delete-assets-progress", subscription);
    };
  },

  onAuthExpired: (callback) => {
    if (typeof callback !== "function") return () => {};
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("auth-expired", subscription);
    return () => {
      ipcRenderer.removeListener("auth-expired", subscription);
    };
  },

  getFileAbsolutePath: (file) => {
    try {
      const path = webUtils.getPathForFile(file);
      return path;
    } catch (error) {
      console.error("Failed to get file path:", error);
      return null;
    }
  },

  // Progress listener for submit-reports-quickly
  onSubmitReportsQuicklyProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("submit-reports-quickly-progress", subscription);
    return () => {
      ipcRenderer.removeListener(
        "submit-reports-quickly-progress",
        subscription,
      );
    };
  },

  // Worker
  showOpenDialog: () => safeInvoke("show-open-dialog"),
  showOpenDialogWord: () => safeInvoke("show-open-dialog-word"),
  showOpenDialogPdfs: () => safeInvoke("show-open-dialog-pdfs"),
  showOpenDialogImages: () => safeInvoke("show-open-dialog-images"),
  selectFolder: () => safeInvoke("select-folder"),
  readFolder: (folderPath) => safeInvoke("read-folder", folderPath),
  readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),
  readTemplateFile: (fileName) =>
    ipcRenderer.invoke("read-template-file", fileName),

  // Health
  checkHealth: () => safeInvoke("check-server-health"),

  // API requests
  apiRequest: (method, url, data = {}, headers = {}) =>
    safeInvoke("api-request", { method, url, data, headers }),

  readRam: () => safeInvoke("read-ram"),

  // Valuation system
  createValuationFolders: (payload) =>
    safeInvoke("valuation-create-folders", payload),
  updateValuationCalc: (payload) =>
    safeInvoke("valuation-update-calc", payload),
  createValuationDocx: (payload) =>
    safeInvoke("valuation-create-docx", payload),
  generateValuationValueCalcs: (payload) =>
    safeInvoke("valuation-value-calcs", payload),
  appendValuationPreviewImages: (payload) =>
    safeInvoke("valuation-append-preview-images", payload),
  appendValuationRegistrationCertificates: (payload) =>
    safeInvoke("valuation-append-registration-certificates", payload),

  // Word utilities
  copyWordFile: (payload) => safeInvoke("word-copy-files", payload),

  // Image utilities
  openExternal: (url) => safeInvoke("open-external", url),
  openWebWindow: (payload) => safeInvoke("open-web-window", payload),
  downloadImage: (url, filename) =>
    safeInvoke("download-image", { url, filename }),
  showImageWindow: (url) => safeInvoke("show-image-window", url),
});
