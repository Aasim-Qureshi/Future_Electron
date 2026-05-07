import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavStatus } from "../context/NavStatusContext";
import { useRam } from "../context/RAMContext";
import usePersistentState from "../hooks/usePersistentState";
import { useSession } from "../context/SessionContext";
import { useSystemControl } from "../context/SystemControlContext";
import { useAuthAction } from "../hooks/useAuthAction";
import InsufficientPointsModal from "../components/InsufficientPointsModal";
import DeductionNotification from "../components/DeductionNotification";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import {
  FileSpreadsheet,
  Files,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Send,
  Trash2,
  Edit,
  RefreshCw,
  Table,
  FileIcon,
  X,
} from "lucide-react";
import {
  submitReportsQuicklyUpload,
  fetchSubmitReportsQuickly,
  updateSubmitReportsQuickly,
  deleteSubmitReportsQuickly,
} from "../../api/report";
import {
  ensureTaqeemAuthorized,
  extractTaqeemUsernameFromUser,
  isTaqeemAuthSuccess,
} from "../../shared/helper/taqeemAuthWrap";
import { deductPoints } from "../utils/points";
import { downloadTemplateFile } from "../utils/templateDownload";
import { useValueNav } from "../context/ValueNavContext";
import { recordUploadBatch } from "../utils/reportUploadStats";
import excelIconFallback from "../../../public/images/excelicon.png";

const DUMMY_PDF_NAME = "dummy_placeholder.pdf";

const getReportRecordId = (report) =>
  report?._id || report?.id || report?.recordId || "";

const toPositiveInt = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.trunc(numeric);
};

const resolveReportAssetCount = (report, fallback = 0) => {
  const fromAssets = Array.isArray(report?.asset_data)
    ? report.asset_data.length
    : 0;
  if (fromAssets > 0) return fromAssets;

  const candidates = [
    report?.number_of_macros,
    report?.numberOfMacros,
    report?.asset_count,
    report?.assets_count,
    report?.assetCount,
    report?.total_assets,
    fallback,
  ];

  for (const candidate of candidates) {
    const normalized = toPositiveInt(candidate);
    if (normalized > 0) return normalized;
  }

  return 0;
};

const isAssetComplete = (asset) => {
  const value = asset?.submitState ?? asset?.submit_state;
  return value === 1 || value === "1" || value === true;
};

const hasTaqeemReportId = (report) =>
  Boolean(String(report?.report_id || "").trim());

const computeQuickReportStatus = (report) => {
  const rawStatus = String(report?.report_status || "").trim().toLowerCase();
  if (!hasTaqeemReportId(report)) return "new";
  if (rawStatus === "sent") return "sent";
  if (rawStatus === "confirmed" || rawStatus === "approved") return "confirmed";

  const assetList = Array.isArray(report?.asset_data) ? report.asset_data : [];
  const hasAssets = assetList.length > 0;
  const allComplete = hasAssets
    ? assetList.every((asset) => isAssetComplete(asset))
    : false;

  if (allComplete) return "complete";
  return "incomplete";
};

const getReportStatus = (report) => computeQuickReportStatus(report);

const getAllowedRowActions = (report) => {
  if (hasTaqeemReportId(report)) {
    return ["check-status", "retry", "delete"];
  }
  return ["submit-taqeem"];
};

const reportStatusLabels = {
  sent: "Sent",
  confirmed: "Confirmed",
  complete: "Complete",
  incomplete: "Incomplete",
  new: "New",
};

const reportStatusClasses = {
  sent: "border-sky-200 bg-sky-50 text-sky-700",
  confirmed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  complete: "border-blue-200 bg-blue-50 text-blue-700",
  incomplete: "border-amber-200 bg-amber-50 text-amber-700",
  new: "border-slate-200 bg-slate-50 text-slate-700",
};
const ALLOWED_REPORT_FILTERS = new Set([
  "all",
  "new",
  "incomplete",
  "complete",
  "sent",
  "confirmed",
]);
const QUICK_PAGE_NAME = "Submit Reports Quickly";
const QUICK_PAGE_SOURCE = "submit-reports-quickly";
const DEFAULT_REPORT_INFO_FORM = {
  title: "",
  client_name: "",
  purpose_id: "1",
  value_premise_id: "1",
  report_type: "تقرير مفصل",
  telephone: "999999999",
  email: "a@a.com",
};

const getTaqeemAuthErrorMessage = (authStatus, fallback) =>
  authStatus?.error || authStatus?.message || fallback;

const ASSET_USAGE_TEXT_TO_ID = {
  زراعي: 38,
  بحري: 39,
  المواصلات: 40,
  طيران: 41,
  "الخدمات اللوجستية": 42,
  طباعة: 43,
  بناء: 44,
  "الغزل والنسيج": 45,
  ضيافة: 46,
  التعدين: 47,
  "الدباغة والتغليف": 48,
  الاتصالات: 49,
  "النفط والغاز": 50,
  المستشفيات: 51,
  الأدوية: 52,
  "مأكولات ومشروبات": 53,
  مياه: 54,
  "مياه الصرف الصحي": 55,
  الكهرباء: 56,
};

const normalizeAssetUsageText = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[ـ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const NORMALIZED_ASSET_USAGE_TEXT_TO_ID = Object.entries(
  ASSET_USAGE_TEXT_TO_ID,
).reduce((acc, [label, id]) => {
  acc[normalizeAssetUsageText(label)] = id;
  return acc;
}, {});

const VALID_ASSET_USAGE_IDS = new Set(Object.values(ASSET_USAGE_TEXT_TO_ID));
const VALID_ASSET_USAGE_LABELS = Object.keys(ASSET_USAGE_TEXT_TO_ID);

const normalizeOfficeId = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const getReportCompanyOfficeId = (report) =>
  normalizeOfficeId(
    report?.company_office_id ??
      report?.companyOfficeId ??
      report?.officeId ??
      report?.office_id,
  );

const resolveAssetUsageId = (rawValue) => {
  if (!hasValue(rawValue)) return null;
  if (typeof rawValue === "number" && Number.isInteger(rawValue)) {
    return rawValue;
  }
  const rawText = String(rawValue || "").trim();
  if (!rawText) return null;
  if (isStrictInteger(rawText)) {
    return Number(rawText);
  }
  const normalized = normalizeAssetUsageText(rawText);
  return NORMALIZED_ASSET_USAGE_TEXT_TO_ID[normalized] || null;
};

// Helper functions for validation
const normalizeCellValue = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value.text !== undefined) return value.text;
    if (Array.isArray(value.richText)) {
      return value.richText.map((t) => t.text || "").join("");
    }
    if (value.result !== undefined) return value.result;
    if (value.value !== undefined) return value.value;
  }
  return value;
};

const normalizeKey = (value) =>
  (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\W_]+/g, "");

const stripExtension = (filename = "") => filename.replace(/\.[^.]+$/, "");

const hasValue = (val) =>
  val !== undefined &&
  val !== null &&
  (typeof val === "number" || String(val).toString().trim() !== "");

const isStrictInteger = (value) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") {
    return Number.isInteger(value);
  }
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (/[.,]/.test(trimmed)) return false;
  return /^\d+$/.test(trimmed);
};

const parseExcelDateValue = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const msPerDay = 24 * 60 * 60 * 1000;
    return new Date(excelEpoch.getTime() + value * msPerDay);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+$/.test(trimmed)) {
      const serial = parseInt(trimmed, 10);
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const msPerDay = 24 * 60 * 60 * 1000;
      return new Date(excelEpoch.getTime() + serial * msPerDay);
    }

    const normalized = trimmed.replace(/[.]/g, "/");
    const parts = normalized.split(/[\/\-]/).map((p) => p.trim());
    if (parts.length === 3) {
      const [a, b, c] = parts;
      if (a.length === 4) {
        const year = parseInt(a, 10);
        const month = parseInt(b, 10);
        const day = parseInt(c, 10);
        if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
          return new Date(year, month - 1, day);
        }
      } else {
        const day = parseInt(a, 10);
        const month = parseInt(b, 10);
        const year = parseInt(c, 10);
        if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
          return new Date(year, month - 1, day);
        }
      }
    }
  }

  return null;
};

const OPTIONAL_COLUMN_KEYS = new Set(["id"]);
const REQUIRED_COLUMN_RANGE = { start: 2, end: 7 };
const REQUIRED_COLUMN_FALLBACKS = {
  asset_name: 2,
  asset_usage_id: 3,
  final_value: 4,
  inspection_date: 5,
  region: 6,
  city: 7,
};

const REQUIRED_ASSET_FIELDS = [
  {
    key: "asset_name",
    label: "asset_name",
    candidates: [
      "asset_name",
      "asset name",
      "assetname",
      "asset_name\n",
      "Asset Name",
    ],
  },
  {
    key: "asset_usage_id",
    label: "asset_usage_id",
    candidates: [
      "asset_usage_id",
      "asset usage id",
      "asset usage",
      "asset_usage_id\n",
      "Asset Usage ID",
    ],
  },
  {
    key: "final_value",
    label: "final_value",
    candidates: [
      "final_value",
      "final value",
      "value",
      "Final Value",
      "Value",
      "final_value\n",
    ],
  },
  {
    key: "inspection_date",
    label: "inspection_date",
    candidates: [
      "inspection_date",
      "inspection date",
      "inspectiondate",
      "inspection_date\n",
      "Inspection Date",
    ],
  },
  {
    key: "region",
    label: "region",
    candidates: ["region", "region name", "Region"],
  },
  {
    key: "city",
    label: "city",
    candidates: ["city", "City"],
  },
];

const pickFieldValue = (row, candidates = []) => {
  if (!row) return undefined;
  const normalizedMap = Object.keys(row).reduce((acc, key) => {
    acc[normalizeKey(key)] = key;
    return acc;
  }, {});

  for (const candidate of candidates) {
    const matchKey = normalizedMap[normalizeKey(candidate)];
    if (matchKey !== undefined) {
      return row[matchKey];
    }
  }
  return undefined;
};

const worksheetToObjects = (worksheet) => {
  const headerRow = worksheet.getRow(1);
  const headerMap = [];
  const maxCol = worksheet.columnCount || headerRow.values.length - 1;
  const headerCounts = {};

  const nextHeaderName = (rawHeader, fallback) => {
    const base = String(rawHeader || fallback || "").trim() || fallback;
    const count = (headerCounts[base] || 0) + 1;
    headerCounts[base] = count;
    return count === 1 ? base : `${base}_${count}`;
  };

  for (let col = 1; col <= maxCol; col++) {
    const header =
      String(
        normalizeCellValue(headerRow.getCell(col).value) || `col_${col}`,
      ).trim() || `col_${col}`;
    headerMap[col] = nextHeaderName(header, `col_${col}`);
  }

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};

    for (let col = 1; col < headerMap.length; col++) {
      const key = headerMap[col] || `col_${col}`;
      obj[key] = normalizeCellValue(row.getCell(col).value);
    }

    rows.push(obj);
  });

  return rows;
};

