const httpClient = require("./httpClient");

const normalizeKey = (value) =>
  (value || "")
    .toString()
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const uploadAssetDataToDatabase = async (
  reportId,
  reportData,
  companyOfficeId = null,
) => {
  const url = `/report/createReport`;
  const payload = { reportId, reportData };
  if (companyOfficeId) {
    payload.companyOfficeId = companyOfficeId;
  }
  return await httpClient.post(url, payload);
};

const createReportWithCommonFields = async (
  reportId,
  reportData,
  commonFields,
  companyOfficeId = null,
) => {
  const url = `/report/createReportWithCommonFields`;
  const payload = { reportId, reportData, commonFields };
  if (companyOfficeId) {
    payload.companyOfficeId = companyOfficeId;
  }
  return await httpClient.post(url, payload);
};

const updateUrgentReport = async (reportId, reportData = {}, options = {}) => {
  const formData = new FormData();
  const { pdfFile } = options;

  formData.append("reportId", reportId);

  Object.entries(reportData || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === "valuers") {
      formData.append(key, JSON.stringify(value));
      return;
    }
    formData.append(key, value);
  });

  if (pdfFile) {
    formData.append("pdf", pdfFile);
  }

  const response = await httpClient.patch(
    `/elrajhi-upload/reports/${reportId}`,
    formData,
    {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    },
  );

  return response.data;
};

const getAllReports = async (options = {}) => {
  const url = `/report/getAllReports`;

  const { page = 1, limit = 10, ...filters } = options;

  console.log("page", page);

  const params = new URLSearchParams({
    page: page,
    limit: limit,
  });

  Object.keys(filters).forEach((key) => {
    if (
      filters[key] !== undefined &&
      filters[key] !== null &&
      filters[key] !== ""
    ) {
      params.append(key, filters[key]);
    }
  });

  const fullUrl = `${url}?${params.toString()}`;
  const response = await httpClient.get(fullUrl);

  return response.data;
};

const reportExistenceCheck = async (reportId, companyOfficeId = null) => {
  const url = `/report/reportExistenceCheck/${reportId}`;
  return await httpClient.get(url, {
    params: companyOfficeId ? { companyOfficeId } : {},
  });
};

const addCommonFields = async (
  reportId,
  inspectionDate,
  region,
  city,
  ownerName,
  companyOfficeId = null,
) => {
  const url = "/report/addCommonFields";
  const payload = { reportId, inspectionDate, region, city, ownerName };
  if (companyOfficeId) {
    payload.companyOfficeId = companyOfficeId;
  }
  return await httpClient.put(url, payload);
};

const checkMissingPages = async (reportId, companyOfficeId = null) => {
  const url = `/report/checkMissingPages/${reportId}`;
  return await httpClient.get(url, {
    params: companyOfficeId ? { companyOfficeId } : {},
  });
};

const uploadElrajhiBatch = async (
  validationExcelFile,
  validationPdfFiles,
  valuers = null,
  companyOfficeId = null,
  pdfPathMap = {}, // Add this parameter for PDF paths
) => {
  const formData = new FormData();

  // field name MUST match Multer config: 'excel'
  formData.append("excel", validationExcelFile);

  // field name MUST match Multer config: 'pdfs'
  (validationPdfFiles || []).forEach((file) => {
    formData.append("pdfs", file);
  });

  if (Array.isArray(valuers) && valuers.length > 0) {
    formData.append("valuers", JSON.stringify(valuers));
  }
  if (companyOfficeId) {
    formData.append("companyOfficeId", companyOfficeId);
  }

  // Add PDF path mappings (NEW)
  Object.entries(pdfPathMap).forEach(([key, value]) => {
    formData.append(key, value);
  });

  // Add skipPdfUpload and dummy path if no PDFs
  const skipPdfUpload = (validationPdfFiles || []).length === 0;
  if (skipPdfUpload) {
    formData.append("skipPdfUpload", "true");
    formData.append("dummy_pdf_path", "dummy_placeholder.pdf");
  }

  const response = await httpClient.post("/elrajhi-upload", formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });

  return response.data;
};

const multiExcelUpload = async (
  validationExcelFiles,
  validationPdfFiles,
  valuers = null,
  companyOfficeId = null,
  pdfPathMap = {}, // Add this parameter for PDF paths
) => {
  const formData = new FormData();
  validationExcelFiles.forEach((file) => {
    formData.append("excels", file);
  });
  validationPdfFiles.forEach((file) => {
    formData.append("pdfs", file);
  });
  if (Array.isArray(valuers) && valuers.length > 0) {
    formData.append("valuers", JSON.stringify(valuers));
  }
  if (companyOfficeId) {
    formData.append("companyOfficeId", companyOfficeId);
  }

  // Add PDF path mappings (NEW)
  const normalizedPdfPathMap = {};

  Object.entries(pdfPathMap).forEach(([key, value]) => {
    normalizedPdfPathMap[normalizeKey(key)] = value;
  });

  formData.append("pdfPathMap", JSON.stringify(normalizedPdfPathMap));

  // Add skipPdfUpload and dummy path if no PDFs
  const skipPdfUpload = validationPdfFiles.length === 0;
  if (skipPdfUpload) {
    formData.append("skipPdfUpload", "true");
  }

  const response = await httpClient.post("/multi-approach", formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
  return response.data;
};

const fetchMultiApproachReports = async (
  companyOfficeId = null,
  options = {},
) => {
  const params = {};
  if (companyOfficeId) params.companyOfficeId = companyOfficeId;
  if (options?.unassigned) params.unassigned = true;
  const response = await httpClient.get("/multi-approach", { params });
  return response.data;
};

const updateMultiApproachReport = async (
  reportId,
  payload = {},
  options = {},
) => {
  const { pdfFile, useTemporaryPdf } = options;
  let requestBody = payload;
  const headers = {};

  const shouldUseFormData = Boolean(pdfFile || useTemporaryPdf);
  if (shouldUseFormData) {
    const formData = new FormData();

    Object.entries(payload || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (
        key === "valuers" ||
        key === "report_users" ||
        typeof value === "object"
      ) {
        formData.append(key, JSON.stringify(value));
      } else {
        formData.append(key, value);
      }
    });

    if (pdfFile) {
      formData.append("pdf", pdfFile);
    }

    if (useTemporaryPdf) {
      formData.append("useTemporaryPdf", "true");
    }

    requestBody = formData;
    headers["Content-Type"] = "multipart/form-data";
  }

  const response = await httpClient.patch(
    `/multi-approach/${reportId}`,
    requestBody,
    { headers },
  );
  return response.data;
};

const deleteMultiApproachReport = async (reportId) => {
  const response = await httpClient.delete(`/multi-approach/${reportId}`);
  return response.data;
};

const updateMultiApproachAsset = async (reportId, assetIndex, payload) => {
  const response = await httpClient.patch(
    `/multi-approach/${reportId}/assets/${assetIndex}`,
    payload,
  );
  return response.data;
};

const deleteMultiApproachAsset = async (reportId, assetIndex) => {
  const response = await httpClient.delete(
    `/multi-approach/${reportId}/assets/${assetIndex}`,
  );
  return response.data;
};

const fetchLatestUserReport = async (companyOfficeId = null) => {
  const url = `/duplicate-report/latest`;
  const response = await httpClient.get(url, {
    params: companyOfficeId ? { companyOfficeId } : {},
  });
  return response.data;
};

const createDuplicateReport = async (
  payload,
  companyOfficeId = null,
  pdfPathMap = {},
) => {
  const url = `/duplicate-report`;
  const formData = new FormData();

  if (payload && typeof payload.append === "function") {
    // payload is already a FormData object
    for (const [key, value] of payload.entries()) {
      formData.append(key, value);
    }
  } else {
    // payload is a regular object
    Object.entries(payload || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (typeof value === "object") {
        formData.append(key, JSON.stringify(value));
      } else {
        formData.append(key, value);
      }
    });
  }

  if (companyOfficeId) {
    formData.append("companyOfficeId", companyOfficeId);
  }

  // ALWAYS check for pdfPath in the map and append it if present
  // This will be the bundled dummy PDF path when skipping upload
  if (pdfPathMap && pdfPathMap.pdfPath) {
    formData.append("pdfPath", pdfPathMap.pdfPath);
    console.log("📎 API: Appending pdfPath:", pdfPathMap.pdfPath);
  }

  // Check if we have any PDF files OR a pdfPath
  const hasPdfFiles = formData.has("pdf") || (pdfPathMap && pdfPathMap.pdfPath);

  if (!hasPdfFiles) {
    formData.append("skipPdfUpload", "true");
    formData.append("dummy_pdf_path", "dummy_placeholder.pdf");
    console.log("📎 API: No PDF files or paths, using fallback");
  } else {
    // Don't append skipPdfUpload if we have a path - let the frontend control this
    console.log("📎 API: Has PDF files or path:", hasPdfFiles);
  }

  const response = await httpClient.post(url, formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
  return response.data;
};

const fetchDuplicateReports = async ({
  page = 1,
  limit = 10,
  status = "all",
  companyOfficeId = null,
  unassigned = false,
} = {}) => {
  const params = { page, limit, status };
  if (companyOfficeId) params.companyOfficeId = companyOfficeId;
  if (unassigned) params.unassigned = true;
  const response = await httpClient.get("/duplicate-report", {
    params,
  });
  return response.data;
};

const updateDuplicateReport = async (reportId, payload) => {
  const response = await httpClient.patch(
    `/duplicate-report/${reportId}`,
    payload,
  );
  return response.data;
};

const deleteDuplicateReport = async (reportId) => {
  const response = await httpClient.delete(`/duplicate-report/${reportId}`);
  return response.data;
};