const validateRequiredAssetFields = (
  sheetName,
  rows = [],
  localize = (key, defaultValue, opts = {}) => defaultValue,
) => {
  const issues = [];
  const addIssue = (field, location, message) =>
    issues.push({ field, location, message });
  const requiredKeySet = new Set(
    REQUIRED_ASSET_FIELDS.flatMap((field) =>
      field.candidates.map((name) => normalizeKey(name)),
    ),
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const getAllowedKeys = (rowKeys) =>
    rowKeys.slice(
      Math.max(REQUIRED_COLUMN_RANGE.start - 1, 0),
      REQUIRED_COLUMN_RANGE.end,
    );

  const pickFieldValueWithinKeys = (row, candidates, allowedKeysSet) => {
    if (!row) return undefined;
    const normalizedMap = Object.keys(row).reduce((acc, key) => {
      const normalized = normalizeKey(key);
      if (allowedKeysSet.has(normalized)) {
        acc[normalized] = key;
      }
      return acc;
    }, {});

    for (const candidate of candidates) {
      const matchKey = normalizedMap[normalizeKey(candidate)];
      if (matchKey !== undefined) {
        return row[matchKey];
      }
    }
    return undefined;
  };

  rows.forEach((row, idx) => {
    if (!row) return;
    const hasAnyValue = Object.values(row).some((value) => hasValue(value));
    if (!hasAnyValue) return;

    const location = `${sheetName} row ${idx + 2}`;
    const rowKeys = Object.keys(row);
    const allowedKeys = getAllowedKeys(rowKeys);
    const allowedKeySet = new Set(allowedKeys.map((key) => normalizeKey(key)));

    allowedKeys.forEach((key) => {
      const normalizedKey = normalizeKey(key);
      if (OPTIONAL_COLUMN_KEYS.has(normalizedKey)) {
        return;
      }
      if (requiredKeySet.has(normalizedKey)) {
        return;
      }
      if (!hasValue(row[key])) {
        addIssue(
          key,
          location,
          localize("missingColumn", `Missing value for column "${key}".`, {
            column: key,
          }),
        );
      }
    });

    const assetName =
      pickFieldValueWithinKeys(
        row,
        REQUIRED_ASSET_FIELDS[0].candidates,
        allowedKeySet,
      ) ?? row[rowKeys[REQUIRED_COLUMN_FALLBACKS.asset_name - 1]];
    if (!hasValue(assetName)) {
      addIssue(
        "asset_name",
        location,
        localize("missingAssetName", "Missing asset_name."),
      );
    }

    const assetUsageRaw =
      pickFieldValueWithinKeys(
        row,
        REQUIRED_ASSET_FIELDS[1].candidates,
        allowedKeySet,
      ) ?? row[rowKeys[REQUIRED_COLUMN_FALLBACKS.asset_usage_id - 1]];
    if (!hasValue(assetUsageRaw)) {
      addIssue(
        "asset_usage_id",
        location,
        localize("missingAssetUsageId", "Missing asset_usage_id."),
      );
    } else {
      const usageId = resolveAssetUsageId(assetUsageRaw);
      if (!usageId || !VALID_ASSET_USAGE_IDS.has(usageId)) {
        addIssue(
          "asset_usage_id",
          location,
          localize(
            "invalidAssetUsageId",
            `asset_usage_id must be one of: ${VALID_ASSET_USAGE_LABELS.join(", ")}`,
            { allowed: VALID_ASSET_USAGE_LABELS.join(", ") },
          ),
        );
      }
    }

    const finalValue =
      pickFieldValueWithinKeys(
        row,
        REQUIRED_ASSET_FIELDS[2].candidates,
        allowedKeySet,
      ) ?? row[rowKeys[REQUIRED_COLUMN_FALLBACKS.final_value - 1]];
    if (!hasValue(finalValue)) {
      addIssue(
        "final_value",
        location,
        localize("missingFinalValue", "Missing final_value."),
      );
    } else {
      if (!isStrictInteger(finalValue)) {
        addIssue(
          "final_value",
          location,
          localize(
            "finalValueWholeNumber",
            "final_value must be a whole number (no decimals).",
          ),
        );
      } else if (Number(finalValue) <= 0) {
        addIssue(
          "final_value",
          location,
          localize("finalValuePositive", "final_value must be greater than 0."),
        );
      }
    }

    const inspectionRaw =
      pickFieldValueWithinKeys(
        row,
        REQUIRED_ASSET_FIELDS[3].candidates,
        allowedKeySet,
      ) ?? row[rowKeys[REQUIRED_COLUMN_FALLBACKS.inspection_date - 1]];
    if (!hasValue(inspectionRaw)) {
      addIssue(
        "inspection_date",
        location,
        localize("missingInspectionDate", "Missing inspection_date."),
      );
    } else {
      const inspectionDate = parseExcelDateValue(inspectionRaw);
      if (!inspectionDate || Number.isNaN(inspectionDate.getTime())) {
        addIssue(
          "inspection_date",
          location,
          localize(
            "invalidInspectionDate",
            "inspection_date is not a valid date.",
          ),
        );
      } else if (inspectionDate > today) {
        addIssue(
          "inspection_date",
          location,
          localize(
            "inspectionDateFuture",
            "inspection_date cannot be in the future.",
          ),
        );
      }
    }

    const region =
      pickFieldValueWithinKeys(
        row,
        REQUIRED_ASSET_FIELDS[4].candidates,
        allowedKeySet,
      ) ?? row[rowKeys[REQUIRED_COLUMN_FALLBACKS.region - 1]];
    if (!hasValue(region)) {
      addIssue(
        "region",
        location,
        localize("missingRegion", "Missing region."),
      );
    }

    const city =
      pickFieldValueWithinKeys(
        row,
        REQUIRED_ASSET_FIELDS[5].candidates,
        allowedKeySet,
      ) ?? row[rowKeys[REQUIRED_COLUMN_FALLBACKS.city - 1]];
    if (!hasValue(city)) {
      addIssue("city", location, localize("missingCity", "Missing city."));
    }
  });

  return issues;
};

const validateAssetUsageId = (
  sheetName,
  rows = [],
  localize = (key, defaultValue, opts = {}) => defaultValue,
) => {
  const issues = [];
  const addIssue = (field, location, message) =>
    issues.push({ field, location, message });

  rows.forEach((row, idx) => {
    const assetName =
      row.asset_name ||
      row.assetName ||
      row["asset_name\n"] ||
      row["Asset Name"] ||
      "";
    if (!hasValue(assetName)) return;
    const assetUsageId = pickFieldValue(row, [
      "asset_usage_id",
      "asset usage id",
      "asset usage",
      "asset_usage_id\n",
      "Asset Usage ID",
    ]);
    if (!hasValue(assetUsageId)) {
      addIssue(
        "asset_usage_id",
        `${sheetName} row ${idx + 2}`,
        localize(
          "missingAssetUsageForAsset",
          `Missing asset_usage_id for asset "${assetName}"`,
          { asset: assetName },
        ),
      );
    } else {
      const usageId = resolveAssetUsageId(assetUsageId);
      if (!usageId || !VALID_ASSET_USAGE_IDS.has(usageId)) {
        addIssue(
          "asset_usage_id",
          `${sheetName} row ${idx + 2}`,
          localize(
            "invalidAssetUsageForAsset",
            `asset_usage_id must be one of: ${VALID_ASSET_USAGE_LABELS.join(", ")} for asset "${assetName}"`,
            { allowed: VALID_ASSET_USAGE_LABELS.join(", "), asset: assetName },
          ),
        );
      }
    }
  });

  return issues;
};

const validateCostSheetIntegers = (
  rows = [],
  localize = (key, defaultValue, opts = {}) => defaultValue,
) => {
  const issues = [];
  const addIssue = (field, location, message) =>
    issues.push({ field, location, message });

  rows.forEach((row, idx) => {
    const assetName =
      row.asset_name ||
      row.assetName ||
      row["asset_name\n"] ||
      row["Asset Name"] ||
      "";
    if (!hasValue(assetName)) return;
    const rawFinal = pickFieldValue(row, [
      "final_value",
      "final value",
      "value",
      "Final Value",
      "Value",
      "final_value\n",
    ]);
    if (!hasValue(rawFinal)) {
      addIssue(
        "final_value",
        `cost row ${idx + 2}`,
        localize(
          "costMissingFinalValue",
          `Missing final_value for asset "${assetName}"`,
          { asset: assetName },
        ),
      );
      return;
    }

    if (!isStrictInteger(rawFinal)) {
      addIssue(
        "final_value",
        `cost row ${idx + 2}`,
        localize(
          "costFinalValueInteger",
          `final_value must be a whole number (no decimals) for asset "${assetName}"`,
          { asset: assetName },
        ),
      );
      return;
    }

    const num = Number(rawFinal);
    if (num <= 0) {
      addIssue(
        "final_value",
        `cost row ${idx + 2}`,
        localize(
          "costFinalValuePositive",
          `final_value must be greater than 0 for asset "${assetName}"`,
          { asset: assetName },
        ),
      );
    }
  });

  return issues;
};

const validateMarketSheet = (
  rows = [],
  localize = (key, defaultValue, opts = {}) => defaultValue,
) => {
  const issues = [];
  const addIssue = (field, location, message) =>
    issues.push({ field, location, message });

  rows.forEach((row, idx) => {
    const assetName =
      row.asset_name ||
      row.assetName ||
      row["asset_name\n"] ||
      row["Asset Name"] ||
      "";
    if (!hasValue(assetName)) return;
    const rawFinal = pickFieldValue(row, [
      "final_value",
      "final value",
      "value",
      "Final Value",
      "Value",
      "final_value\n",
    ]);
    if (!hasValue(rawFinal)) {
      addIssue(
        "final_value",
        `market row ${idx + 2}`,
        localize(
          "marketMissingFinalValue",
          `Missing final_value for asset "${assetName}"`,
          { asset: assetName },
        ),
      );
      return;
    }

    if (!isStrictInteger(rawFinal)) {
      addIssue(
        "final_value",
        `market row ${idx + 2}`,
        localize(
          "marketFinalValueInteger",
          `final_value must be a whole number (no decimals) for asset "${assetName}"`,
          { asset: assetName },
        ),
      );
      return;
    }

    const num = Number(rawFinal);
    if (num <= 0) {
      addIssue(
        "final_value",
        `market row ${idx + 2}`,
        localize(
          "marketFinalValuePositive",
          `final_value must be greater than 0 for asset "${assetName}"`,
          { asset: assetName },
        ),
      );
    }
  });

  return issues;
};

// PDF size validation (20 MB = 20 * 1024 * 1024 bytes)
const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20 MB in bytes

const SubmitReportsQuickly = ({ onViewChange }) => {
  const { token, login, user, isGuest } = useSession();
  const { t, i18n } = useTranslation();
  const translate = useCallback(
    (key, defaultValue, options = {}) =>
      t(`submitReportsQuickly.${key}`, { defaultValue, ...options }),
    [t],
  );
  const isArabicUi = useMemo(
    () => i18n?.dir?.(i18n?.resolvedLanguage || i18n?.language) === "rtl",
    [i18n, i18n?.language, i18n?.resolvedLanguage],
  );
  const { systemState } = useSystemControl();
  const { executeWithAuth } = useAuthAction();
  const { taqeemStatus, setTaqeemStatus, setCompanyStatus } = useNavStatus();
  const {
    companies,
    selectedCompany,
    preferredCompany,
    replaceCompanies,
    ensureCompaniesLoaded,
    setSelectedCompany,
  } = useValueNav();
  const taqeemLinked = Boolean(extractTaqeemUsernameFromUser(user || {}));
  const selectedCompanyOfficeId = useMemo(() => {
    const officeId = selectedCompany?.officeId || selectedCompany?.office_id;
    return officeId ? String(officeId) : "";
  }, [selectedCompany]);
  const { ramInfo } = useRam();
  const recommendedTabs = ramInfo?.recommendedTabs || 3;
  const guestAccessEnabled = systemState?.guestAccessEnabled ?? true;
  const guestSession = isGuest || !token;
  const authOptions = useMemo(
    () => ({
      isGuest: guestSession,
      guestAccessEnabled,
      cachedUser: user || null,
      selectedCompanyOfficeId: selectedCompanyOfficeId || null,
      disableAppAuthRedirects: true,
    }),
    [guestSession, guestAccessEnabled, selectedCompanyOfficeId, user],
  );
  const [excelFiles, setExcelFiles] = useState([]);
  const [pdfFiles, setPdfFiles] = useState([]);
  const [wantsPdfUpload, setWantsPdfUpload] = useState(false);
  const [storeAndSubmitLoading, setStoreAndSubmitLoading] = useState(false);
  const [storeOnlyLoading, setStoreOnlyLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [pdfPathMap, setPdfPathMap] = useState({});
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [reportsPagination, setReportsPagination] = useState({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [validationItems, setValidationItems] = useState([]);
  const [validationMessage, setValidationMessage] = useState(null);
  const [validationTableTab, setValidationTableTab] = useState("assets");
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [validationModalStep, setValidationModalStep] = useState("validation");
  const [showInsufficientPointsModal, setShowInsufficientPointsModal] =
    useState(false);
  const [insufficientPointsMeta, setInsufficientPointsMeta] = useState(null);
  const [reports, setReports, resetReports] = usePersistentState(
    "submitReportsQuickly:reports",
    [],
    { storage: "session" },
  );
  const [pendingSubmit, setPendingSubmit, resetPendingSubmit] =
    usePersistentState("submitReportsQuickly:pendingSubmit", null, {
      storage: "session",
    });
  const [, setReturnView, resetReturnView] = usePersistentState(
    "taqeem:returnView",
    null,
    { storage: "session" },
  );
  const [reportsLoading, setReportsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [expandedReports, setExpandedReports] = useState([]);
  const [selectedReportIds, setSelectedReportIds] = useState([]);
  const [reportSelectFilter, setReportSelectFilter] = useState("all");
  const [reportActionBusy, setReportActionBusy] = useState({});
  const [actionDropdown, setActionDropdown] = useState({});
  const [bulkAction, setBulkAction] = useState("");
  const [editingReportId, setEditingReportId] = useState(null);
  const [reportProgress, setReportProgress] = useState({}); // { recordId: { percentage: 0, status: 'idle', message: '' } }
  const [uploadFormData, setUploadFormData] = useState({
    ...DEFAULT_REPORT_INFO_FORM,
  });
  const [formData, setFormData] = useState({
    ...DEFAULT_REPORT_INFO_FORM,
  });
  const [excelIconSrc, setExcelIconSrc] = useState(excelIconFallback);

  const excelInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const reportCreationWaitersRef = useRef(new Map());
  const reportCreatedCacheRef = useRef(new Map());
  const pendingCompanySelectionRef = useRef(null);
  const isTaqeemLoggedIn = taqeemStatus?.state === "success";

  /** Same Taqeem/session/electron gate as ElRajhi before uploads and desktop actions. */
  const ensureQuickUploadActionReady = useCallback(
    async (authTokenOverride = null) => {
      if (!selectedCompanyOfficeId) {
        throw new Error(
          translate(
            "messages.error.companyRequiredForUpload",
            "Select a company before uploading reports.",
          ),
        );
      }

      const tokenForAuth = authTokenOverride ?? token;
      const guestForAuth = isGuest || !tokenForAuth;
      const officeIdForAuth =
        selectedCompany?.officeId || selectedCompany?.office_id || null;

      const authStatus = await ensureTaqeemAuthorized(
        tokenForAuth,
        onViewChange,
        taqeemStatus?.state === "success",
        0,
        login,
        setTaqeemStatus,
        {
          isGuest: guestForAuth,
          guestAccessEnabled: systemState?.guestAccessEnabled ?? true,
          cachedUser: user || null,
          selectedCompanyOfficeId: officeIdForAuth,
          disableAppAuthRedirects: true,
        },
      );

      if (authStatus?.status === "INSUFFICIENT_POINTS") {
        setShowInsufficientPointsModal(true);
        throw new Error(
          authStatus?.message ||
            authStatus?.reason ||
            translate(
              "messages.error.insufficientPoints",
              "You don't have enough points for this action.",
            ),
        );
      }

      if (authStatus?.status === "LOGIN_REQUIRED") {
        throw new Error(
          translate(
            "messages.error.taqeemLoginRequired",
            "Taqeem login required. Finish login and choose a company to continue.",
          ),
        );
      }

      if (!isTaqeemAuthSuccess(authStatus)) {
        throw new Error(
          getTaqeemAuthErrorMessage(
            authStatus,
            translate(
              "messages.error.taqeemLoginRequired",
              "Taqeem login required. Finish login and choose a company to continue.",
            ),
          ),
        );
      }

      if (!window?.electronAPI?.checkStatus) {
        return authStatus;
      }

      const status = await window.electronAPI.checkStatus();
      const statusCode = String(status?.status || "").toUpperCase();
      const isReady = Boolean(
        status?.browserOpen && statusCode.includes("SUCCESS"),
      );

      if (!isReady) {
        throw new Error(
          status?.error ||
            translate(
              "messages.error.taqeemBrowserOff",
              "Taqeem connection is off. Turn Taqeem connection on, then retry.",
            ),
        );
      }

      return authStatus;
    },
    [
      isGuest,
      login,
      onViewChange,
      selectedCompany,
      selectedCompanyOfficeId,
      setShowInsufficientPointsModal,
      setTaqeemStatus,
      systemState?.guestAccessEnabled,
      taqeemStatus?.state,
      token,
      translate,
      user,
    ],
  );

  useEffect(() => {
    if (ALLOWED_REPORT_FILTERS.has(reportSelectFilter)) return;
    setReportSelectFilter("all");
  }, [reportSelectFilter]);

  useEffect(() => {
    let objectUrl = null;
    let disposed = false;

    const loadIconFromPublic = async () => {
      try {
        if (!window?.electronAPI?.readTemplateFile) return;
        const result = await window.electronAPI.readTemplateFile(
          "images/excelicon.png",
        );
        if (!result?.success || !Array.isArray(result.arrayBuffer)) return;
        const bytes = Uint8Array.from(result.arrayBuffer);
        if (!bytes.length) return;

        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "image/png" }),
        );
        if (!disposed) {
          setExcelIconSrc(objectUrl);
        }
      } catch (err) {
        // Keep fallback icon from webpack bundle.
      }
    };

    loadIconFromPublic();
    return () => {
      disposed = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, []);

  const handleExcelChange = (e) => {
    const files = Array.from(e.target.files || []);
    setExcelFiles(files);
    resetMessages();
    if (excelInputRef?.current) {
      excelInputRef.current.value = null;
    }
  };

  const handlePdfChange = async (e) => {
    const files = Array.from(e.target.files || []);

    // Check for oversized files
    const oversizedFiles = files.filter((file) => file.size > MAX_PDF_SIZE);
    if (oversizedFiles.length > 0) {
      const oversizedNames = oversizedFiles.map((f) => f.name).join(", ");
      setError(
        translate(
          "messages.error.pdfSizeLimit",
          "PDF file(s) exceed 20 MB limit: {{files}}",
          { files: oversizedNames },
        ),
      );
      return;
    }

    setPdfFiles(files);

    // Get absolute paths for the selected PDFs
    if (files.length > 0) {
      const paths = await getAbsolutePaths(files);
      setPdfPathMap(paths);
    } else {
      setPdfPathMap({});
    }

    resetMessages();
  };

  // Add this function after the existing helper functions (around line 300)
  const getAbsolutePaths = async (
    files,
    skipPdfUpload = false,
    excelFilesList = [],
  ) => {
    const paths = {};

    // If skipping PDF upload, use the bundled dummy PDF for each Excel file
    if (skipPdfUpload && excelFilesList.length > 0) {
      const dummyPath = await window.electronAPI?.getDummyPdfPath?.();
      if (dummyPath) {
        excelFilesList.forEach((file) => {
          const baseName = normalizeKey(stripExtension(file.name));
          paths[baseName] = dummyPath;
        });
        console.log("Using dummy PDF paths:", paths);
        return paths;
      }
    }

    // Normal flow - get absolute paths for uploaded PDFs
    for (const file of files) {
      const absolutePath = window.electronAPI?.getFileAbsolutePath?.(file);
      if (absolutePath) {
        const baseName = normalizeKey(stripExtension(file.name));
        paths[baseName] = absolutePath;
      }
    }
    console.log("PDF paths", paths);
    return paths;
  };

  const resolveActiveApiToken = async () => {
    if (token) return token;
    const tokenObj = await window.electronAPI.getToken?.();
    const bearer = tokenObj?.refreshToken || tokenObj?.token;
    if (!bearer) {
      throw new Error(
        translate(
          "messages.error.noApiToken",
          "No login session. Restart the app or wait for connection.",
        ),
      );
    }
    return bearer;
  };

  const mergeReports = useCallback((existing = [], incoming = []) => {
    const list = Array.isArray(existing) ? [...existing] : [];
    const seen = new Set(list.map((report) => getReportRecordId(report)));
    (incoming || []).forEach((report) => {
      const id = getReportRecordId(report);
      if (!id) return;
      if (!seen.has(id)) {
        seen.add(id);
        list.unshift(report);
      }
    });
    return list;
  }, []);

  const syncUploadFormFromValidation = useCallback((items = []) => {
    const snapshot =
      items.find((item) => item?.snapshot)?.snapshot ||
      DEFAULT_REPORT_INFO_FORM;
    setUploadFormData({
      title: String(snapshot?.title || ""),
      client_name: String(snapshot?.client_name || ""),
      purpose_id: String(snapshot?.purpose_id || "1"),
      value_premise_id: String(snapshot?.value_premise_id || "1"),
      report_type: String(snapshot?.report_type || "تقرير مفصل"),
      telephone: String(snapshot?.telephone || "999999999"),
      email: String(snapshot?.email || "a@a.com"),
    });
  }, []);

  const applyUploadFormToCreatedReports = useCallback(
    async (createdReports = []) => {
      const payload = {
        title: String(uploadFormData.title || "").trim(),
        client_name: String(uploadFormData.client_name || "").trim(),
        purpose_id: String(uploadFormData.purpose_id || "1"),
        value_premise_id: String(uploadFormData.value_premise_id || "1"),
        report_type: String(uploadFormData.report_type || "تقرير مفصل"),
        telephone: String(uploadFormData.telephone || "999999999").trim(),
        email: String(uploadFormData.email || "a@a.com").trim(),
      };

      const ids = (createdReports || [])
        .map((report) => getReportRecordId(report))
        .filter(Boolean);
      if (!ids.length) return;

      const updates = await Promise.allSettled(
        ids.map((id) => updateSubmitReportsQuickly(id, payload)),
      );
      const failed = updates.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        console.warn(
          "[SubmitReportsQuickly] Failed to apply edited report info for some uploaded reports.",
          failed,
        );
      }
    },
    [uploadFormData],
  );

  const handleStoreAndSubmit = async () => {
    resetMessages();
    resetPendingSubmit();
    resetReturnView();

    if (excelFiles.length === 0) {
      setError(
        translate(
          "messages.error.selectExcelFile",
          "Please select at least one Excel file",
        ),
      );
      return;
    }
    if (wantsPdfUpload && pdfFiles.length === 0) {
      setError(
        translate(
          "messages.error.selectPdfFile",
          "Please select at least one PDF file or disable PDF upload.",
        ),
      );
      return;
    }
    if (
      wantsPdfUpload &&
      (pdfMatchInfo.excelsMissingPdf.length ||
        pdfMatchInfo.unmatchedPdfs.length)
    ) {
      setError(
        translate(
          "messages.error.pdfNamesMismatch",
          "PDF filenames must match the Excel filenames.",
        ),
      );
      return;
    }
    if (!isReadyToUpload) {
      setError(
        translate(
          "messages.error.validationIssues",
          "Please fix validation issues before uploading.",
        ),
      );
      return;
    }

    setStoreAndSubmitLoading(true);
    try {
      const outcome = await executeWithAuth(
        async (params) => {
          const { token: authToken } = params;

          await ensureQuickUploadActionReady(authToken);

          if (!extractTaqeemUsernameFromUser(user || {})) {
            throw new Error(
              translate(
                "messages.error.taqeemRequiredForUpload",
                "Log in to Taqeem and link your account before uploading reports.",
              ),
            );
          }

          if (!authToken) {
            throw new Error(
              translate(
                "messages.error.noApiToken",
                "No login session. Restart the app or wait for connection.",
              ),
            );
          }
          const activeToken = authToken;

          setSuccess(
            translate(
              "messages.success.uploadingFiles",
              "Uploading files to server...",
            ),
          );

          let pdfPaths = {};
          if (wantsPdfUpload && pdfFiles.length > 0) {
            pdfPaths = await getAbsolutePaths(pdfFiles, false);
          } else {
            pdfPaths = await getAbsolutePaths([], true, excelFiles);
          }

          const data = await submitReportsQuicklyUpload(
            excelFiles,
            wantsPdfUpload ? pdfFiles : [],
            !wantsPdfUpload,
            selectedCompanyOfficeId || null,
            pdfPaths,
          );

          if (data.status !== "success") {
            throw new Error(
              data.error ||
                translate("messages.error.uploadFailed", "Upload failed"),
            );
          }

          const createdReports = Array.isArray(data.reports) ? data.reports : [];
          if (createdReports.length) {
            setReports((prev) => mergeReports(prev, createdReports));
            await applyUploadFormToCreatedReports(createdReports);
          }

          const insertedCount = data.created || 0;
          if (insertedCount > 0) {
            recordUploadBatch(selectedCompanyOfficeId, "quick", {
              inserted: insertedCount,
              nameHint: selectedCompany?.name,
            });
          }
          setSuccess(
            translate(
              "messages.success.filesUploadedSubmitting",
              "Files uploaded successfully. Inserted {{count}} report(s). Now submitting to Taqeem...",
              { count: insertedCount },
            ),
          );
          setExcelFiles([]);
          setPdfFiles([]);
          setWantsPdfUpload(false);

          const refreshedReports = await loadReports(activeToken);
          const uploadedReports = Array.isArray(data.reports) ? data.reports : [];
          const candidateReports = uploadedReports.length
            ? uploadedReports
            : refreshedReports;

          const recentReports = [...candidateReports]
            .sort(
              (a, b) =>
                new Date(b.createdAt || b.submitted_at || 0) -
                new Date(a.createdAt || a.submitted_at || 0),
            )
            .slice(0, insertedCount);

          if (insertedCount > 0 && recentReports.length === 0) {
            throw new Error("Could not find the newly uploaded reports.");
          }

          const reportIds = recentReports
            .map((report) => getReportRecordId(report))
            .filter(Boolean);
          if (!reportIds.length) {
            throw new Error(
              "Could not resolve uploaded report IDs for submission.",
            );
          }

          const reportMetaById = recentReports.reduce((acc, report) => {
            const id = getReportRecordId(report);
            if (!id) return acc;
            acc[id] = {
              assetCount: resolveReportAssetCount(report),
              batchId: report?.batch_id || report?.batchId || null,
            };
            return acc;
          }, {});

          const tabsNum = Math.max(1, Number(recommendedTabs) || 3);
          const queuePayload = {
            source: QUICK_PAGE_SOURCE,
            reportIds,
            reportMetaById,
            tabsNum,
            currentIndex: 0,
            resumeOnLoad: false,
            updatedAt: Date.now(),
          };
          setPendingSubmit(queuePayload);

          const queueResult = await runPendingSubmitQueue(queuePayload);
          if (queueResult?.paused) {
            setSuccess(
              translate(
                "messages.success.reportsStoredResumeAfterLogin",
                "Reports were stored successfully. Login to Value Tech with your phone and submission will continue automatically.",
              ),
            );
            return true;
          }

          const successCount = Number(queueResult?.completedCount) || 0;
          if (successCount <= 0) {
            throw new Error("All report submissions failed. Please try again.");
          }

          setSuccess(
            translate(
              "messages.success.successfulUploads",
              "{{count}} report(s) uploaded and submitted to Taqeem successfully.",
              { count: successCount },
            ),
          );
          return true;
        },
        { token },
        {
          requiredPoints: 0,
          skipNavigateToCompany: true,
          showInsufficientPointsModal: () => setShowInsufficientPointsModal(true),
          onViewChange,
          onAuthFailure: (reason) => {
            if (reason === "INSUFFICIENT_POINTS") return;
            if (reason === "LOGIN_REQUIRED") {
              setError(
                translate(
                  "messages.error.taqeemLoginRequired",
                  "Taqeem login required. Finish login and choose a company to continue.",
                ),
              );
              return;
            }
            const msg =
              (typeof reason === "object" && reason?.message) ||
              (typeof reason === "string" ? reason : "") ||
              "";
            if (msg) setError(msg);
          },
        },
      );

      if (outcome === null) {
        return;
      }
    } catch (err) {
      console.error("Store and Submit failed", err);
      const status = err?.response?.status;
      const apiError =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Failed to upload and submit files";

      if (status === 400) {
        setError(
          apiError ||
            translate(
              "messages.error.badRequest",
              "Bad request. Please check the selected files and try again.",
            ),
        );
      } else if (status === 500) {
        setError(
          apiError ||
            translate(
              "messages.error.serverProcessing",
              "Server error while processing your files. Please try again or contact support.",
            ),
        );
      } else if (err?.code === "ERR_NETWORK") {
        setError(
          translate(
            "messages.error.network",
            "Network error. Make sure the backend server is running and reachable.",
          ),
        );
      } else {
        setError(apiError);
      }
    } finally {
      setStoreAndSubmitLoading(false);
    }
  };

  const openPdfPicker = useCallback(() => {
    if (pdfInputRef?.current) {
      pdfInputRef.current.value = null;
      pdfInputRef.current.click();
    }
  }, []);

  const handlePdfToggle = (checked, options = {}) => {
    const { openPicker = false } = options;
    setWantsPdfUpload(checked);
    if (!checked) {
      setPdfFiles([]);
      setPdfPathMap({});
    } else if (openPicker && (!wantsPdfUpload || pdfFiles.length === 0)) {
      setTimeout(() => {
        openPdfPicker();
      }, 0);
    }
    resetMessages();
  };

  const resetMessages = () => {
    setError("");
    setSuccess("");
  };

  const handleDownloadTemplate = async () => {
    if (downloadingTemplate) return;
    resetMessages();
    setDownloadingTemplate(true);
    try {
      await downloadTemplateFile("quick submittion-template.xlsx");
      setSuccess(
        translate(
          "messages.success.templateDownloaded",
          "Excel template downloaded successfully.",
        ),
      );
    } catch (err) {
      const message =
        err?.message ||
        translate(
          "messages.error.templateDownload",
          "Failed to download Excel template. Please try again.",
        );
      setError(
        message.includes("not found")
          ? translate(
              "messages.error.templateNotFound",
              "Template file not found. Please contact administrator to ensure the template file exists in the public folder.",
            )
          : message,
      );
    } finally {
      setDownloadingTemplate(false);
    }
  };

  const resetValidation = () => {
    setValidationItems([]);
    setValidationMessage(null);
    setValidationModalStep("validation");
    setShowValidationModal(false);
  };

  const loadReports = useCallback(
    async (overrideToken) => {
      try {
        const activeToken = overrideToken || token;
        if (!activeToken) {
          setReports([]);
          setReportsPagination({
            page: 1,
            limit: itemsPerPage,
            total: 0,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          });
          setError("");
          return [];
        }

        if (!extractTaqeemUsernameFromUser(user || {}) || !selectedCompanyOfficeId) {
          setReports([]);
          setReportsPagination({
            page: 1,
            limit: itemsPerPage,
            total: 0,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          });
          setError("");
          return [];
        }

        setReportsLoading(true);

        const params = new URLSearchParams({
          page: currentPage.toString(),
          limit: itemsPerPage.toString(),
          companyOfficeId: selectedCompanyOfficeId,
        });

        const result = await window.electronAPI.apiRequest(
          "GET",
          `/api/submit-reports-quickly/user?${params.toString()}`,
          {},
          {
            Authorization: `Bearer ${activeToken}`,
          },
        );

        if (!result?.success) {
          throw new Error(
            result?.message ||
              translate(
                "messages.error.loadReports",
                "Failed to load reports.",
              ),
          );
        }

        const reportList = Array.isArray(result.data)
          ? result.data
          : Array.isArray(result.reports)
            ? result.reports
            : [];
        const paginationInfo = result.pagination || {};
        const statusSyncQueue = [];
        const normalizedReportList = reportList.map((report) => {
          const recordId = getReportRecordId(report);
          const expectedStatus = computeQuickReportStatus(report);
          const currentStatus = String(report?.report_status || "")
            .trim()
            .toLowerCase();
          if (recordId && currentStatus !== expectedStatus) {
            statusSyncQueue.push({ recordId, report_status: expectedStatus });
          }
          return {
            ...report,
            report_status: expectedStatus,
          };
        });

        setReports(normalizedReportList);
        setReportsPagination(paginationInfo);
        if (statusSyncQueue.length > 0) {
          Promise.allSettled(
            statusSyncQueue.map((entry) =>
              updateSubmitReportsQuickly(entry.recordId, {
                report_status: entry.report_status,
              }),
            ),
          ).catch(() => {});
        }
        return normalizedReportList;
      } catch (err) {
        setError(
          err?.message ||
            translate("messages.error.loadReports", "Failed to load reports."),
        );
        return [];
      } finally {
        setReportsLoading(false);
      }
    },
    [
      token,
      user,
      currentPage,
      itemsPerPage,
      selectedCompanyOfficeId,
      setReports,
      setReportsPagination,
      setError,
    ],
  );

  const clearReportCreatedCache = useCallback((recordId) => {
    reportCreatedCacheRef.current.delete(recordId);
  }, []);

  const resolveReportCreated = useCallback((recordId, createdReportId) => {
    if (!recordId || !createdReportId) return;
    reportCreatedCacheRef.current.set(recordId, createdReportId);
    const waiter = reportCreationWaitersRef.current.get(recordId);
    if (waiter) {
      clearTimeout(waiter.timeoutId);
      reportCreationWaitersRef.current.delete(recordId);
      waiter.resolve(createdReportId);
    }
  }, []);

  const waitForReportCreated = useCallback((recordId, timeoutMs = 300000) => {
    if (!recordId) {
      return Promise.reject(new Error("Missing report record id."));
    }
    const cached = reportCreatedCacheRef.current.get(recordId);
    if (cached) {
      reportCreatedCacheRef.current.delete(recordId);
      return Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reportCreationWaitersRef.current.delete(recordId);
        reject(new Error("Timed out waiting for report id."));
      }, timeoutMs);
      reportCreationWaitersRef.current.set(recordId, {
        resolve,
        reject,
        timeoutId,
      });
    });
  }, []);

  useEffect(() => {
    setCurrentPage(1);
    setReports([]);
    setReportsPagination((prev) => ({
      ...prev,
      page: 1,
      total: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    }));
  }, [selectedCompanyOfficeId, setReports, setReportsPagination]);

  const handleReportCreatedUpdate = useCallback(
    (recordId, createdReportId) => {
      if (!recordId || !createdReportId) return;
      setReports((prevReports) =>
        prevReports.map((report) => {
          const rId = report?._id || report?.id || report?.recordId;
          if (rId === recordId) {
            const updatedReport = { ...report, report_id: createdReportId };
            return {
              ...updatedReport,
              report_status: computeQuickReportStatus(updatedReport),
            };
          }
          return report;
        }),
      );
      resolveReportCreated(recordId, createdReportId);
    },
    [resolveReportCreated, setReports],
  );

  // Load reports when page, filter, or page size changes
  useEffect(() => {
    loadReports();
  }, [currentPage, itemsPerPage, token, loadReports]);

  useEffect(() => {
    return () => {
      reportCreationWaitersRef.current.forEach((waiter) => {
        clearTimeout(waiter.timeoutId);
      });
      reportCreationWaitersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (selectedCompany && pendingCompanySelectionRef.current?.resolve) {
      pendingCompanySelectionRef.current.resolve(selectedCompany);
      pendingCompanySelectionRef.current = null;
    }
  }, [selectedCompany]);

  useEffect(() => {
    return () => {
      if (pendingCompanySelectionRef.current?.timeoutId) {
        clearTimeout(pendingCompanySelectionRef.current.timeoutId);
      }
      pendingCompanySelectionRef.current = null;
    };
  }, []);

  const waitForCompanySelection = useCallback(
    (timeoutMs = 120000) => {
      if (selectedCompany) return Promise.resolve(selectedCompany);
      if (pendingCompanySelectionRef.current?.promise) {
        return pendingCompanySelectionRef.current.promise;
      }

      let resolveFn;
      let timeoutId;
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        timeoutId = setTimeout(() => {
          pendingCompanySelectionRef.current = null;
          reject(new Error("Company selection timed out."));
        }, timeoutMs);
      });

      pendingCompanySelectionRef.current = {
        promise,
        timeoutId,
        resolve: (company) => {
          clearTimeout(timeoutId);
          resolveFn(company);
        },
      };

      return promise;
    },
    [selectedCompany],
  );

  const waitForTaqeemCompanies = useCallback(async (options = {}) => {
    const { timeoutMs = 120000, pollMs = 2500 } = options;
    if (!window?.electronAPI?.getCompanies) return [];

    const start = Date.now();
    let lastError = null;

    while (Date.now() - start < timeoutMs) {
      try {
        const data = await window.electronAPI.getCompanies();
        const fetched = Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.companies)
            ? data.companies
            : [];

        if (fetched.length > 0) {
          return fetched.map((company) => ({
            ...company,
            type: company?.type || "equipment",
          }));
        }
      } catch (err) {
        lastError = err;
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (lastError) {
      console.warn("Timed out waiting for Taqeem companies:", lastError);
    }
    return [];
  }, []);

  // Set up real-time progress listener via IPC
  useEffect(() => {
    if (
      !window.electronAPI ||
      !window.electronAPI.onSubmitReportsQuicklyProgress
    ) {
      console.warn("Electron API or progress listener not available");
      return;
    }

    // Set up the progress listener for real-time updates
    const cleanup = window.electronAPI.onSubmitReportsQuicklyProgress(
      (progressData) => {
        console.log("[RENDERER] Progress update received:", progressData);

        if (progressData && (progressData.processId || progressData.reportId)) {
          const recordId = progressData.processId || progressData.reportId;
          if (!recordId) return;

          // Extract progress information
          const percentage = progressData.percentage || 0;
          const message =
            progressData.message || progressData.currentItem || "";
          const createdReportId = progressData.createdReportId;

          // Determine status from progress data - prioritize paused/stopped flags
          let status = "processing";
          // Check paused/stopped flags first (these come from process control system)
          if (
            progressData.paused === true ||
            progressData.paused === "true" ||
            String(progressData.paused).toLowerCase() === "true"
          ) {
            status = "paused";
          } else if (
            progressData.stopped === true ||
            progressData.stopped === "true" ||
            String(progressData.stopped).toLowerCase() === "true"
          ) {
            status = "stopped";
          } else if (progressData.status) {
            // Map status values
            const statusMap = {
              paused: "paused",
              stopped: "stopped",
              processing: "processing",
              starting: "starting",
              completed: "completed",
              error: "error",
            };
            status =
              statusMap[progressData.status.toLowerCase()] ||
              progressData.status;
          } else if (percentage >= 100) {
            status = "completed";
          } else if (percentage > 0) {
            status = "processing";
          } else {
            status = "starting";
          }

          // Update progress state in real-time - preserve existing state if status is same
          setReportProgress((prev) => {
            const existing = prev[recordId] || {};
            return {
              ...prev,
              [recordId]: {
                percentage: Math.min(
                  100,
                  Math.max(0, percentage || existing.percentage || 0),
                ),
                status: status,
                message:
                  message ||
                  existing.message ||
                  `Processing: ${progressData.completed || 0}/${progressData.total || 0}`,
              },
            };
          });

          if (createdReportId) {
            handleReportCreatedUpdate(recordId, createdReportId);
          } else if (message && message.includes("Report created:")) {
            const reportIdMatch = message.match(/Report created:\s*(\S+)/);
            if (reportIdMatch && reportIdMatch[1]) {
              handleReportCreatedUpdate(recordId, reportIdMatch[1]);
            }
          }
        }
      },
    );

    return cleanup;
  }, [handleReportCreatedUpdate]);

  useEffect(() => {
    const handler = (event) => {
      const detail = event?.detail;
      if (!detail || detail.source !== "submit-reports-quickly") return;
      const chapter = Array.isArray(detail.reportSummaries)
        ? detail.reportSummaries
            .map((summary) => summary.reportId)
            .filter(Boolean)
        : [];
      const reportIds = chapter.length
        ? Array.from(new Set(chapter))
        : Array.isArray(detail.reportIds)
          ? detail.reportIds
          : detail.reportId
            ? [detail.reportId]
            : [];
      if (reportIds.length === 0) return;
      const idLabel =
        reportIds.length === 1 ? reportIds[0] : reportIds.join(", ");
      setSuccess(
        `Deducted ${detail.deducted || 0} point${(detail.deducted || 0) === 1 ? "" : "s"} for report${reportIds.length > 1 ? "s" : ""} ${idLabel}.`,
      );
    };
    window.addEventListener("points-updated", handler);
    return () => window.removeEventListener("points-updated", handler);
  }, [setSuccess]);

  const openInsufficientPointsModal = (meta = {}) => {
    setInsufficientPointsMeta(meta);
    setShowInsufficientPointsModal(true);
  };
  const closeInsufficientPointsModal = () => {
    setShowInsufficientPointsModal(false);
    setInsufficientPointsMeta(null);
  };

  const pdfMatchInfo = useMemo(() => {
    if (!wantsPdfUpload) {
      return { unmatchedPdfs: [], excelsMissingPdf: [], pdfMap: {} };
    }
    if (pdfFiles.length === 0) {
      return { unmatchedPdfs: [], excelsMissingPdf: [], pdfMap: {} };
    }
    const excelBaseNames = new Set(
      excelFiles.map((f) => normalizeKey(stripExtension(f.name))),
    );
    const pdfBaseNames = new Set(
      pdfFiles.map((f) => normalizeKey(stripExtension(f.name))),
    );

    const unmatchedPdfs = pdfFiles
      .filter((f) => !excelBaseNames.has(normalizeKey(stripExtension(f.name))))
      .map((f) => f.name);

    const excelsMissingPdf = excelFiles
      .filter((f) => !pdfBaseNames.has(normalizeKey(stripExtension(f.name))))
      .map((f) => f.name);

    const pdfMap = pdfFiles.reduce((acc, file) => {
      acc[normalizeKey(stripExtension(file.name))] = file;
      return acc;
    }, {});

    return { unmatchedPdfs, excelsMissingPdf, pdfMap };
  }, [excelFiles, pdfFiles, wantsPdfUpload]);

  const validationIssueRows = useMemo(
    () =>
      validationItems.flatMap((item) =>
        (item.issues || []).map((issue) => ({
          ...issue,
          fileName: item.fileName,
        })),
      ),
    [validationItems],
  );
  const reportInfoIssues = useMemo(
    () =>
      validationIssueRows.filter((issue) =>
        String(issue.location || "")
          .toLowerCase()
          .includes("report info"),
      ),
    [validationIssueRows],
  );
  const assetIssues = useMemo(
    () =>
      validationIssueRows.filter(
        (issue) =>
          !String(issue.location || "")
            .toLowerCase()
            .includes("report info"),
      ),
    [validationIssueRows],
  );
  const pdfIssueCount = wantsPdfUpload
    ? pdfMatchInfo.excelsMissingPdf.length + pdfMatchInfo.unmatchedPdfs.length
    : 0;
  const totalValidationIssues = validationIssueRows.length + pdfIssueCount;
  const hasValidationIssues = totalValidationIssues > 0;

  const localizeIssue = useCallback(
    (key, defaultValue, options = {}) =>
      translate(`validation.issues.${key}`, defaultValue, options),
    [translate],
  );

  const runValidation = async (
    excelList,
    pdfMap,
    { keepCurrentStep = false, ensureModalOpen = true } = {},
  ) => {
    if (!excelList.length) {
      resetValidation();
      return;
    }

    setValidating(true);
    setValidationMessage({
      type: "info",
      text: "Reading Excel files and validating...",
    });
    setValidationItems([]);
    setValidationTableTab("assets");
    if (ensureModalOpen) {
      setShowValidationModal(true);
    }
    if (!keepCurrentStep) {
      setValidationModalStep("validation");
    }

    const shouldValidatePdf = wantsPdfUpload && pdfFiles.length > 0;

    const performValidation = async () => {
      const results = [];

      for (const file of excelList) {
        const buffer = await file.arrayBuffer();
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);

        const marketSheet = workbook.getWorksheet("market");
        const costSheet = workbook.getWorksheet("cost");

        const issues = [];
        const addIssue = (field, location, message) =>
          issues.push({ field, location, message });

        if (!marketSheet && !costSheet) {
          addIssue(
            "Workbook",
            "Sheets",
            localizeIssue(
              "missingSheets",
              "Excel must contain at least one of 'market' or 'cost' sheets.",
            ),
          );
          results.push({
            fileName: file.name,
            baseName: normalizeKey(stripExtension(file.name)),
            pdfMatched: false,
            pdfName: "",
            issues,
            snapshot: null,
            totals: null,
            counts: null,
          });
          continue;
        }

        const marketRows = marketSheet ? worksheetToObjects(marketSheet) : [];
        const costRows = costSheet ? worksheetToObjects(costSheet) : [];

        // Validate market sheet
        if (marketSheet) {
          issues.push(
            ...validateRequiredAssetFields("market", marketRows, localizeIssue),
          );
          issues.push(...validateMarketSheet(marketRows, localizeIssue));
        }

        // Validate cost sheet
        if (costSheet) {
          issues.push(
            ...validateRequiredAssetFields("cost", costRows, localizeIssue),
          );
          issues.push(...validateCostSheetIntegers(costRows, localizeIssue));
        }

        const marketAssetCount = marketRows.filter((r) =>
          hasValue(
            r.asset_name || r.assetName || r["asset_name\n"] || r["Asset Name"],
          ),
        ).length;
        const costAssetCount = costRows.filter((r) =>
          hasValue(
            r.asset_name || r.assetName || r["asset_name\n"] || r["Asset Name"],
          ),
        ).length;

        if (marketAssetCount === 0 && costAssetCount === 0) {
          addIssue(
            "Assets",
            "Sheets",
            localizeIssue(
              "noAssetsFound",
              "No assets found in market or cost sheets.",
            ),
          );
        }

        const sumSheet = (rows, sheetName) =>
          rows.reduce((acc, row, idx) => {
            const assetName =
              row.asset_name ||
              row.assetName ||
              row["asset_name\n"] ||
              row["Asset Name"] ||
              "";
            if (!hasValue(assetName)) return acc;
            const rawFinal = pickFieldValue(row, [
              "final_value",
              "final value",
              "value",
              "Final Value",
              "Value",
              "final_value\n",
            ]);
            const num = Number(rawFinal);
            if (Number.isNaN(num)) {
              return acc;
            }
            return acc + num;
          }, 0);

        const marketTotal = sumSheet(marketRows, "market");
        const costTotal = sumSheet(costRows, "cost");
        const assetsTotal = marketTotal + costTotal;

        // Calculate report data (will be auto-generated)
        const number_of_macros = marketAssetCount + costAssetCount;
        const title = `عدد الأصول (${number_of_macros}) + القيمة النهائية (${assetsTotal})`;
        const client_name = `عدد الأصول (${number_of_macros}) + القيمة النهائية (${assetsTotal})`;

        const baseName = normalizeKey(stripExtension(file.name));
        const matchedPdf = shouldValidatePdf
          ? pdfMap[baseName]
          : { name: DUMMY_PDF_NAME };
        if (shouldValidatePdf && !matchedPdf) {
          addIssue(
            "PDF Match",
            "Files",
            localizeIssue(
              "noMatchingPdf",
              `No matching PDF found for Excel ${file.name} (match by filename).`,
              { file: file.name },
            ),
          );
        }

        const pdfMatched = shouldValidatePdf ? Boolean(matchedPdf) : true;
        const pdfName = shouldValidatePdf
          ? matchedPdf?.name || ""
          : DUMMY_PDF_NAME;
        const today = new Date();
        const todayDate = today.toISOString().split("T")[0];

        results.push({
          fileName: file.name,
          baseName,
          pdfMatched,
          pdfName,
          issues,
          snapshot: {
            title,
            client_name,
            purpose_id: "1",
            value_premise_id: "1",
            report_type: "تقرير مفصل",
            telephone: "999999999",
            email: "a@a.com",
            number_of_macros,
            final_value: assetsTotal,
            value: assetsTotal,
            valued_at: todayDate,
            submitted_at: todayDate,
          },
          totals: {
            assetsTotalValue: assetsTotal,
            marketTotal,
            costTotal,
          },
          counts: {
            marketAssets: marketAssetCount,
            costAssets: costAssetCount,
          },
        });
      }

      // Add PDF size validation for all PDFs (check all files in pdfFiles array)
      if (shouldValidatePdf && pdfFiles.length > 0) {
        pdfFiles.forEach((pdfFile) => {
          if (pdfFile.size > MAX_PDF_SIZE) {
            const sizeMB = (pdfFile.size / (1024 * 1024)).toFixed(2);
            const baseName = normalizeKey(stripExtension(pdfFile.name));
            const matchingResult = results.find((r) => r.baseName === baseName);
            if (matchingResult) {
              matchingResult.issues.push({
                field: "PDF Size",
                location: "Files",
                message: localizeIssue(
                  "pdfSizeExceed",
                  `PDF "${pdfFile.name}" exceeds 20 MB limit (${sizeMB} MB).`,
                  { file: pdfFile.name, size: sizeMB },
                ),
              });
            } else if (results.length > 0) {
              // Add to first result if no match found
              results[0].issues.push({
                field: "PDF Size",
                location: "Files",
                message: localizeIssue(
                  "pdfSizeExceed",
                  `PDF "${pdfFile.name}" exceeds 20 MB limit (${sizeMB} MB).`,
                  { file: pdfFile.name, size: sizeMB },
                ),
              });
            }
          }
        });
      }

      return results;
    };

    return performValidation()
      .then((results) => {
        setValidationItems(results);
        syncUploadFormFromValidation(results);

        const totalIssues = results.reduce(
          (acc, r) => acc + (r.issues?.length || 0),
          0,
        );
        const hasPdfMismatch = shouldValidatePdf
          ? pdfMatchInfo.excelsMissingPdf.length ||
            pdfMatchInfo.unmatchedPdfs.length
          : false;
        if (totalIssues === 0 && !hasPdfMismatch) {
          setValidationMessage({
            type: "success",
            text: shouldValidatePdf
              ? translate(
                  "validation.message.validWithPdfs",
                  "All Excel files look valid and PDFs are matched. You can Upload & Create Reports.",
                )
              : translate(
                  "validation.message.validWithoutPdfs",
                  `All Excel files look valid. PDFs will use ${DUMMY_PDF_NAME}. You can Upload & Create Reports.`,
                  { placeholder: DUMMY_PDF_NAME },
                ),
          });
        } else {
          setValidationMessage({
            type: "error",
            text: translate(
              "validation.message.issuesFound",
              "Validation found issues. Fix them to enable Upload & Create Reports.",
            ),
          });
        }
        setValidationTableTab("assets");
        if (ensureModalOpen) {
          setShowValidationModal(true);
        }
        if (keepCurrentStep) {
          setValidationModalStep((prevStep) =>
            prevStep === "edit" ? "edit" : "validation",
          );
        } else {
          setValidationModalStep("validation");
        }
      })
      .catch((err) => {
        console.error("Validation failed", err);
        setValidationMessage({
          type: "error",
          text:
            err?.message ||
            translate(
              "validation.message.validationFailed",
              "Failed to validate Excel files.",
            ),
        });
        if (ensureModalOpen) {
          setShowValidationModal(true);
        }
        if (keepCurrentStep) {
          setValidationModalStep((prevStep) =>
            prevStep === "edit" ? "edit" : "validation",
          );
        } else {
          setValidationModalStep("validation");
        }
      })
      .finally(() => {
        setValidating(false);
      });
  };

  useEffect(() => {
    if (excelFiles.length > 0) {
      const keepCurrentStep =
        showValidationModal && validationModalStep === "edit";
      runValidation(excelFiles, pdfMatchInfo.pdfMap, {
        keepCurrentStep,
        ensureModalOpen: true,
      });
    } else {
      resetValidation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excelFiles, pdfFiles]);

  const isReadyToUpload = useMemo(() => {
    if (excelFiles.length === 0) return false;
    if (wantsPdfUpload && pdfFiles.length === 0) return false;
    if (
      wantsPdfUpload &&
      (pdfMatchInfo.excelsMissingPdf.length ||
        pdfMatchInfo.unmatchedPdfs.length)
    ) {
      return false;
    }
    if (validating) return false;
    if (!validationItems.length) return false;
    const anyIssues = validationItems.some(
      (item) => (item.issues || []).length > 0,
    );
    if (anyIssues) return false;
    return true;
  }, [
    excelFiles.length,
    pdfFiles.length,
    wantsPdfUpload,
    validating,
    validationItems,
    pdfMatchInfo,
  ]);

  const handleUpload = async () => {
    resetMessages();

    if (excelFiles.length === 0) {
      setError(
        translate(
          "messages.error.selectExcelFile",
          "Please select at least one Excel file",
        ),
      );
      return;
    }
    if (wantsPdfUpload && pdfFiles.length === 0) {
      setError(
        translate(
          "messages.error.selectPdfFile",
          "Please select at least one PDF file or disable PDF upload.",
        ),
      );
      return;
    }
    if (
      wantsPdfUpload &&
      (pdfMatchInfo.excelsMissingPdf.length ||
        pdfMatchInfo.unmatchedPdfs.length)
    ) {
      setError(
        translate(
          "messages.error.pdfNamesMismatch",
          "PDF filenames must match the Excel filenames.",
        ),
      );
      return;
    }
    if (!isReadyToUpload) {
      setError(
        translate(
          "messages.error.validationIssues",
          "Please fix validation issues before uploading.",
        ),
      );
      return;
    }

    setStoreOnlyLoading(true);
    try {
      const outcome = await executeWithAuth(
        async (params) => {
          const { token: authToken } = params;

          await ensureQuickUploadActionReady(authToken);

          if (!extractTaqeemUsernameFromUser(user || {})) {
            throw new Error(
              translate(
                "messages.error.taqeemRequiredForUpload",
                "Log in to Taqeem and link your account before uploading reports.",
              ),
            );
          }

          if (!authToken) {
            throw new Error(
              translate(
                "messages.error.noApiToken",
                "No login session. Restart the app or wait for connection.",
              ),
            );
          }
          const activeToken = authToken;

          setSuccess(
            translate(
              "messages.success.uploadingFiles",
              "Uploading files to server...",
            ),
          );

          let pdfPaths = {};
          if (wantsPdfUpload && pdfFiles.length > 0) {
            pdfPaths = await getAbsolutePaths(pdfFiles, false);
          } else {
            pdfPaths = await getAbsolutePaths([], true, excelFiles);
          }

          const data = await submitReportsQuicklyUpload(
            excelFiles,
            wantsPdfUpload ? pdfFiles : [],
            !wantsPdfUpload,
            selectedCompanyOfficeId || null,
            pdfPaths,
          );

          if (data.status !== "success") {
            throw new Error(
              data.error ||
                translate("messages.error.uploadFailed", "Upload failed"),
            );
          }

          const createdReports = Array.isArray(data.reports) ? data.reports : [];
          if (createdReports.length) {
            setReports((prev) => mergeReports(prev, createdReports));
            await applyUploadFormToCreatedReports(createdReports);
          }

          const insertedCount = data.created || 0;
          if (insertedCount > 0) {
            recordUploadBatch(selectedCompanyOfficeId, "quick", {
              inserted: insertedCount,
              nameHint: selectedCompany?.name,
            });
          }
          setSuccess(
            translate(
              "messages.success.filesUploaded",
              "Files uploaded successfully. Inserted {{count}} report(s).",
              { count: insertedCount },
            ),
          );
          await loadReports(activeToken);
          setExcelFiles([]);
          setPdfFiles([]);
          setPdfPathMap({});
          setWantsPdfUpload(false);
          return true;
        },
        { token },
        {
          requiredPoints: 0,
          skipNavigateToCompany: true,
          showInsufficientPointsModal: () => setShowInsufficientPointsModal(true),
          onViewChange,
          onAuthFailure: (reason) => {
            if (reason === "INSUFFICIENT_POINTS") return;
            if (reason === "LOGIN_REQUIRED") {
              setError(
                translate(
                  "messages.error.taqeemLoginRequired",
                  "Taqeem login required. Finish login and choose a company to continue.",
                ),
              );
              return;
            }
            const msg =
              (typeof reason === "object" && reason?.message) ||
              (typeof reason === "string" ? reason : "") ||
              "";
            if (msg) setError(msg);
          },
        },
      );

      if (outcome === null) {
        return;
      }
    } catch (err) {
      console.error("Upload failed", err);
      const status = err?.response?.status;
      const apiError =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Failed to upload files";

      if (status === 400) {
        setError(
          apiError ||
            translate(
              "messages.error.badRequest",
              "Bad request. Please check the selected files and try again.",
            ),
        );
      } else if (status === 500) {
        setError(
          apiError ||
            translate(
              "messages.error.serverProcessing",
              "Server error while processing your files. Please try again or contact support.",
            ),
        );
      } else if (err?.code === "ERR_NETWORK") {
        setError(
          translate(
            "messages.error.network",
            "Network error. Make sure the backend server is running and reachable.",
          ),
        );
      } else {
        setError(apiError);
      }
    } finally {
      setStoreOnlyLoading(false);
    }
  };

  const closeValidationModal = useCallback(() => {
    setShowValidationModal(false);
    setValidationModalStep("validation");
  }, []);

  const openValidationModal = useCallback(() => {
    if (!excelFiles.length) return;
    setValidationModalStep("validation");
    setShowValidationModal(true);
  }, [excelFiles.length]);

  const handleValidationContinue = useCallback(() => {
    setValidationModalStep("edit");
  }, []);

  const executeUploadModalAction = useCallback(
    async (mode) => {
      closeValidationModal();
      if (mode === "now") {
        await handleStoreAndSubmit();
        return;
      }
      await handleUpload();
    },
    [closeValidationModal, handleStoreAndSubmit, handleUpload],
  );

  const resolveTabsForAssets = useCallback(
    (assetCount) => {
      const fallbackTabs = Math.max(1, Number(recommendedTabs) || 3);
      if (!assetCount || assetCount < 1) return fallbackTabs;
      return Math.max(1, Math.min(fallbackTabs, assetCount));
    },
    [recommendedTabs],
  );

  // Pause/Resume/Stop helpers for long-running macro fill processes (per report)
  // These control the browser processes directly via process control system
  const isNoActiveProcessError = (value) =>
    /No active process found for report/i.test(String(value || ""));

  const pauseReportProcess = useCallback(async (recordId) => {
    if (!recordId) {
      setError(
        translate(
          "messages.error.missingReportId",
          "Missing report record id.",
        ),
      );
      return;
    }

    if (!window?.electronAPI?.pauseMacroFill) {
      setError(
        translate(
          "messages.error.desktopIntegration",
          "Desktop integration unavailable. Restart the app.",
        ),
      );
      return;
    }

    try {
      // Optimistically update UI immediately
      setReportProgress((prev) => {
        const current = prev[recordId] || {
          percentage: 0,
          status: "processing",
          message: "",
        };
        return {
          ...prev,
          [recordId]: {
            ...current,
            status: "paused",
            message: current.message || "Pausing...",
          },
        };
      });

      setSuccess(
        translate(
          "messages.success.pausingSubmission",
          "Pausing report submission...",
        ),
      );

      // Pause the macro fill process (which controls the browser)
      const result = await window.electronAPI.pauseMacroFill(recordId);

      if (result?.status === "SUCCESS") {
        // Status is already updated optimistically, real-time listener will confirm
        setSuccess(
          translate(
            "messages.success.reportPaused",
            "Report submission paused.",
          ),
        );
      } else {
        // Revert optimistic update on failure
        setReportProgress((prev) => {
          const current = prev[recordId] || {
            percentage: 0,
            status: "processing",
            message: "",
          };
          return {
            ...prev,
            [recordId]: {
              ...current,
              status: "processing",
            },
          };
        });
        throw new Error(result?.error || "Failed to pause process.");
      }
    } catch (err) {
      if (isNoActiveProcessError(err?.message || err?.error)) {
        setSuccess(
          translate(
            "messages.info.processNotActive",
            "This report process is not active right now (it may have already finished).",
          ),
        );
        return;
      }

      // Revert optimistic update on error
      setReportProgress((prev) => {
        const current = prev[recordId] || {
          percentage: 0,
          status: "processing",
          message: "",
        };
        return {
          ...prev,
          [recordId]: {
            ...current,
            status: "processing",
          },
        };
      });
      setError(
        err?.message ||
          translate("messages.error.pauseProcess", "Failed to pause process."),
      );
    }
  }, []);

  const resumeReportProcess = useCallback(async (recordId) => {
    if (!recordId) {
      setError(
        translate(
          "messages.error.missingReportId",
          "Missing report record id.",
        ),
      );
      return;
    }

    if (!window?.electronAPI?.resumeMacroFill) {
      setError(
        translate(
          "messages.error.desktopIntegration",
          "Desktop integration unavailable. Restart the app.",
        ),
      );
      return;
    }

    try {
      // Optimistically update UI immediately
      setReportProgress((prev) => {
        const current = prev[recordId] || {
          percentage: 0,
          status: "paused",
          message: "",
        };
        return {
          ...prev,
          [recordId]: {
            ...current,
            status: "processing",
            message: current.message || "Resuming...",
          },
        };
      });

      setSuccess(
        translate(
          "messages.success.resumingSubmission",
          "Resuming report submission...",
        ),
      );

      // Resume the macro fill process (which controls the browser)
      const result = await window.electronAPI.resumeMacroFill(recordId);

      if (result?.status === "SUCCESS") {
        // Status is already updated optimistically, real-time listener will confirm
        setSuccess(
          translate(
            "messages.success.reportResumed",
            "Report submission resumed.",
          ),
        );
      } else {
        // Revert optimistic update on failure
        setReportProgress((prev) => {
          const current = prev[recordId] || {
            percentage: 0,
            status: "paused",
            message: "",
          };
          return {
            ...prev,
            [recordId]: {
              ...current,
              status: "paused",
            },
          };
        });
        throw new Error(result?.error || "Failed to resume process.");
      }
    } catch (err) {
      if (isNoActiveProcessError(err?.message || err?.error)) {
        setSuccess(
          translate(
            "messages.info.processNotActive",
            "This report process is not active right now (it may have already finished).",
          ),
        );
        return;
      }

      // Revert optimistic update on error
      setReportProgress((prev) => {
        const current = prev[recordId] || {
          percentage: 0,
          status: "paused",
          message: "",
        };
        return {
          ...prev,
          [recordId]: {
            ...current,
            status: "paused",
          },
        };
      });
      setError(
        err?.message ||
          translate(
            "messages.error.resumeProcess",
            "Failed to resume process.",
          ),
      );
    }
  }, []);

  const stopReportProcess = useCallback(async (recordId) => {
    if (!recordId) {
      setError(
        translate(
          "messages.error.missingReportId",
          "Missing report record id.",
        ),
      );
      return;
    }

    if (!window?.electronAPI?.stopMacroFill) {
      setError(
        translate(
          "messages.error.desktopIntegration",
          "Desktop integration unavailable. Restart the app.",
        ),
      );
      return;
    }

    if (
      !window.confirm(
        translate(
          "confirm.stopSubmission",
          "Are you sure you want to stop this report submission? Progress will be lost.",
        ),
      )
    ) {
      return;
    }

    try {
      setSuccess(
        translate(
          "messages.success.stoppingSubmission",
          "Stopping report submission...",
        ),
      );

      // Stop the macro fill process (which controls the browser)
      const result = await window.electronAPI.stopMacroFill(recordId);

      if (result?.status === "SUCCESS") {
        // Status will be updated via real-time progress listener
        // Preserve current percentage for visibility
        setReportProgress((prev) => ({
          ...prev,
          [recordId]: {
            ...(prev[recordId] || { percentage: 0 }),
            status: "stopped",
            message: "Stopped by user",
          },
        }));
        setSuccess(
          translate(
            "messages.success.reportStopped",
            "Report submission stopped.",
          ),
        );
      } else {
        throw new Error(result?.error || "Failed to stop process.");
      }
    } catch (err) {
      if (isNoActiveProcessError(err?.message || err?.error)) {
        setSuccess(
          translate(
            "messages.info.processNotActive",
            "This report process is not active right now (it may have already finished).",
          ),
        );
        return;
      }

      setError(
        err?.message ||
          translate("messages.error.stopProcess", "Failed to stop process."),
      );
    }
  }, []);

  const ensureCompanySelected = useCallback(
    async (options = {}) => {
      const { forceSelection = false, ignorePreferred = false } = options;

      if (forceSelection && selectedCompany) {
        await setSelectedCompany(null, { skipNavigation: true, quiet: true });
      }
      if (!forceSelection && selectedCompany) return selectedCompany;

      let list = companies;
      try {
        if ((!list || list.length === 0) && ensureCompaniesLoaded) {
          list = await ensureCompaniesLoaded("equipment");
        }
        if ((!list || list.length === 0) && window?.electronAPI?.getCompanies) {
          setCompanyStatus?.(
            "info",
            translate(
              "messages.success.waitingCompanies",
              "Waiting for Taqeem login to finish and load companies...",
            ),
          );
          const fetched = await waitForTaqeemCompanies();
          if (fetched.length > 0 && replaceCompanies) {
            list = await replaceCompanies(fetched, {
              autoSelect: false,
              skipNavigation: true,
              quiet: true,
            });
          }
        }
      } catch (err) {
        console.warn("Failed to fetch companies for submission", err);
      }

      if (!list || list.length === 0) {
        throw new Error(
          "No companies available. Login to Taqeem and try again.",
        );
      }

      if (preferredCompany && !ignorePreferred) {
        const chosen = await setSelectedCompany(preferredCompany, {
          skipNavigation: false,
          quiet: true,
        });
        setCompanyStatus?.("success", `Company: ${chosen?.name || "Selected"}`);
        return chosen;
      }

      if (list.length === 1) {
        const chosen = list[0];
        await setSelectedCompany(chosen, {
          skipNavigation: false,
          quiet: true,
        });
        setCompanyStatus?.("success", `Company: ${chosen.name || "Selected"}`);
        return chosen;
      }

      setCompanyStatus?.("info", "Select a company to continue.");
      setSuccess(
        translate(
          "messages.success.selectCompany",
          "Select a company to continue.",
        ),
      );
      return waitForCompanySelection();
    },
    [
      companies,
      ensureCompaniesLoaded,
      preferredCompany,
      replaceCompanies,
      selectedCompany,
      setCompanyStatus,
      setSelectedCompany,
      setSuccess,
      waitForCompanySelection,
      waitForTaqeemCompanies,
    ],
  );

  const submitToTaqeem = useCallback(
    async (recordId, tabsNum, options = {}) => {
      const {
        withLoading = true,
        resume = false,
        skipAuth = false,
        skipCompanySelect = false,
        assetCountOverride = null,
        batchIdOverride = null,
      } = options;

      if (!recordId) {
        setError(
          translate(
            "messages.error.missingReportId",
            "Missing report record id.",
          ),
        );
        return {
          success: false,
          reason: "INVALID_INPUT",
          error: "Missing report record id.",
        };
      }

      // Use global recommendedTabs if tabsNum not provided, otherwise use the provided value
      const resolvedTabs = tabsNum || Math.max(1, Number(recommendedTabs) || 3);
      const report = reports.find(
        (item) => getReportRecordId(item) === recordId,
      );
      const assetCount = resolveReportAssetCount(report, assetCountOverride);
      let assignedOfficeId = report?.company_office_id
        ? String(report.company_office_id)
        : "";

      // Initialize progress for this report
      setReportProgress((prev) => ({
        ...prev,
        [recordId]: {
          percentage: 0,
          status: "starting",
          message: "Initializing...",
        },
      }));

      setReportActionBusy((prev) => ({ ...prev, [recordId]: true }));

      try {
        let sessionToken = token;
        if (!sessionToken && window?.electronAPI?.getToken) {
          try {
            const tokenObj = await window.electronAPI.getToken();
            sessionToken = tokenObj?.refreshToken || tokenObj?.token || null;
          } catch {
            sessionToken = null;
          }
        }

        let authStatus = true;
        if (!skipAuth) {
          authStatus = await ensureTaqeemAuthorized(
            sessionToken,
            onViewChange,
            isTaqeemLoggedIn,
            assetCount,
            login,
            setTaqeemStatus,
            {
              ...authOptions,
              isGuest: isGuest || !sessionToken,
            },
          );
        }
        if (authStatus?.status === "INSUFFICIENT_POINTS") {
          openInsufficientPointsModal({
            requiredPoints: authStatus.required ?? assetCount,
            availablePoints: authStatus.available,
            assetCount,
            customMessage:
              authStatus.message ||
              authStatus.reason ||
              "You don't have enough points to submit this report.",
          });
          return { success: false, reason: "INSUFFICIENT_POINTS", authStatus };
        }
        if (authStatus?.status === "LOGIN_REQUIRED") {
          const message = translate(
            "messages.error.taqeemLoginRequired",
            "Taqeem login required. Finish login and choose a company to continue.",
          );
          setReportProgress((prev) => ({
            ...prev,
            [recordId]: { percentage: 0, status: "error", message },
          }));
          setError(message);
          return {
            success: false,
            reason: "AUTH_REQUIRED",
            authStatus,
            error: message,
          };
        }
        if (!isTaqeemAuthSuccess(authStatus)) {
          const message = getTaqeemAuthErrorMessage(
            authStatus,
            translate(
              "messages.error.taqeemLoginRequired",
              "Taqeem login required. Finish login and choose a company to continue.",
            ),
          );
          setReportProgress((prev) => ({
            ...prev,
            [recordId]: { percentage: 0, status: "error", message },
          }));
          setError(message);
          return {
            success: false,
            reason: "AUTH_REQUIRED",
            authStatus,
            error: message,
          };
        }

        if (!skipCompanySelect) {
          const requiresManualCompany = !report?.company_office_id;
          const chosen = await ensureCompanySelected({
            forceSelection: requiresManualCompany,
            ignorePreferred: requiresManualCompany,
          });
          const officeId =
            chosen?.officeId || chosen?.office_id || selectedCompanyOfficeId;
          if (requiresManualCompany && officeId) {
            try {
              const nextOfficeId = String(officeId);
              assignedOfficeId = nextOfficeId;
              await updateSubmitReportsQuickly(recordId, {
                company_office_id: nextOfficeId,
              });
              if (report) {
                report.company_office_id = nextOfficeId;
              }
              await loadReports();
            } catch (err) {
              console.warn("Failed to update report company office id", err);
            }
          }
        }

        setSuccess(
          resume
            ? translate(
                "messages.success.resumingTaqeem",
                "Resuming Taqeem submission...",
              )
            : translate(
                "messages.success.submittingTaqeem",
                "Submitting report to Taqeem...",
              ),
        );

        if (!window?.electronAPI?.createReportById) {
          throw new Error("Desktop integration unavailable. Restart the app.");
        }

        const result = await window.electronAPI.createReportById(
          recordId,
          resolvedTabs,
        );

        if (result?.status === "SUCCESS") {
          setReportProgress((prev) => ({
            ...prev,
            [recordId]: {
              percentage: 100,
              status: "completed",
              message: "Report submitted successfully",
            },
          }));
          setSuccess(
            translate(
              "messages.success.reportSubmitted",
              "Report submitted to Taqeem successfully.",
            ),
          );
          const activeToken = authStatus?.token || sessionToken;
          const createdReportId =
            result?.reportId ||
            result?.report_id ||
            report?.report_id ||
            recordId;
          const reportWithCreatedId = {
            ...(report || {}),
            report_id: createdReportId,
          };
          const nextReportStatus = computeQuickReportStatus(reportWithCreatedId);
          if (createdReportId && report) {
            report.report_id = createdReportId;
            report.report_status = nextReportStatus;
          }
          if (createdReportId) {
            try {
              await updateSubmitReportsQuickly(recordId, {
                report_id: createdReportId,
                report_status: nextReportStatus,
                ...(assignedOfficeId
                  ? { company_office_id: assignedOfficeId }
                  : {}),
              });
            } catch (err) {
              console.warn("Failed to update report_id after submission", err);
            }
          }
          try {
            if (assetCount > 0 && activeToken) {
              const reportIds = createdReportId
                ? [createdReportId]
                : [recordId];
              await deductPoints(activeToken, assetCount, {
                reportIds,
                reportId: createdReportId || recordId,
                recordId,
                source: "submit-reports-quickly",
                pageName: QUICK_PAGE_NAME,
                pageSource: QUICK_PAGE_SOURCE,
                assetCount,
                batchId: report?.batch_id || report?.batchId || batchIdOverride,
              });
            }
          } catch (deductErr) {
            console.error(
              "[SubmitReportsQuickly] Failed to deduct points:",
              deductErr,
            );
          }
          await loadReports();
          return {
            success: true,
            reportId: createdReportId || recordId,
            recordId,
          };
        }

        if (result?.status === "STOPPED") {
          const stopMessage =
            result?.message || "Report submission stopped by user.";
          setReportProgress((prev) => ({
            ...prev,
            [recordId]: {
              ...(prev[recordId] || { percentage: 0 }),
              status: "stopped",
              message: stopMessage,
            },
          }));
          setSuccess(stopMessage);
          return {
            success: false,
            reason: "STOPPED",
            stopped: true,
            error: stopMessage,
          };
        }

        const errMsg =
          result?.error ||
          "Upload to Taqeem failed. Make sure you selected a company.";
        setError(errMsg);
        return { success: false, reason: "SUBMIT_FAILED", error: errMsg };
      } catch (err) {
        const errorMessage =
          err?.message ||
          translate(
            "messages.error.submitTaqeem",
            "Failed to submit report to Taqeem.",
          );
        setError(errorMessage);
        return { success: false, reason: "ERROR", error: errorMessage };
      } finally {
        setReportActionBusy((prev) => ({ ...prev, [recordId]: false }));
      }
    },
    [
      authOptions,
      ensureCompanySelected,
      isGuest,
      isTaqeemLoggedIn,
      login,
      loadReports,
      onViewChange,
      reports,
      selectedCompanyOfficeId,
      token,
      recommendedTabs,
      setTaqeemStatus,
      taqeemStatus?.state,
    ],
  );

  const runPendingSubmitQueue = useCallback(
    async (queuePayload, options = {}) => {
      const { resume = false } = options;
      const reportIds = Array.isArray(queuePayload?.reportIds)
        ? queuePayload.reportIds
            .map((id) => String(id || "").trim())
            .filter(Boolean)
        : [];
      const reportMetaById =
        queuePayload?.reportMetaById &&
        typeof queuePayload.reportMetaById === "object"
          ? queuePayload.reportMetaById
          : {};

      if (!reportIds.length) {
        resetPendingSubmit();
        resetReturnView();
        return { success: false, completedCount: 0, total: 0 };
      }

      const resolvedTabs = Math.max(
        1,
        Number(queuePayload?.tabsNum) ||
          Math.max(1, Number(recommendedTabs) || 3),
      );
      const startIndex = Math.max(0, Number(queuePayload?.currentIndex) || 0);
      const basePayload = {
        source: queuePayload?.source || QUICK_PAGE_SOURCE,
        reportIds,
        reportMetaById,
        tabsNum: resolvedTabs,
      };

      let completedCount = 0;
      let paused = false;

      setSubmitting(true);
      try {
        for (let index = startIndex; index < reportIds.length; index += 1) {
          const recordId = reportIds[index];
          const meta = reportMetaById?.[recordId] || {};
          const result = await submitToTaqeem(recordId, resolvedTabs, {
            withLoading: false,
            resume: resume || index > startIndex,
            assetCountOverride: meta?.assetCount,
            batchIdOverride: meta?.batchId,
          });

          if (result?.success) {
            completedCount += 1;
            setPendingSubmit({
              ...basePayload,
              currentIndex: index + 1,
              resumeOnLoad: false,
              updatedAt: Date.now(),
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }

          const reason = String(result?.reason || "").toUpperCase();
          if (reason === "AUTH_REQUIRED") {
            setPendingSubmit({
              ...basePayload,
              currentIndex: index,
              resumeOnLoad: true,
              updatedAt: Date.now(),
            });
            setReturnView(QUICK_PAGE_SOURCE);
            paused = true;
            break;
          }

          if (reason === "STOPPED") {
            setPendingSubmit({
              ...basePayload,
              currentIndex: index,
              resumeOnLoad: false,
              updatedAt: Date.now(),
            });
            paused = true;
            break;
          }
        }

        if (!paused) {
          resetPendingSubmit();
          resetReturnView();
        }

        return {
          success: !paused,
          paused,
          completedCount,
          total: reportIds.length,
        };
      } finally {
        setSubmitting(false);
      }
    },
    [
      recommendedTabs,
      resetPendingSubmit,
      resetReturnView,
      setPendingSubmit,
      setReturnView,
      submitToTaqeem,
    ],
  );

  useEffect(() => {
    if (storeAndSubmitLoading || submitting) return;
    if (!pendingSubmit?.resumeOnLoad) return;
    if (taqeemStatus?.state !== "success") return;

    let cancelled = false;

    const tryResume = async () => {
      let activeToken = token;
      if (!activeToken && window?.electronAPI?.getToken) {
        try {
          const tokenObj = await window.electronAPI.getToken();
          activeToken = tokenObj?.refreshToken || tokenObj?.token || null;
        } catch {
          activeToken = null;
        }
      }
      if (!activeToken || cancelled) return;

      setPendingSubmit((prev) =>
        prev ? { ...prev, resumeOnLoad: false, updatedAt: Date.now() } : prev,
      );
      await runPendingSubmitQueue(pendingSubmit, { resume: true });
    };

    void tryResume();
    return () => {
      cancelled = true;
    };
  }, [
    pendingSubmit,
    runPendingSubmitQueue,
    setPendingSubmit,
    storeAndSubmitLoading,
    submitting,
    taqeemStatus?.state,
    token,
  ]);

  const userId = useMemo(
    () => user?._id || user?.id || user?.userId || user?.user?._id || null,
    [user],
  );

  const getReportByRecordId = useCallback(
    (recordId) =>
      reports.find((report) => getReportRecordId(report) === recordId),
    [reports],
  );

  const handleDeleteReport = async (reportOrId, options = {}) => {
    const { confirm = true } = options;
    const report =
      typeof reportOrId === "string"
        ? getReportByRecordId(reportOrId)
        : reportOrId;
    const recordId = getReportRecordId(report);
    const taqeemReportId = report?.report_id;

    if (!report || !recordId) {
      setError(translate("messages.error.reportNotFound", "Report not found."));
      return;
    }

    if (!taqeemReportId) {
      setError(
        translate(
          "messages.error.reportMustBeSubmitted",
          "Report must be submitted to Taqeem first (must have a report_id).",
        ),
      );
      return;
    }

    if (
      confirm &&
      !window.confirm(
        translate(
          "confirm.deleteReport",
          "Are you sure you want to delete this report?",
        ),
      )
    )
      return;

    setReportActionBusy((prev) => ({ ...prev, [recordId]: true }));

    try {
      if (window?.electronAPI?.checkStatus) {
        const browserStatus = await window.electronAPI.checkStatus();
        if (browserStatus?.browserOpen && browserStatus?.status === "SUCCESS") {
          setTaqeemStatus?.("success", "Taqeem login: On");
        } else {
          setTaqeemStatus?.("info", "Taqeem login: Off");
          setSuccess(
            translate(
              "messages.success.taqeemLoginOff",
              "Taqeem login is off. Complete login in the opened browser window to continue.",
            ),
          );
        }
      }

      await ensureCompanySelected();

      if (!window?.electronAPI?.deleteReport) {
        throw new Error("Desktop integration unavailable. Restart the app.");
      }

      setSuccess(
        translate(
          "messages.success.deletingReport",
          "Deleting report {{reportId}}...",
          { reportId: taqeemReportId },
        ),
      );
      const result = await window.electronAPI.deleteReport(
        taqeemReportId,
        10,
        userId,
      );
      const status = result?.status;

      if (status !== "SUCCESS") {
        throw new Error(
          result?.message || result?.error || "Failed to delete report.",
        );
      }

      const deleteResult = await deleteSubmitReportsQuickly(recordId);
      if (!deleteResult?.success) {
        throw new Error(
          deleteResult?.message ||
            "Report deleted in Taqeem, but failed to remove it locally.",
        );
      }

      setSuccess(
        result?.message ||
          translate(
            "messages.success.reportDeleted",
            "Report deleted successfully.",
          ),
      );
      await loadReports();
    } catch (err) {
      setError(
        err?.message ||
          translate("messages.error.deleteReport", "Failed to delete report."),
      );
    } finally {
      setReportActionBusy((prev) => ({ ...prev, [recordId]: false }));
    }
  };

  const handleEditReport = (report) => {
    const recordId = getReportRecordId(report);
    if (!recordId) return;
    setFormData({
      title: report.title || "",
      client_name: report.client_name || "",
      purpose_id: String(report.purpose_id || "1"),
      value_premise_id: String(report.value_premise_id || "1"),
      report_type: report.report_type || "تقرير مفصل",
      telephone: report.telephone || "999999999",
      email: report.email || "a@a.com",
    });
    setEditingReportId(recordId);
  };

  const handleUpdateReport = async () => {
    if (!editingReportId) return;

    setSubmitting(true);
    try {
      const result = await updateSubmitReportsQuickly(
        editingReportId,
        formData,
      );
      if (result?.success) {
        setSuccess(
          translate(
            "messages.success.reportUpdated",
            "Report updated successfully.",
          ),
        );
        setEditingReportId(null);
        await loadReports();
      } else {
        setError(result?.message || "Failed to update report.");
      }
    } catch (err) {
      setError(
        err?.message ||
          translate("messages.error.updateReport", "Failed to update report."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkAction = async () => {
    if (!bulkAction) return;

    const selectedIds = selectedReportIds.filter(Boolean);
    const selectedReports = selectedIds
      .map((id) => getReportByRecordId(id))
      .filter(Boolean);
    if (selectedIds.length === 0) {
      setError(
        translate(
          "messages.error.selectReport",
          "Please select at least one report.",
        ),
      );
      return;
    }

    if (bulkAction === "delete") {
      const deletableReports = selectedReports.filter((report) =>
        hasTaqeemReportId(report),
      );
      if (deletableReports.length === 0) {
        setError(
          translate(
            "messages.error.submitFirst",
            "You must submit this report to Taqeem first.",
          ),
        );
        return;
      }
      if (
        !window.confirm(
          translate(
            "confirm.deleteMultipleReports",
            "Are you sure you want to delete {{count}} report(s)?",
            { count: deletableReports.length },
          ),
        )
      )
        return;

      for (const report of deletableReports) {
        await handleDeleteReport(report, { confirm: false });
      }
      setSelectedReportIds([]);
      setBulkAction("");
      return;
    }

    if (bulkAction === "upload-submit" || bulkAction === "retry-submit") {
      const actionableReports = selectedReports.filter((report) =>
        bulkAction === "upload-submit"
          ? !hasTaqeemReportId(report)
          : hasTaqeemReportId(report),
      );
      const actionableIds = actionableReports
        .map((report) => getReportRecordId(report))
        .filter(Boolean);

      if (actionableIds.length === 0) {
        setError(
          bulkAction === "upload-submit"
            ? translate(
                "messages.error.submitAlreadyDone",
                "This report is already submitted to Taqeem.",
              )
            : translate(
                "messages.error.submitFirst",
                "You must submit this report to Taqeem first.",
              ),
        );
        return;
      }

      // Ensure login and company selection before any submission/retry
      let bulkSessionToken = token;
      if (!bulkSessionToken && window?.electronAPI?.getToken) {
        try {
          const tokenObj = await window.electronAPI.getToken();
          bulkSessionToken = tokenObj?.refreshToken || tokenObj?.token || null;
        } catch {
          bulkSessionToken = null;
        }
      }
      const authStatus = await ensureTaqeemAuthorized(
        bulkSessionToken,
        onViewChange,
        taqeemStatus?.state === "success",
        0,
        login,
        setTaqeemStatus,
        {
          ...authOptions,
          isGuest: isGuest || !bulkSessionToken,
        },
      );
      if (authStatus?.status === "INSUFFICIENT_POINTS") {
        setError(
          getTaqeemAuthErrorMessage(
            authStatus,
            translate(
              "messages.error.insufficientPoints",
              "You don't have enough points to submit reports.",
            ),
          ),
        );
        return;
      }
      if (
        authStatus?.status === "LOGIN_REQUIRED" ||
        !isTaqeemAuthSuccess(authStatus)
      ) {
        setError(
          getTaqeemAuthErrorMessage(
            authStatus,
            translate(
              "messages.error.taqeemLoginRequired",
              "Taqeem login required. Finish login and choose a company to continue.",
            ),
          ),
          );
        return;
      }
      const requiresManualCompany = actionableReports.some(
        (report) => !report?.company_office_id,
      );
      const chosen = await ensureCompanySelected({
        forceSelection: requiresManualCompany,
        ignorePreferred: requiresManualCompany,
      });
      const officeId =
        chosen?.officeId || chosen?.office_id || selectedCompanyOfficeId;
      if (requiresManualCompany && officeId) {
        try {
          const nextOfficeId = String(officeId);
          await Promise.all(
            actionableReports.map((report) => {
              if (report?.company_office_id) return Promise.resolve();
              const id = getReportRecordId(report);
              if (!id) return Promise.resolve();
              report.company_office_id = nextOfficeId;
              return updateSubmitReportsQuickly(id, {
                company_office_id: nextOfficeId,
              });
            }),
          );
          await loadReports();
        } catch (err) {
          console.warn(
            "Failed to update company office id for bulk reports",
            err,
          );
        }
      }

      // Calculate initial tabs per browser (distribute evenly)
      const totalTabs = Math.max(1, Number(recommendedTabs) || 3);
      const numReports = actionableIds.length;
      const initialTabsPerBrowser = Math.floor(totalTabs / numReports);
      const remainderTabs = totalTabs % numReports;

      // Initialize progress for all reports
      const initialProgress = {};
      actionableIds.forEach((id) => {
        initialProgress[id] = {
          percentage: 0,
          status: "pending",
          message: "Waiting to start...",
        };
      });
      setReportProgress(initialProgress);

      const submissionPromises = [];
      let queueError = null;

      for (let index = 0; index < actionableIds.length; index += 1) {
        const id = actionableIds[index];

        // Calculate tabs for this browser (distribute evenly, remainder goes to first browsers)
        let tabsNum = initialTabsPerBrowser;
        if (index < remainderTabs) {
          tabsNum += 1; // Give remainder tabs to first browsers
        }
        tabsNum = Math.max(1, tabsNum); // Ensure at least 1 tab

        // Update progress to starting
        setReportProgress((prev) => ({
          ...prev,
          [id]: {
            percentage: 0,
            status: "starting",
            message: "Opening browser...",
          },
        }));

        if (bulkAction === "upload-submit") {
          clearReportCreatedCache(id);
          const reportCreatedPromise = waitForReportCreated(id);

          const submissionPromise = submitToTaqeem(id, tabsNum, {
            withLoading: false,
          }).catch((err) => {
            setReportProgress((prev) => ({
              ...prev,
              [id]: {
                percentage: 0,
                status: "error",
                message: err.message || "Submission failed",
              },
            }));
            throw err;
          });
          submissionPromises.push(submissionPromise);

          try {
            await reportCreatedPromise;
          } catch (err) {
            queueError = err;
            setReportProgress((prev) => ({
              ...prev,
              [id]: {
                percentage: 0,
                status: "error",
                message: err.message || "Failed to create report id",
              },
            }));
            break;
          }
        } else if (bulkAction === "retry-submit") {
          const retryPromise = window.electronAPI
            ?.retryCreateReportById?.(id, tabsNum)
            .then((result) => {
              const isSuccess = result?.success || result?.status === "SUCCESS";
              if (!isSuccess) {
                throw new Error(
                  result?.message || result?.error || "Retry failed",
                );
              }
              setReportProgress((prev) => ({
                ...prev,
                [id]: {
                  percentage: 100,
                  status: "completed",
                  message: result?.message || "Retry completed",
                },
              }));
            })
            .catch((err) => {
              setReportProgress((prev) => ({
                ...prev,
                [id]: {
                  percentage: 0,
                  status: "error",
                  message: err.message || "Retry failed",
                },
              }));
              throw err;
            });
          submissionPromises.push(retryPromise);
        }
      }

      await Promise.allSettled(submissionPromises);

      setSelectedReportIds([]);
      setBulkAction("");
      if (queueError) {
        setError(
          queueError.message ||
            translate(
              "messages.error.queueStopped",
              "Stopped queue: report id was not created.",
            ),
        );
      } else {
        setSuccess(
          translate(
            "messages.success.reportsSubmittedStatus",
            "All {{count}} report(s) submitted. Check progress bars for status.",
            { count: actionableIds.length },
          ),
        );
      }
      return;
    }
  };

  const handleReportAction = async (report, action) => {
    const recordId = getReportRecordId(report);
    if (!recordId) return;
    const assetList = report?.asset_data || [];
    const allowedActions = getAllowedRowActions(report);
    if (!allowedActions.includes(action)) {
      setError(
        hasTaqeemReportId(report)
          ? translate(
              "messages.error.submitAlreadyDone",
              "This report is already submitted to Taqeem.",
            )
          : translate(
              "messages.error.submitFirst",
              "You must submit this report to Taqeem first.",
            ),
      );
      return;
    }

    if (action === "submit-taqeem") {
      const assetCount = Array.isArray(assetList) ? assetList.length : 0;
      const tabsNum = resolveTabsForAssets(assetCount);
      try {
        await submitToTaqeem(recordId, tabsNum, { withLoading: false });
      } catch (err) {
        setError(
          err?.message ||
            translate(
              "messages.error.submitTaqeem",
              "Failed to submit report to Taqeem.",
            ),
        );
      }
    } else if (action === "check-status") {
      const taqeemReportId = report.report_id;
      if (!taqeemReportId) {
        setError(
          translate(
            "messages.error.reportNeedsTaqeemId",
            "Report must have a Taqeem report_id to check status.",
          ),
        );
        return;
      }
      const tabsNum = Math.max(1, Number(recommendedTabs) || 1);
      setReportActionBusy((prev) => ({ ...prev, [recordId]: true }));
      try {
        await executeWithAuth(
          async (params) => {
            const { reportId: id, tabsNum: tabs } = params;
            await window.electronAPI?.fullCheck?.(id, tabs);
            setTimeout(() => {
              loadReports();
            }, 1000);
            return { success: true };
          },
          { token, reportId: taqeemReportId, tabsNum },
          {
            requiredPoints: 1,
            showInsufficientPointsModal: () =>
              setShowInsufficientPointsModal(true),
            onViewChange,
            onAuthFailure: (reason) => {
              if (
                reason !== "INSUFFICIENT_POINTS" &&
                reason !== "LOGIN_REQUIRED"
              ) {
                setError(
                  reason?.message ||
                    translate(
                      "messages.error.authFailed",
                      "Authentication failed for full check",
                    ),
                );
              }
            },
          },
        );
      } catch (err) {
        setError(
          err?.message ||
            translate(
              "messages.error.fullCheck",
              "Failed to perform full check",
            ),
        );
      } finally {
        setReportActionBusy((prev) => ({ ...prev, [recordId]: false }));
      }
    } else if (action === "retry") {
      const assetCount = Array.isArray(assetList) ? assetList.length : 0;
      const tabsNum = resolveTabsForAssets(assetCount);
      setReportActionBusy((prev) => ({ ...prev, [recordId]: true }));
      try {
        let retrySessionToken = token;
        if (!retrySessionToken && window?.electronAPI?.getToken) {
          try {
            const tokenObj = await window.electronAPI.getToken();
            retrySessionToken =
              tokenObj?.refreshToken || tokenObj?.token || null;
          } catch {
            retrySessionToken = null;
          }
        }
        const authStatus = await ensureTaqeemAuthorized(
          retrySessionToken,
          onViewChange,
          taqeemStatus?.state === "success",
          0,
          login,
          setTaqeemStatus,
          {
            ...authOptions,
            isGuest: isGuest || !retrySessionToken,
          },
        );
        if (authStatus?.status === "INSUFFICIENT_POINTS") {
          setError(
            getTaqeemAuthErrorMessage(
              authStatus,
              translate(
                "messages.error.insufficientPoints",
                "You don't have enough points to submit reports.",
              ),
            ),
          );
          return;
        }
        if (
          authStatus?.status === "LOGIN_REQUIRED" ||
          !isTaqeemAuthSuccess(authStatus)
        ) {
          setError(
            getTaqeemAuthErrorMessage(
              authStatus,
              translate(
                "messages.error.taqeemLoginRequired",
                "Taqeem login required. Finish login and choose a company to continue.",
              ),
            ),
          );
          return;
        }
        const requiresManualCompany = !report?.company_office_id;
        const chosen = await ensureCompanySelected({
          forceSelection: requiresManualCompany,
          ignorePreferred: requiresManualCompany,
        });
        const officeId =
          chosen?.officeId || chosen?.office_id || selectedCompanyOfficeId;
        const assignedOfficeId = officeId ? String(officeId) : "";
        if (requiresManualCompany && assignedOfficeId) {
          try {
            await updateSubmitReportsQuickly(recordId, {
              company_office_id: assignedOfficeId,
            });
            if (report) {
              report.company_office_id = assignedOfficeId;
            }
            await loadReports();
          } catch (err) {
            console.warn("Failed to update report company office id", err);
          }
        }
        const result = await window.electronAPI?.retryCreateReportById?.(
          recordId,
          tabsNum,
        );
        const isSuccess = result?.success || result?.status === "SUCCESS";
        if (!isSuccess) {
          throw new Error(result?.message || result?.error || "Retry failed");
        }
        const createdReportId =
          result?.reportId || result?.report_id || report?.report_id;
        if (createdReportId) {
          const reportWithCreatedId = {
            ...(report || {}),
            report_id: createdReportId,
          };
          const nextReportStatus = computeQuickReportStatus(reportWithCreatedId);
          try {
            await updateSubmitReportsQuickly(recordId, {
              report_id: createdReportId,
              report_status: nextReportStatus,
              ...(assignedOfficeId
                ? { company_office_id: assignedOfficeId }
                : {}),
            });
            if (report) {
              report.report_id = createdReportId;
              report.report_status = nextReportStatus;
            }
          } catch (err) {
            console.warn("Failed to update report_id after retry", err);
          }
        }
        setSuccess(
          result?.message ||
            translate("messages.success.retryCompleted", "Retry completed."),
        );
        await loadReports();
      } catch (err) {
        setError(
          err?.message ||
            translate(
              "messages.error.retryAssetSubmission",
              "Failed to retry asset submission.",
            ),
        );
      } finally {
        setReportActionBusy((prev) => ({ ...prev, [recordId]: false }));
      }
    } else if (action === "delete") {
      handleDeleteReport(report);
    } else if (action === "edit") {
      handleEditReport(report);
    }
  };

  const toggleReportExpansion = (reportId) => {
    setExpandedReports((prev) =>
      prev.includes(reportId)
        ? prev.filter((id) => id !== reportId)
        : [...prev, reportId],
    );
  };

  const toggleReportSelection = (reportId) => {
    setSelectedReportIds((prev) =>
      prev.includes(reportId)
        ? prev.filter((id) => id !== reportId)
        : [...prev, reportId],
    );
  };

  const filteredReports = useMemo(() => {
    let filtered = reports;
    const selectedOfficeId = normalizeOfficeId(selectedCompanyOfficeId);

    if (selectedOfficeId) {
      filtered = filtered.filter(
        (report) => getReportCompanyOfficeId(report) === selectedOfficeId,
      );
    }

    // Apply status filter
    if (reportSelectFilter !== "all") {
      filtered = filtered.filter(
        (report) => getReportStatus(report) === reportSelectFilter,
      );
    }

    // Apply search filter if there's a search term
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase().trim();
      filtered = filtered.filter((report) => {
        // Search in client_name
        if (
          report.client_name &&
          report.client_name.toLowerCase().includes(term)
        ) {
          return true;
        }
        // Search in report_id
        if (report.report_id && report.report_id.toLowerCase().includes(term)) {
          return true;
        }
        // Search in final_value (convert to string for comparison)
        if (
          report.final_value &&
          String(report.final_value).toLowerCase().includes(term)
        ) {
          return true;
        }
        // Search in title
        if (report.title && report.title.toLowerCase().includes(term)) {
          return true;
        }
        return false;
      });
    }

    return filtered;
  }, [reports, reportSelectFilter, searchTerm, selectedCompanyOfficeId]);

  // Use backend pagination info
  const totalPages = reportsPagination.totalPages || 1;

  useEffect(() => {
    if (currentPage > 0) {
      loadReports();
    }
  }, [currentPage]);

  const handlePageChange = useCallback(
    (newPage) => {
      if (
        newPage >= 1 &&
        newPage <= reportsPagination.totalPages &&
        !reportsLoading
      ) {
        setCurrentPage(newPage);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [reportsPagination.totalPages, reportsLoading],
  );

  const selectedReportSet = useMemo(
    () => new Set(selectedReportIds),
    [selectedReportIds],
  );
  const filteredReportIds = useMemo(
    () => filteredReports.map(getReportRecordId).filter(Boolean),
    [filteredReports],
  );
  const allFilteredSelected =
    filteredReportIds.length > 0 &&
    filteredReportIds.every((id) => selectedReportSet.has(id));

  const handleToggleSelectAll = () => {
    setSelectedReportIds((prev) => {
      if (filteredReportIds.length === 0) return prev;
      const next = new Set(prev);
      const allSelected = filteredReportIds.every((id) => next.has(id));

      if (allSelected) {
        filteredReportIds.forEach((id) => next.delete(id));
      } else {
        filteredReportIds.forEach((id) => next.add(id));
      }

      return Array.from(next);
    });
  };

  return (
    <div className="relative p-2 space-y-2 page-animate overflow-x-hidden">
      {showInsufficientPointsModal && (
        <div className="fixed inset-0 z-[9999]">
          <div className="absolute top-20 left-1/2 transform -translate-x-1/2 w-full max-w-sm">
            <InsufficientPointsModal
              viewChange={onViewChange}
              onClose={closeInsufficientPointsModal}
              details={insufficientPointsMeta}
            />
          </div>
        </div>
      )}
      <DeductionNotification
        source="submit-reports-quickly"
        defaultPageName={QUICK_PAGE_NAME}
        defaultPageSource={QUICK_PAGE_SOURCE}
        onViewChange={onViewChange}
      />
      <div className="space-y-1.5">
        <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-blue-50/25 shadow-[0_12px_32px_rgba(15,23,42,0.1)] p-2.5">
          <div className="pointer-events-none absolute -top-12 -left-12 h-28 w-28 rounded-full bg-blue-200/20 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-14 -right-10 h-32 w-32 rounded-full bg-emerald-200/20 blur-2xl" />
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-stretch gap-1.5"
            style={{ direction: isArabicUi ? "rtl" : "ltr" }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-blue-200 bg-blue-50 px-1.5 text-[9px] font-semibold text-blue-700 whitespace-nowrap">
                {translate("workflow.step1UploadExcel", "Step 1: Upload Excel")}
              </span>
              <label
                className={`group relative flex min-h-[44px] flex-1 items-center gap-2 rounded-xl border border-slate-300/90 bg-white/90 px-2 py-1.5 shadow-sm transition-all hover:-translate-y-[1px] hover:border-blue-400 hover:bg-blue-50/70 cursor-pointer ${
                  isArabicUi ? "text-right" : "text-left"
                }`}
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 ring-1 ring-blue-200/70">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-blue-700" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] font-semibold text-slate-800">
                    {excelFiles.length ? (
                      excelFiles.length === 1 ? (
                        <span title={excelFiles[0].name}>
                          {excelFiles[0].name}
                        </span>
                      ) : (
                        translate(
                          "filePicker.selectedFiles",
                          "{{count}} file(s) selected",
                          { count: excelFiles.length },
                        )
                      )
                    ) : (
                      translate("filePicker.chooseExcel", "Choose Excel file")
                    )}
                  </span>
                  <span className="block text-[8px] font-medium text-slate-500">
                    .xlsx / .xls
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center rounded-md bg-blue-600 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow-sm transition-colors group-hover:bg-blue-700">
                  {translate("filePicker.browse", "Browse")}
                </span>
                <input
                  ref={excelInputRef}
                  type="file"
                  multiple
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={handleExcelChange}
                  onClick={(e) => {
                    e.currentTarget.value = null;
                  }}
                />
              </label>
            </div>
            <input
              ref={pdfInputRef}
              type="file"
              multiple
              accept=".pdf"
              className="hidden"
              onChange={handlePdfChange}
            />
            <button
              type="button"
              onClick={openValidationModal}
              disabled={!excelFiles.length}
              className="inline-flex min-h-[44px] min-w-[120px] w-auto items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-slate-900 px-2 text-[10px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Table className="h-3.5 w-3.5" />
              {translate("workflow.openValidationModal", "Open Validation Modal")}
            </button>
            <button
              type="button"
              onClick={() => {
                setExcelFiles([]);
                setPdfFiles([]);
                setWantsPdfUpload(false);
                resetValidation();
                resetMessages();
                if (excelInputRef?.current) {
                  excelInputRef.current.value = null;
                }
                if (pdfInputRef?.current) {
                  pdfInputRef.current.value = null;
                }
              }}
              className="group inline-flex min-h-[44px] min-w-[94px] w-auto items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-2 text-[10px] font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-[1px] hover:border-slate-400 hover:bg-slate-50"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 text-slate-600 ring-1 ring-slate-200 transition-colors group-hover:bg-slate-200">
                <RefreshCw className="h-3 w-3" />
              </span>
              {translate("filePicker.reset", "Reset")}
            </button>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              disabled={downloadingTemplate}
              title={translate(
                "filePicker.exportTemplate",
                "Export Excel Template",
              )}
              aria-label={translate(
                "filePicker.exportTemplate",
                "Export Excel Template",
              )}
              className="group inline-flex min-h-[44px] min-w-[122px] w-auto items-center justify-center gap-1.5 rounded-xl border border-emerald-300/90 bg-gradient-to-br from-white via-emerald-50 to-emerald-100 px-2 text-emerald-800 shadow-sm transition-all hover:-translate-y-[1px] hover:from-emerald-50 hover:to-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloadingTemplate ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-700" />
              ) : (
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/80 ring-1 ring-emerald-200/90">
                  <img
                    src={excelIconSrc}
                    alt="Excel icon"
                    onError={() => setExcelIconSrc(excelIconFallback)}
                    className="h-3.5 w-3.5 pointer-events-none object-contain"
                  />
                </span>
              )}
              <span className="text-[10px] font-semibold leading-tight">
                {translate(
                  "filePicker.exportTemplate",
                  "Export Excel Template",
                )}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Status Messages */}
      {(error || success) && (
        <div
          className={`rounded-lg border px-2.5 py-1.5 flex items-start gap-2 shadow-sm card-animate ${
            error
              ? "bg-rose-50 text-rose-700 border-rose-300"
              : "bg-emerald-50 text-emerald-700 border-emerald-300"
          }`}
        >
          {error ? (
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
          )}
          <div className="text-xs font-medium">{error || success}</div>
        </div>
      )}

      <div className="mb-2 w-full overflow-hidden rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="w-full" dir={isArabicUi ? "rtl" : "ltr"}>
          <div className="flex w-full flex-wrap items-center gap-1.5 text-[11px] md:flex-nowrap">
            <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-700">
              {translate("reports.title", "Reports")}
            </span>

            <select
              value={bulkAction}
              onChange={(e) => setBulkAction(e.target.value)}
              className="h-7 w-40 rounded-md border border-slate-300 bg-white px-2 text-[11px] font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 cursor-pointer truncate"
            >
              <option value="">
                {translate("reports.bulkActions", "Bulk Actions")}
              </option>
              <option value="upload-submit">
                {translate("reports.bulk.uploadAndSubmit", "Submit to Taqeem")}
              </option>
              <option value="delete">
                {translate("reports.bulk.delete", "Delete")}
              </option>
            </select>

            <button
              type="button"
              onClick={handleBulkAction}
              disabled={!bulkAction || selectedReportIds.length === 0}
              className="h-7 rounded-md bg-cyan-600 px-2.5 text-[11px] font-semibold text-white hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {translate("reports.goButton", "Go")}
            </button>

            <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700">
              {translate("reports.filter.label", "Filter:")}
              <select
                value={reportSelectFilter}
                onChange={(e) => {
                  setReportSelectFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="h-6 rounded-md border border-slate-300 bg-white px-2 text-[11px] font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 cursor-pointer"
              >
                <option value="all">
                  {translate("reports.filter.all", "All statuses")}
                </option>
                <option value="new">
                  {translate("reports.filter.new", "New")}
                </option>
                <option value="incomplete">
                  {translate("reports.filter.incomplete", "Incomplete")}
                </option>
                <option value="complete">
                  {translate("reports.filter.complete", "Complete")}
                </option>
                <option value="sent">
                  {translate("reports.filter.sent", "Sent")}
                </option>
                <option value="confirmed">
                  {translate("reports.filter.confirmed", "Confirmed")}
                </option>
              </select>
            </label>

            <div className="relative min-w-[240px] flex-1">
              <input
                type="text"
                placeholder={translate(
                  "reports.searchPlaceholder",
                  "Search by client, report ID, or value...",
                )}
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                className={`h-7 w-full rounded-md border border-slate-300 bg-white text-[11px] text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 ${
                  isArabicUi ? "pr-8 pl-7 text-right" : "pl-8 pr-7 text-left"
                }`}
              />
              <div
                className={`absolute top-1/2 -translate-y-1/2 ${
                  isArabicUi ? "right-2" : "left-2"
                }`}
              >
                <svg
                  className="w-3 h-3 text-slate-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  ></path>
                </svg>
              </div>
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm("")}
                  className={`absolute top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 ${
                    isArabicUi ? "left-2" : "right-2"
                  }`}
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M6 18L18 6M6 6l12 12"
                    ></path>
                  </svg>
                </button>
              )}
            </div>

            <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700">
              {translate("reports.itemsPerPageLabel", "Items per page:")}
              <select
                value={itemsPerPage}
                onChange={(e) => {
                  setItemsPerPage(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="h-6 rounded-md border border-slate-300 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 cursor-pointer"
              >
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </label>

            <span className="inline-flex h-7 items-center rounded-md border border-blue-200 bg-blue-50 px-2 text-[11px] font-semibold text-blue-700">
              {translate("reports.totalCount", "Total: {{count}} report(s)", {
                count: filteredReports.length,
              })}
            </span>

            {filteredReports.length > 0 && (
              <button
                type="button"
                onClick={handleToggleSelectAll}
                className="inline-flex h-7 items-center rounded-md border border-cyan-200 bg-cyan-50 px-2 text-[11px] font-semibold text-cyan-700 hover:border-cyan-300 hover:bg-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/30"
              >
                {allFilteredSelected
                  ? translate("reports.clearAll", "Clear all")
                  : translate("reports.selectAll", "Select all")}
              </button>
            )}
          </div>
        </div>

        {reportsLoading && reports.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-slate-600 py-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            {translate("reports.loading", "Loading reports...")}
          </div>
        )}

        {!reportsLoading && !reports.length && (
          <div className="text-xs text-slate-600 py-2 text-center">
            {translate(
              "reports.empty",
              "No reports found. Upload Excel files to create reports.",
            )}
          </div>
        )}

        {!reportsLoading && reports.length > 0 && !filteredReports.length && (
          <div className="text-xs text-slate-600 py-2 text-center">
            {translate(
              "reports.noMatch",
              "No reports match the selected filters.",
            )}
          </div>
        )}

        {filteredReports.length > 0 && (
          <>
            <div className="w-full overflow-x-auto">
              <div className="min-w-full" dir={isArabicUi ? "rtl" : "ltr"}>
                <table className="w-full min-w-[980px] table-fixed text-xs text-slate-700">
                  <colgroup>
                    <col className="w-12" />
                    <col className="w-10" />
                    <col className="w-36" />
                    <col />
                    <col className="w-28" />
                    <col className="w-36" />
                    <col className="w-64" />
                    <col className="w-20" />
                  </colgroup>
                  <thead className="bg-gradient-to-r from-blue-50 to-indigo-50 text-slate-800 border-b-2 border-blue-200">
                    <tr>
                      <th className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider">
                        {translate("reports.table.index", "#")}
                      </th>
                      <th className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider"></th>
                      <th
                        className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider ${
                          isArabicUi ? "text-right" : "text-left"
                        }`}
                      >
                        {translate("reports.table.reportId", "Report ID")}
                      </th>
                      <th
                        className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider ${
                          isArabicUi ? "text-right" : "text-left"
                        }`}
                      >
                        {translate("reports.table.client", "Client")}
                      </th>
                      <th
                        className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider ${
                          isArabicUi ? "text-right" : "text-left"
                        }`}
                      >
                        {translate("reports.table.finalValue", "Final value")}
                      </th>
                      <th
                        className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider ${
                          isArabicUi ? "text-right" : "text-left"
                        }`}
                      >
                        {translate("reports.table.status", "Status")}
                      </th>
                      <th
                        className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider ${
                          isArabicUi ? "text-right" : "text-left"
                        }`}
                      >
                        {translate("reports.table.action", "Action")}
                      </th>
                      <th className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider">
                        {translate("reports.table.select", "Select")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReports.map((report, idx) => {
                      const recordId = getReportRecordId(report);
                      const statusKey = getReportStatus(report);
                      const assetList = Array.isArray(report.asset_data)
                        ? report.asset_data
                        : [];
                      const rawStatusLabel =
                        reportStatusLabels[statusKey] || statusKey;
                      const localizedStatusLabel = translate(
                        `reports.status.${statusKey}`,
                        rawStatusLabel,
                      );
                      const isExpanded = recordId
                        ? expandedReports.includes(recordId)
                        : false;
                      const reportBusy = recordId
                        ? reportActionBusy[recordId]
                        : null;
                      const allowedActions = getAllowedRowActions(report);
                      const selectedAction = actionDropdown[recordId] || "";
                      const normalizedSelectedAction =
                        allowedActions.includes(selectedAction)
                          ? selectedAction
                          : "";

                      return (
                        <React.Fragment key={recordId || `report-${idx}`}>
                          <tr className="border-t border-slate-200 bg-white hover:bg-blue-50/30 transition-colors">
                            <td className="px-2 py-2 text-center text-slate-600 text-xs font-medium">
                              {idx + 1}
                            </td>
                            <td className="px-2 py-2 text-center">
                              <button
                                type="button"
                                onClick={() =>
                                  recordId && toggleReportExpansion(recordId)
                                }
                                disabled={!recordId}
                                className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-slate-300 text-slate-700 hover:bg-blue-50 hover:border-blue-400 disabled:opacity-50 transition-colors"
                                aria-label={
                                  isExpanded
                                    ? translate(
                                        "reports.actions.hideAssets",
                                        "Hide assets",
                                      )
                                    : translate(
                                        "reports.actions.showAssets",
                                        "Show assets",
                                      )
                                }
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </td>
                            <td
                              className={`px-2 py-2 ${
                                isArabicUi ? "text-right" : "text-left"
                              }`}
                            >
                              <div
                                className="text-xs font-semibold text-slate-900 truncate"
                                title={
                                  report.report_id ||
                                  translate(
                                    "reports.notSubmitted",
                                    "Not submit",
                                  )
                                }
                              >
                                {report.report_id ||
                                  translate(
                                    "reports.notSubmitted",
                                    "Not submit",
                                  )}
                              </div>
                            </td>
                            <td
                              className={`px-2 py-2 truncate ${
                                isArabicUi ? "text-right" : "text-left"
                              }`}
                              title={report.client_name || "-"}
                            >
                              <span className="text-xs text-slate-700">
                                {report.client_name || "-"}
                              </span>
                            </td>
                            <td
                              className={`px-2 py-2 text-xs font-medium text-slate-700 ${
                                isArabicUi ? "text-right" : "text-left"
                              }`}
                            >
                              {report.final_value || "-"}
                            </td>
                            <td
                              className={`px-2 py-2 ${
                                isArabicUi ? "text-right" : "text-left"
                              }`}
                            >
                              <div className="flex flex-col gap-1">
                                <span
                                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                                    reportStatusClasses[statusKey] ||
                                    "border-blue-200 bg-blue-50 text-blue-700"
                                  }`}
                                >
                                  {localizedStatusLabel}
                                </span>
                                {reportProgress[recordId] && (
                                  <div className="w-full space-y-1">
                                    <div className="flex items-center justify-between mb-0.5">
                                      <span className="text-[9px] text-slate-600 font-medium">
                                        {Math.round(
                                          reportProgress[recordId].percentage,
                                        )}
                                        %
                                      </span>
                                      <span
                                        className="text-[9px] text-slate-500 truncate max-w-[120px]"
                                        title={reportProgress[recordId].message}
                                      >
                                        {reportProgress[recordId].message}
                                      </span>
                                    </div>
                                    <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                                      <div
                                        className={`h-full transition-all duration-300 ${
                                          reportProgress[recordId].status ===
                                          "error"
                                            ? "bg-red-500"
                                            : reportProgress[recordId]
                                                  .status === "paused"
                                              ? "bg-yellow-500"
                                              : reportProgress[recordId]
                                                    .status === "stopped"
                                                ? "bg-slate-500"
                                                : "bg-blue-600"
                                        }`}
                                        style={{
                                          width: `${Math.min(100, Math.max(0, reportProgress[recordId].percentage))}%`,
                                        }}
                                      />
                                    </div>
                                    <div className="flex items-center gap-1">
                                      {(() => {
                                        const currentStatus =
                                          reportProgress[recordId]?.status;
                                        const isProcessing =
                                          currentStatus === "processing" ||
                                          currentStatus === "starting";
                                        const isPaused =
                                          currentStatus === "paused";
                                        const canStop = [
                                          "processing",
                                          "starting",
                                          "paused",
                                        ].includes(currentStatus);

                                        return (
                                          <>
                                            {isProcessing && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  pauseReportProcess(recordId)
                                                }
                                                className="rounded-md border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800 shadow-sm transition-colors hover:bg-amber-200"
                                              >
                                                Pause
                                              </button>
                                            )}
                                            {isPaused && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  resumeReportProcess(recordId)
                                                }
                                                className="rounded-md border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-800 shadow-sm transition-colors hover:bg-emerald-200"
                                              >
                                                Resume
                                              </button>
                                            )}
                                            {canStop && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  stopReportProcess(recordId)
                                                }
                                                className="rounded-md border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold text-rose-800 shadow-sm transition-colors hover:bg-rose-200"
                                              >
                                                Stop
                                              </button>
                                            )}
                                          </>
                                        );
                                      })()}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </td>
                            <td
                              className={`px-2 py-2 ${
                                isArabicUi ? "text-right" : "text-left"
                              }`}
                            >
                              <div className="flex flex-col gap-1">
                                <div className="flex min-w-0 items-center gap-1">
                                  <select
                                    value={normalizedSelectedAction}
                                    disabled={
                                      !recordId || submitting || !!reportBusy
                                    }
                                    onChange={(e) => {
                                      const action = e.target.value;
                                      setActionDropdown((prev) => ({
                                        ...prev,
                                        [recordId]: action,
                                      }));
                                    }}
                                    className={`min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[10px] hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 cursor-pointer ${
                                      normalizedSelectedAction
                                        ? "font-bold text-black"
                                        : "font-medium text-slate-500"
                                    }`}
                                  >
                                    <option value="" className="font-medium text-slate-500">
                                      {translate(
                                        "reports.row.actions",
                                        "Actions",
                                      )}
                                    </option>
                                    <option
                                      value="submit-taqeem"
                                      disabled={
                                        !allowedActions.includes("submit-taqeem")
                                      }
                                      className={
                                        allowedActions.includes("submit-taqeem")
                                          ? "font-bold text-black"
                                          : "font-medium text-slate-400"
                                      }
                                    >
                                      {translate(
                                        "reports.row.submitToTaqeem",
                                        "Submit to Taqeem",
                                      )}
                                      {!allowedActions.includes("submit-taqeem")
                                        ? ` (${translate("reports.row.unavailable", "Unavailable now")})`
                                        : ""}
                                    </option>
                                    <option
                                      value="check-status"
                                      disabled={
                                        !allowedActions.includes("check-status")
                                      }
                                      className={
                                        allowedActions.includes("check-status")
                                          ? "font-bold text-black"
                                          : "font-medium text-slate-400"
                                      }
                                    >
                                      {translate(
                                        "reports.row.checkStatus",
                                        "Check status",
                                      )}
                                      {!allowedActions.includes("check-status")
                                        ? ` (${translate("reports.row.unavailable", "Unavailable now")})`
                                        : ""}
                                    </option>
                                    <option
                                      value="retry"
                                      disabled={!allowedActions.includes("retry")}
                                      className={
                                        allowedActions.includes("retry")
                                          ? "font-bold text-black"
                                          : "font-medium text-slate-400"
                                      }
                                    >
                                      {translate(
                                        "reports.row.retryIncomplete",
                                        "retry incomplete assets",
                                      )}
                                      {!allowedActions.includes("retry")
                                        ? ` (${translate("reports.row.unavailable", "Unavailable now")})`
                                        : ""}
                                    </option>
                                    <option
                                      value="delete"
                                      disabled={!allowedActions.includes("delete")}
                                      className={
                                        allowedActions.includes("delete")
                                          ? "font-bold text-black"
                                          : "font-medium text-slate-400"
                                      }
                                    >
                                      {translate(
                                        "reports.row.delete",
                                        "Delete",
                                      )}
                                      {!allowedActions.includes("delete")
                                        ? ` (${translate("reports.row.unavailable", "Unavailable now")})`
                                        : ""}
                                    </option>
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const action = normalizedSelectedAction;
                                      if (action) {
                                        handleReportAction(report, action);
                                        setActionDropdown((prev) => {
                                          const next = { ...prev };
                                          delete next[recordId];
                                          return next;
                                        });
                                      }
                                    }}
                                    disabled={
                                      !recordId ||
                                      submitting ||
                                      !!reportBusy ||
                                      !normalizedSelectedAction
                                    }
                                    className="shrink-0 rounded-md bg-cyan-600 px-2 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {translate("reports.row.go", "Go")}
                                  </button>
                                </div>
                              </div>
                              {reportBusy && (
                                <div className="text-[10px] text-blue-600 mt-0.5 font-medium">
                                  {translate(
                                    "reports.row.working",
                                    "Working...",
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-2 text-center">
                              <div className="flex items-center justify-center">
                                <label
                                  className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                                    recordId
                                      ? "cursor-pointer border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50"
                                      : "cursor-not-allowed border-slate-200 bg-slate-100"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    disabled={!recordId}
                                    checked={
                                      !!recordId &&
                                      selectedReportSet.has(recordId)
                                    }
                                    onChange={() =>
                                      recordId &&
                                      toggleReportSelection(recordId)
                                    }
                                    className="h-4 w-4 rounded border-slate-300 text-blue-600 accent-blue-600 focus:ring-2 focus:ring-blue-500/40 focus:ring-offset-0 disabled:cursor-not-allowed"
                                  />
                                </label>
                              </div>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td
                                colSpan={8}
                                className="bg-blue-50/20 border-t border-blue-200"
                              >
                                <div className="p-2 space-y-2">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div
                                      className={`text-xs text-slate-700 font-medium ${
                                        isArabicUi ? "text-right" : "text-left"
                                      }`}
                                    >
                                      {translate(
                                        "reports.assets.label",
                                        "Assets",
                                      )}
                                      :{" "}
                                      <span className="text-blue-600 font-semibold">
                                        {assetList.length}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="rounded-md border border-slate-200 overflow-hidden bg-white shadow-sm">
                                    <div className="max-h-48 overflow-y-auto">
                                      <table
                                        className="w-full table-fixed text-xs text-slate-700"
                                        dir={isArabicUi ? "rtl" : "ltr"}
                                      >
                                        <colgroup>
                                          <col className="w-36" />
                                          <col />
                                          <col className="w-28" />
                                          <col className="w-24" />
                                          <col className="w-28" />
                                        </colgroup>
                                        <thead className="bg-slate-50 text-slate-800 border-b border-slate-200 sticky top-0">
                                          <tr>
                                            <th
                                              className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                                isArabicUi
                                                  ? "text-right"
                                                  : "text-left"
                                              }`}
                                            >
                                              {translate(
                                                "reports.assets.table.macroId",
                                                "Macro ID",
                                              )}
                                            </th>
                                            <th
                                              className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                                isArabicUi
                                                  ? "text-right"
                                                  : "text-left"
                                              }`}
                                            >
                                              {translate(
                                                "reports.assets.table.assetName",
                                                "Asset name",
                                              )}
                                            </th>
                                            <th
                                              className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                                isArabicUi
                                                  ? "text-right"
                                                  : "text-left"
                                              }`}
                                            >
                                              {translate(
                                                "reports.assets.table.finalValue",
                                                "Final value",
                                              )}
                                            </th>
                                            <th
                                              className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                                isArabicUi
                                                  ? "text-right"
                                                  : "text-left"
                                              }`}
                                            >
                                              {translate(
                                                "reports.assets.table.sheet",
                                                "Sheet",
                                              )}
                                            </th>
                                            <th
                                              className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                                isArabicUi
                                                  ? "text-right"
                                                  : "text-left"
                                              }`}
                                            >
                                              {translate(
                                                "reports.assets.table.status",
                                                "Status",
                                              )}
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {assetList.length === 0 ? (
                                            <tr>
                                              <td
                                                colSpan={5}
                                                className="px-2 py-2 text-center text-slate-500 text-xs"
                                              >
                                                {translate(
                                                  "reports.assets.none",
                                                  "No assets available for this report.",
                                                )}
                                              </td>
                                            </tr>
                                          ) : (
                                            assetList.map((asset, assetIdx) => {
                                              const assetStatus =
                                                isAssetComplete(asset)
                                                  ? "complete"
                                                  : "incomplete";
                                              const statusLabel =
                                                assetStatus === "complete"
                                                  ? "Complete"
                                                  : "Incomplete";
                                              const localizedAssetStatusLabel =
                                                translate(
                                                  `reports.assetStatus.${assetStatus}`,
                                                  statusLabel,
                                                );
                                              const statusClass =
                                                assetStatus === "complete"
                                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                                  : "border-amber-200 bg-amber-50 text-amber-700";

                                              return (
                                                <tr
                                                  key={`${recordId}-${assetIdx}`}
                                                  className="border-t border-slate-200 hover:bg-slate-50/50"
                                                >
                                                  <td
                                                    className={`px-2 py-1.5 text-slate-700 text-xs font-mono ${
                                                      isArabicUi
                                                        ? "text-right"
                                                        : "text-left"
                                                    }`}
                                                  >
                                                    {asset.id ||
                                                      asset.macro_id ||
                                                      "-"}
                                                  </td>
                                                  <td
                                                    className={`px-2 py-1.5 text-slate-700 text-xs font-medium ${
                                                      isArabicUi
                                                        ? "text-right"
                                                        : "text-left"
                                                    }`}
                                                  >
                                                    {asset.asset_name || "-"}
                                                  </td>
                                                  <td
                                                    className={`px-2 py-1.5 text-slate-700 text-xs ${
                                                      isArabicUi
                                                        ? "text-right"
                                                        : "text-left"
                                                    }`}
                                                  >
                                                    {asset.final_value || "-"}
                                                  </td>
                                                  <td
                                                    className={`px-2 py-1.5 text-slate-600 text-xs ${
                                                      isArabicUi
                                                        ? "text-right"
                                                        : "text-left"
                                                    }`}
                                                  >
                                                    {asset.source_sheet || "-"}
                                                  </td>
                                                  <td
                                                    className={`px-2 py-1.5 ${
                                                      isArabicUi
                                                        ? "text-right"
                                                        : "text-left"
                                                    }`}
                                                  >
                                                    <span
                                                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold ${statusClass}`}
                                                    >
                                                      {
                                                        localizedAssetStatusLabel
                                                      }
                                                    </span>
                                                  </td>
                                                </tr>
                                              );
                                            })
                                          )}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 &&
              (() => {
                const getPageNumbers = () => {
                  const pages = [];

                  if (totalPages <= 6) {
                    // Show all pages if 6 or fewer
                    for (let i = 1; i <= totalPages; i++) {
                      pages.push(i);
                    }
                    return pages;
                  }

                  // Always show first 3 pages
                  pages.push(1, 2, 3);

                  const lastThree = [
                    totalPages - 2,
                    totalPages - 1,
                    totalPages,
                  ];
                  const lastThreeStart = totalPages - 2;

                  // If current page is in first 3 or overlaps with last 3
                  if (currentPage <= 3) {
                    // Show: 1, 2, 3, 4, 5, ..., last 3
                    if (4 < lastThreeStart) {
                      pages.push(4, 5);
                      pages.push("ellipsis");
                    }
                  } else if (currentPage >= lastThreeStart) {
                    // Show: 1, 2, 3, ..., last 3
                    if (3 < lastThreeStart - 1) {
                      pages.push("ellipsis");
                    }
                  } else {
                    // In the middle: show 1, 2, 3, ..., current-1, current, current+1, ..., last 3
                    const showBefore = currentPage - 1;
                    const showAfter = currentPage + 1;

                    // Check if we need ellipsis before current page
                    if (showBefore > 4) {
                      pages.push("ellipsis");
                      pages.push(showBefore);
                    } else if (showBefore > 3) {
                      pages.push(showBefore);
                    }

                    pages.push(currentPage);

                    // Check if we need ellipsis after current page
                    if (showAfter < lastThreeStart - 1) {
                      pages.push(showAfter);
                      if (showAfter < lastThreeStart - 2) {
                        pages.push("ellipsis");
                      }
                    }
                  }

                  // Always show last 3 pages (avoid duplicates)
                  lastThree.forEach((page) => {
                    if (!pages.includes(page)) {
                      pages.push(page);
                    }
                  });

                  // Clean up and ensure proper order
                  const cleaned = [];
                  let prevNum = 0;

                  for (let i = 0; i < pages.length; i++) {
                    const item = pages[i];
                    if (item === "ellipsis") {
                      if (cleaned[cleaned.length - 1] !== "ellipsis") {
                        cleaned.push("ellipsis");
                      }
                    } else if (typeof item === "number") {
                      if (item > prevNum) {
                        if (
                          item > prevNum + 1 &&
                          prevNum > 0 &&
                          cleaned[cleaned.length - 1] !== "ellipsis"
                        ) {
                          cleaned.push("ellipsis");
                        }
                        cleaned.push(item);
                        prevNum = item;
                      }
                    }
                  }

                  return cleaned;
                };

                const pageNumbers = getPageNumbers();

                return (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2">
                    <div className="text-xs text-slate-600 font-medium">
                      {translate(
                        "reports.pagination.summary",
                        "Showing {{from}} to {{to}} of {{total}} reports",
                        {
                          from: (currentPage - 1) * itemsPerPage + 1,
                          to: Math.min(
                            currentPage * itemsPerPage,
                            filteredReports.length,
                          ),
                          total: filteredReports.length,
                        },
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1}
                        className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 hover:border-slate-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {translate("reports.pagination.previous", "Previous")}
                      </button>
                      <div className="flex items-center gap-1">
                        {pageNumbers.map((page, idx) => {
                          if (page === "ellipsis") {
                            return (
                              <span
                                key={`ellipsis-${idx}`}
                                className="px-1.5 text-xs text-slate-600"
                              >
                                ...
                              </span>
                            );
                          }
                          return (
                            <button
                              key={page}
                              type="button"
                              onClick={() => handlePageChange(page)}
                              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-all ${
                                currentPage === page
                                  ? "bg-blue-600 text-white shadow-sm"
                                  : "text-slate-700 bg-white border border-slate-300 hover:bg-blue-50 hover:border-blue-400"
                              }`}
                            >
                              {page}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage === totalPages}
                        className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 hover:border-slate-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {translate("reports.pagination.next", "Next")}
                      </button>
                    </div>
                  </div>
                );
              })()}
          </>
        )}
      </div>

      {/* Edit Modal */}
      {editingReportId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 bg-slate-50">
              <h3 className="text-lg font-semibold text-slate-800">
                {translate("editModal.title", "Edit Report")}
              </h3>
              <button
                type="button"
                onClick={() => setEditingReportId(null)}
                className="text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                {translate("editModal.close", "Close")}
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  {translate("editModal.field.title", "Title")}
                </label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) =>
                    setFormData({ ...formData, title: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  {translate("editModal.field.clientName", "Client Name")}
                </label>
                <input
                  type="text"
                  value={formData.client_name}
                  onChange={(e) =>
                    setFormData({ ...formData, client_name: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-semibold text-slate-700 mb-1">
                    {translate("editModal.field.telephone", "Telephone")}
                  </label>
                  <input
                    type="text"
                    value={formData.telephone}
                    onChange={(e) =>
                      setFormData({ ...formData, telephone: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-semibold text-slate-700 mb-1">
                    {translate("editModal.field.email", "Email")}
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) =>
                      setFormData({ ...formData, email: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setEditingReportId(null)}
                  className="px-4 py-2 border border-slate-300 rounded-md text-sm text-slate-700 hover:bg-slate-50"
                >
                  {translate("editModal.cancel", "Cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleUpdateReport}
                  disabled={submitting}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 text-sm"
                >
                  {submitting
                    ? translate("editModal.updating", "Updating...")
                    : translate("editModal.update", "Update")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showValidationModal && (
        <div
          className="fixed inset-0 z-[9999] flex h-screen items-center justify-center overflow-y-auto px-4 py-6"
          onClick={() => {
            if (!validating) {
              closeValidationModal();
            }
          }}
        >
          <div className="absolute inset-0 bg-slate-900/70 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-5xl max-h-[92vh]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="pointer-events-none absolute -top-12 right-6 h-28 w-28 rounded-full bg-cyan-400/30 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-10 left-4 h-32 w-32 rounded-full bg-blue-500/20 blur-3xl" />
            <div className="relative rounded-[32px] bg-gradient-to-br from-cyan-200/70 via-white to-blue-200/70 p-[1px] shadow-[0_40px_120px_rgba(15,23,42,0.35)]">
              <div className="relative flex max-h-[92vh] flex-col overflow-hidden rounded-[32px] bg-white/95 backdrop-blur-xl">
                <div className="relative sticky top-0 z-10 overflow-hidden bg-gradient-to-r from-slate-950 via-blue-900 to-slate-900 px-5 py-4 text-white">
                  <div className="pointer-events-none absolute -right-10 top-0 h-20 w-20 rounded-full bg-cyan-400/25 blur-2xl" />
                  <div className="pointer-events-none absolute left-6 top-6 h-16 w-16 rounded-full bg-indigo-500/20 blur-2xl" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-white/10 border border-white/15 shadow-[0_10px_24px_rgba(2,6,23,0.4)]">
                        <FileSpreadsheet className="h-4 w-4 text-cyan-200" />
                      </span>
                      <div className="flex items-center gap-2 text-[11px] font-semibold text-white/90 min-w-0">
                        <span className="uppercase tracking-[0.3em] text-cyan-200 text-[9px]">
                          {translate(
                            "validationModal.title",
                            "Excel Validation",
                          )}
                        </span>
                        <span className="h-1 w-1 rounded-full bg-white/40" />
                        <span className="text-white">
                          {translate(
                            "validationModal.subtitle",
                            "Validation Results",
                          )}
                        </span>
                        <span className="h-1 w-1 rounded-full bg-white/30" />
                        <span className="text-blue-100 font-normal truncate">
                          {translate(
                            "validationModal.description",
                            "Review issues before uploading to ensure smooth submission.",
                          )}
                        </span>
                      </div>
                      <span className="inline-flex items-center rounded-full border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-semibold text-white">
                        {translate(
                          "validationModal.filesLabel",
                          "Files: {{count}}",
                          {
                            count: validating
                              ? excelFiles.length
                              : validationItems.length,
                          },
                        )}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold ${
                          hasValidationIssues
                            ? "border-rose-300/40 bg-rose-500/20 text-rose-100"
                            : "border-emerald-300/40 bg-emerald-500/20 text-emerald-100"
                        }`}
                      >
                        {translate(
                          "validationModal.issuesLabel",
                          "Issues: {{count}}",
                          { count: totalValidationIssues },
                        )}
                      </span>
                      {wantsPdfUpload && (
                        <span className="inline-flex items-center rounded-full border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-semibold text-white">
                          {translate(
                            "validationModal.pdfsLabel",
                            "PDFs: {{count}}",
                            {
                              count:
                                pdfMatchInfo.unmatchedPdfs.length +
                                pdfMatchInfo.excelsMissingPdf.length,
                            },
                          )}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={
                        validationModalStep === "validation"
                          ? handleValidationContinue
                          : closeValidationModal
                      }
                      disabled={validating}
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/30 bg-white/10 px-3 py-1 text-[10px] font-semibold text-white hover:bg-white/20 whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {validating ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : validationModalStep === "validation" ? (
                        <ChevronRight className="w-3.5 h-3.5" />
                      ) : (
                        <X className="w-3.5 h-3.5" />
                      )}
                      {validating
                        ? translate(
                            "validation.status.validating",
                            "Validating...",
                          )
                        : validationModalStep === "validation"
                          ? translate(
                              "validationModal.continueButton",
                              "Continue",
                            )
                          : translate("validationModal.closeButton", "Close")}
                    </button>
                  </div>
                </div>

                <div className="relative flex-1 overflow-y-auto px-5 py-4">
                  <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.08),transparent_55%),radial-gradient(circle_at_bottom,rgba(14,165,233,0.08),transparent_50%)]" />
                  <div className="relative z-10 space-y-4">
                    {validating ? (
                      <div className="rounded-2xl border border-blue-200 bg-blue-50/70 px-5 py-6 shadow-[0_12px_40px_rgba(59,130,246,0.14)]">
                        <div className="flex items-center gap-3 text-blue-800">
                          <Loader2 className="w-5 h-5 animate-spin" />
                          <div>
                            <div className="text-sm font-semibold">
                              {translate(
                                "validation.status.validating",
                                "Validating...",
                              )}
                            </div>
                            <p className="mt-1 text-xs text-blue-700/90">
                              {translate(
                                "validationModal.loadingHint",
                                "Please wait while we validate the Excel sheet. Results will appear in this same modal.",
                              )}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : validationModalStep === "validation" ? (
                      <>
                        {!validationItems.length && !validationMessage && (
                          <div className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-xs text-slate-600">
                            {translate(
                              "validationModal.emptyMessage",
                              "Upload Excel files to generate validation results.",
                            )}
                          </div>
                        )}

                        {!hasValidationIssues && validationItems.length > 0 && (
                          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-4 text-emerald-700 shadow-[0_10px_30px_rgba(16,185,129,0.12)]">
                            <div className="flex items-center gap-3">
                              <CheckCircle2 className="w-6 h-6" />
                              <div>
                                <div className="text-sm font-semibold">
                                  {translate(
                                    "validationModal.noIssues",
                                    "No issues detected",
                                  )}
                                </div>
                                <p className="text-xs text-emerald-700/90">
                                  {translate(
                                    "validationModal.noIssuesDetails",
                                    "Your Excel files look clean. You can proceed with uploading and submission.",
                                  )}
                                </p>
                              </div>
                            </div>
                          </div>
                        )}

                        {hasValidationIssues && (
                          <div className="space-y-4">
                            <div className="rounded-2xl border border-rose-200 bg-rose-50/70 px-4 py-3 text-rose-700 shadow-[0_10px_30px_rgba(248,113,113,0.12)]">
                              <div className="text-sm font-semibold">
                                {translate(
                                  "validationModal.actionRequired",
                                  "Action required",
                                )}
                              </div>
                              <p className="text-xs text-rose-700/90">
                                {translate(
                                  "validationModal.actionHint",
                                  "Fix the items below and re-validate before uploading. Ensure required fields are filled, inspection dates are valid, and asset usage IDs match the allowed list.",
                                )}
                              </p>
                            </div>

                            <div className="inline-flex rounded-full bg-slate-100/80 p-1 text-xs font-semibold text-slate-600 shadow-sm">
                              <button
                                type="button"
                                onClick={() =>
                                  setValidationTableTab("report-info")
                                }
                                className={`px-4 py-1.5 rounded-full transition ${
                                  validationTableTab === "report-info"
                                    ? "bg-white text-slate-900 shadow-sm"
                                    : "text-slate-500 hover:text-slate-700"
                                }`}
                              >
                                {translate(
                                  "validationModal.tabs.reportInfo",
                                  "Report Info",
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => setValidationTableTab("assets")}
                                className={`px-4 py-1.5 rounded-full transition ${
                                  validationTableTab === "assets"
                                    ? "bg-white text-slate-900 shadow-sm"
                                    : "text-slate-500 hover:text-slate-700"
                                }`}
                              >
                                {translate(
                                  "validationModal.tabs.assetsAndPdfs",
                                  "Assets & PDFs",
                                )}
                              </button>
                            </div>

                            {validationTableTab === "report-info" ? (
                              reportInfoIssues.length > 0 ? (
                                <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                                  <div className="max-h-[260px] overflow-y-auto">
                                    <table className="min-w-full text-xs text-slate-700">
                                      <thead className="bg-slate-900 text-slate-100 sticky top-0">
                                        <tr>
                                          <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                            {translate(
                                              "validationModal.table.headers.excel",
                                              "Excel",
                                            )}
                                          </th>
                                          <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                            {translate(
                                              "validationModal.table.headers.field",
                                              "Field",
                                            )}
                                          </th>
                                          <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                            {translate(
                                              "validationModal.table.headers.location",
                                              "Location",
                                            )}
                                          </th>
                                          <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                            {translate(
                                              "validationModal.table.headers.details",
                                              "Details",
                                            )}
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {reportInfoIssues.map((issue, idx) => (
                                          <tr
                                            key={`report-info-${idx}`}
                                            className="border-b border-slate-200"
                                          >
                                            <td className="px-3 py-2 font-medium text-slate-800">
                                              {issue.fileName}
                                            </td>
                                            <td className="px-3 py-2 font-semibold text-slate-800">
                                              {issue.field}
                                            </td>
                                            <td className="px-3 py-2 text-slate-600">
                                              {issue.location || "-"}
                                            </td>
                                            <td className="px-3 py-2 text-slate-700">
                                              {issue.message}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ) : (
                                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
                                  {translate(
                                    "validationModal.reportInfo.noIssues",
                                    "No report info issues detected.",
                                  )}
                                </div>
                              )
                            ) : (
                              <div className="space-y-3">
                                {wantsPdfUpload &&
                                  (pdfMatchInfo.excelsMissingPdf.length ||
                                    pdfMatchInfo.unmatchedPdfs.length) && (
                                    <div className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-amber-700 text-xs">
                                      <div className="font-semibold">
                                        {translate(
                                          "validationModal.pdfMatchingIssues.title",
                                          "PDF matching issues",
                                        )}
                                      </div>
                                      <div className="mt-1 space-y-1">
                                        {pdfMatchInfo.excelsMissingPdf.length >
                                          0 && (
                                          <div>
                                            {translate(
                                              "validationModal.pdfMatchingIssues.missing",
                                              "Excel files missing PDF: {{files}}",
                                              {
                                                files:
                                                  pdfMatchInfo.excelsMissingPdf.join(
                                                    ", ",
                                                  ),
                                              },
                                            )}
                                          </div>
                                        )}
                                        {pdfMatchInfo.unmatchedPdfs.length >
                                          0 && (
                                          <div>
                                            {translate(
                                              "validationModal.pdfMatchingIssues.unmatched",
                                              "Unmatched PDFs: {{files}}",
                                              {
                                                files:
                                                  pdfMatchInfo.unmatchedPdfs.join(
                                                    ", ",
                                                  ),
                                              },
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                {assetIssues.length > 0 ? (
                                  <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                                    <div className="max-h-[260px] overflow-y-auto">
                                      <table className="min-w-full text-xs text-slate-700">
                                        <thead className="bg-slate-900 text-slate-100 sticky top-0">
                                          <tr>
                                            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                              {translate(
                                                "validationModal.table.headers.excel",
                                                "Excel",
                                              )}
                                            </th>
                                            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                              {translate(
                                                "validationModal.table.headers.field",
                                                "Field",
                                              )}
                                            </th>
                                            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                              {translate(
                                                "validationModal.table.headers.location",
                                                "Location",
                                              )}
                                            </th>
                                            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">
                                              {translate(
                                                "validationModal.table.headers.details",
                                                "Details",
                                              )}
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {assetIssues.map((issue, idx) => (
                                            <tr
                                              key={`asset-issue-${idx}`}
                                              className="border-b border-slate-200"
                                            >
                                              <td className="px-3 py-2 font-medium text-slate-800">
                                                {issue.fileName}
                                              </td>
                                              <td className="px-3 py-2 font-semibold text-slate-800">
                                                {issue.field}
                                              </td>
                                              <td className="px-3 py-2 text-slate-600">
                                                {issue.location || "-"}
                                              </td>
                                              <td className="px-3 py-2 text-slate-700">
                                                {issue.message}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
                                    {translate(
                                      "validationModal.assetIssues.noIssues",
                                      "No asset issues detected.",
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="space-y-4">
                        <div className="rounded-2xl border border-blue-200 bg-blue-50/70 px-4 py-3 text-blue-900 shadow-[0_10px_30px_rgba(59,130,246,0.12)]">
                          <span className="inline-flex items-center rounded-full border border-blue-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                            {translate(
                              "validationModal.step2.badge",
                              "Step 2 (Optional)",
                            )}
                          </span>
                          <div className="text-sm font-semibold">
                            {translate(
                              "validationModal.step2.title",
                              "Step 2 (Optional): Edit report information",
                            )}
                          </div>
                          <p className="text-xs text-blue-900/80 mt-1">
                            {translate(
                              "validationModal.step2.subtitle",
                              "You can update important report fields, or skip this optional step.",
                            )}
                          </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                          <div className="md:col-span-2">
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              {translate("editModal.field.title", "Title")}
                            </label>
                            <input
                              type="text"
                              value={uploadFormData.title}
                              onChange={(e) =>
                                setUploadFormData((prev) => ({
                                  ...prev,
                                  title: e.target.value,
                                }))
                              }
                              className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              {translate(
                                "editModal.field.clientName",
                                "Client Name",
                              )}
                            </label>
                            <input
                              type="text"
                              value={uploadFormData.client_name}
                              onChange={(e) =>
                                setUploadFormData((prev) => ({
                                  ...prev,
                                  client_name: e.target.value,
                                }))
                              }
                              className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              {translate(
                                "editModal.field.telephone",
                                "Telephone",
                              )}
                            </label>
                            <input
                              type="text"
                              value={uploadFormData.telephone}
                              onChange={(e) =>
                                setUploadFormData((prev) => ({
                                  ...prev,
                                  telephone: e.target.value,
                                }))
                              }
                              className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              {translate("editModal.field.email", "Email")}
                            </label>
                            <input
                              type="email"
                              value={uploadFormData.email}
                              onChange={(e) =>
                                setUploadFormData((prev) => ({
                                  ...prev,
                                  email: e.target.value,
                                }))
                              }
                              className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                            />
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm space-y-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <span className="mb-1 inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                {translate(
                                  "validationModal.step2.pdfSection.badgeOptional",
                                  "Step 3 (Optional)",
                                )}
                              </span>
                              <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                                <Files className="w-3.5 h-3.5 text-blue-600" />
                                {translate(
                                  "validationModal.step2.pdfSection.title",
                                  "Step 3: PDF attachment (optional)",
                                )}
                              </div>
                              <p className="mt-1 text-[11px] text-slate-600">
                                {translate(
                                  "validationModal.step2.pdfSection.subtitle",
                                  "Choose to upload matching PDFs now, or skip and use the placeholder automatically.",
                                )}
                              </p>
                            </div>
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                                wantsPdfUpload
                                  ? "border-blue-200 bg-blue-50 text-blue-700"
                                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
                              }`}
                            >
                              {wantsPdfUpload
                                ? translate(
                                    "validationModal.step2.pdfSection.modeUpload",
                                    "Upload mode",
                                  )
                                : translate(
                                    "validationModal.step2.pdfSection.modePlaceholder",
                                    "Placeholder mode",
                                  )}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => handlePdfToggle(false)}
                              className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                                !wantsPdfUpload
                                  ? "border-emerald-300 bg-emerald-50"
                                  : "border-slate-200 bg-slate-50 hover:border-slate-300"
                              }`}
                            >
                              <div className="text-xs font-semibold text-slate-800">
                                {translate(
                                  "validationModal.step2.pdfSection.usePlaceholder",
                                  "Use placeholder PDF",
                                )}
                              </div>
                              <p className="mt-1 text-[10px] text-slate-600">
                                {translate(
                                  "validationModal.step2.pdfSection.usePlaceholderHint",
                                  "Skip manual PDF upload and use the built-in placeholder file.",
                                )}
                              </p>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handlePdfToggle(true, { openPicker: true })
                              }
                              className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                                wantsPdfUpload
                                  ? "border-blue-300 bg-blue-50"
                                  : "border-slate-200 bg-slate-50 hover:border-slate-300"
                              }`}
                            >
                              <div className="text-xs font-semibold text-slate-800">
                                {translate(
                                  "validationModal.step2.pdfSection.uploadPdfs",
                                  "Upload PDFs",
                                )}
                              </div>
                              <p className="mt-1 text-[10px] text-slate-600">
                                {translate(
                                  "validationModal.step2.pdfSection.uploadPdfsHint",
                                  "Upload PDF files with names matching each Excel filename.",
                                )}
                              </p>
                            </button>
                          </div>

                          {wantsPdfUpload ? (
                            <div className="rounded-xl border border-blue-200 bg-blue-50/60 px-3 py-3 space-y-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-[11px] font-medium text-blue-800">
                                  {pdfFiles.length
                                    ? translate(
                                        "filePicker.selectedPdfs",
                                        "{{count}} file(s) selected",
                                        { count: pdfFiles.length },
                                      )
                                    : translate(
                                        "filePicker.choosePdfFiles",
                                        "Choose PDF files",
                                      )}
                                </span>
                                <button
                                  type="button"
                                  onClick={openPdfPicker}
                                  className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-white px-2 py-1 text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
                                >
                                  {translate(
                                    "validationModal.step2.pdfSection.chooseButton",
                                    "Choose PDFs",
                                  )}
                                </button>
                              </div>
                              {pdfFiles.length > 0 && (
                                <div className="rounded-lg border border-blue-100 bg-white/80 px-2 py-1.5 text-[10px] text-slate-700">
                                  {pdfFiles
                                    .slice(0, 4)
                                    .map((file) => file.name)
                                    .join(", ")}
                                  {pdfFiles.length > 4
                                    ? translate(
                                        "validationModal.step2.pdfSection.moreFiles",
                                        "+{{count}} more",
                                        { count: pdfFiles.length - 4 },
                                      )
                                    : ""}
                                </div>
                              )}
                              {pdfMatchInfo.excelsMissingPdf.length > 0 ||
                              pdfMatchInfo.unmatchedPdfs.length > 0 ? (
                                <div className="rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] text-rose-700">
                                  {translate(
                                    "validationModal.step2.pdfSection.matchWarning",
                                    "Some PDF filenames do not match Excel filenames.",
                                  )}
                                </div>
                              ) : pdfFiles.length > 0 ? (
                                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[10px] text-emerald-700">
                                  {translate(
                                    "validationModal.step2.pdfSection.matchSuccess",
                                    "All selected PDFs match Excel filenames.",
                                  )}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-[11px] text-emerald-700">
                              {translate(
                                "filePicker.willUseDummyPdf",
                                "Will use {{placeholder}}",
                                { placeholder: DUMMY_PDF_NAME },
                              )}
                            </div>
                          )}
                        </div>

                        {!isReadyToUpload && (
                          <div className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs text-amber-700">
                            {translate(
                              "validationModal.step2.fixValidationFirst",
                              "Fix validation issues first, then choose one of the action buttons below.",
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 bg-white/90 px-5 py-3 text-[10px] text-slate-500">
                  {validating ? (
                    <>
                      <span>
                        {translate(
                          "validationModal.loadingHint",
                          "Please wait while we validate the Excel sheet. Results will appear in this same modal.",
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-[10px] font-semibold text-blue-700">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {translate(
                          "validation.status.validating",
                          "Validating...",
                        )}
                      </span>
                    </>
                  ) : validationModalStep === "validation" ? (
                    <>
                      <span>
                        {translate(
                          "validationModal.footerContinueHint",
                          "Continue to edit report info and choose the upload action.",
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={handleValidationContinue}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-400"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                        {translate(
                          "validationModal.continueButton",
                          "Continue",
                        )}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                          {translate("validationModal.step3.badge", "Step 4")}
                        </span>
                        <span>
                          {translate(
                            "validationModal.step2.actionHint",
                            "Step 4: Choose how to continue with the uploaded reports.",
                          )}
                        </span>
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setValidationModalStep("validation")}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-400"
                        >
                          {translate(
                            "validationModal.step2.back",
                            "Back to validation",
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => executeUploadModalAction("later")}
                          disabled={storeOnlyLoading || !isReadyToUpload}
                          className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-1 text-[10px] font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {storeOnlyLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <FileIcon className="w-3.5 h-3.5" />
                          )}
                          {storeOnlyLoading
                            ? translate("actions.uploading", "Uploading...")
                            : translate(
                                "actions.storeAndSubmitLater",
                                "Store and Submit Later",
                              )}
                        </button>
                        <button
                          type="button"
                          onClick={() => executeUploadModalAction("now")}
                          disabled={
                            storeAndSubmitLoading ||
                            submitting ||
                            !isReadyToUpload
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {storeAndSubmitLoading || submitting ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          {storeAndSubmitLoading
                            ? translate("actions.uploading", "Uploading...")
                            : submitting
                              ? translate("actions.submitting", "Submitting...")
                              : translate(
                                  "actions.storeAndSubmitNow",
                                  "Store and Submit Now",
                                )}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SubmitReportsQuickly;