const updateDuplicateReportAsset = async (reportId, assetIndex, payload) => {
  const response = await httpClient.patch(
    `/duplicate-report/${reportId}/assets/${assetIndex}`,
    payload,
  );
  return response.data;
};

const deleteDuplicateReportAsset = async (reportId, assetIndex) => {
  const response = await httpClient.delete(
    `/duplicate-report/${reportId}/assets/${assetIndex}`,
  );
  return response.data;
};

const fetchElrajhiBatches = async (companyOfficeId = null) => {
  const response = await httpClient.get("/elrajhi-upload/batches", {
    params: companyOfficeId ? { companyOfficeId } : {},
  });
  return response.data;
};

const fetchElrajhiBatchReports = async (batchId, companyOfficeId = null) => {
  const response = await httpClient.get(
    `/elrajhi-upload/batches/${batchId}/reports`,
    {
      params: companyOfficeId ? { companyOfficeId } : {},
    },
  );
  return response.data;
};

const fetchElrajhiReportById = async (reportId) => {
  const response = await httpClient.get(`/elrajhi-upload/reports/${reportId}`);
  return response.data;
};

const createManualMultiApproachReport = async (
  payload,
  companyOfficeId = null,
) => {
  const finalPayload = { ...(payload || {}) };
  if (companyOfficeId) {
    finalPayload.companyOfficeId = companyOfficeId;
  }
  const response = await httpClient.post(
    "/multi-approach/manual",
    finalPayload,
  );
  return response.data;
};

const submitReportsQuicklyUpload = async (
  validationExcelFiles,
  validationPdfFiles,
  skipPdfUpload = false,
  companyOfficeId = null,
  pdfPathMap = {},
) => {
  const formData = new FormData();
  validationExcelFiles.forEach((file) => {
    formData.append("excels", file);
  });
  validationPdfFiles.forEach((file) => {
    formData.append("pdfs", file);
  });
  if (skipPdfUpload) {
    formData.append("skipPdfUpload", "true");
  }
  if (companyOfficeId) {
    formData.append("companyOfficeId", companyOfficeId);
  }

  // Add PDF path mappings
  formData.append("pdfPathMap", JSON.stringify(pdfPathMap));

  // Add dummy PDF path if needed
  if (skipPdfUpload) {
    formData.append("dummy_pdf_path", "dummy_placeholder.pdf");
  }

  const response = await httpClient.post("/submit-reports-quickly", formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
  return response.data;
};

const fetchSubmitReportsQuickly = async (
  companyOfficeId = null,
  options = {},
) => {
  const params = {};
  if (companyOfficeId) params.companyOfficeId = companyOfficeId;
  const response = await httpClient.get("/submit-reports-quickly", { params });
  return response.data;
};

const updateSubmitReportsQuickly = async (reportId, payload) => {
  const response = await httpClient.patch(
    `/submit-reports-quickly/${reportId}`,
    payload,
  );
  return response.data;
};

const deleteSubmitReportsQuickly = async (reportId) => {
  const response = await httpClient.delete(
    `/submit-reports-quickly/${reportId}`,
  );
  return response.data;
};

const updateSubmitReportsQuicklyAsset = async (
  reportId,
  assetIndex,
  payload,
) => {
  const response = await httpClient.patch(
    `/submit-reports-quickly/${reportId}/assets/${assetIndex}`,
    payload,
  );
  return response.data;
};

const deleteSubmitReportsQuicklyAsset = async (reportId, assetIndex) => {
  const response = await httpClient.delete(
    `/submit-reports-quickly/${reportId}/assets/${assetIndex}`,
  );
  return response.data;
};

const updateReportCompanyOffice = async (recordId, companyOfficeId) => {
  const payload = { companyOfficeId };
  const response = await httpClient.patch(
    `/report/${recordId}/company-office`,
    payload,
  );
  return response.data;
};

module.exports = {
  uploadAssetDataToDatabase,
  createReportWithCommonFields,
  reportExistenceCheck,
  addCommonFields,
  checkMissingPages,
  uploadElrajhiBatch,
  multiExcelUpload,
  getAllReports,
  fetchLatestUserReport,
  createDuplicateReport,
  fetchDuplicateReports,
  updateDuplicateReport,
  deleteDuplicateReport,
  updateDuplicateReportAsset,
  deleteDuplicateReportAsset,
  updateUrgentReport,
  fetchElrajhiBatches,
  fetchElrajhiBatchReports,
  fetchElrajhiReportById,
  createManualMultiApproachReport,
  fetchMultiApproachReports,
  updateMultiApproachReport,
  deleteMultiApproachReport,
  updateMultiApproachAsset,
  deleteMultiApproachAsset,
  submitReportsQuicklyUpload,
  fetchSubmitReportsQuickly,
  updateSubmitReportsQuickly,
  deleteSubmitReportsQuickly,
  updateSubmitReportsQuicklyAsset,
  deleteSubmitReportsQuicklyAsset,
  updateReportCompanyOffice,
};
