import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Package,
  Search,
  Check,
  RefreshCcw,
  CheckCheck,
  Filter,
  Clock,
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  X,
  MoreVertical,
  ExternalLink,
  Send,
  Table,
  Eye,
} from "lucide-react";
import { useRam } from "../context/RAMContext";
import { useSession } from "../context/SessionContext";
import { useAuthAction } from "../hooks/useAuthAction"; // Add this import
import { useValueNav } from "../context/ValueNavContext";
import { useNavStatus } from "../context/NavStatusContext";
import { extractTaqeemUsernameFromUser } from "../../shared/helper/taqeemAuthWrap";
import EditAssetModal from "./EditAssetModal";

const REPORTS_TABLE_PAGE_NAME = "Reports Table";

const ReportsTable = ({ onViewChange }) => {
  const { t } = useTranslation();
  const quickTranslate = useCallback(
    (key, defaultValue, options = {}) =>
      t(`submitReportsQuickly.${key}`, { defaultValue, ...options }),
    [t],
  );
  const translate = useCallback(
    (key, defaultValue, options = {}) =>
      t(`uploadAssets.reportsTable.${key}`, { defaultValue, ...options }),
    [t],
  );
  const [reports, setReports] = useState([]);
  const [flowPaused, setFlowPaused] = useState({});
  const [assetFilter, setAssetFilter] = useState("all");
  const [actionDropdown, setActionDropdown] = useState({});
  const [submitToTaqeemLoading, setSubmitToTaqeemLoading] = useState({});
  const [editLoading, setEditLoading] = useState({});
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [success, setSuccess] = useState("");
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [selectedReportId, setSelectedReportId] = useState(null);
  const [filteredReports, setFilteredReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedReport, setExpandedReport] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [allReports, setAllReports] = useState([]);
  const [dropdownOpen, setDropdownOpen] = useState(null);
  const [highlightReportId, setHighlightReportId] = useState(null);
  const [showInsufficientPointsModal, setShowInsufficientPointsModal] =
    useState(false); // Add this state
  const [submitProgress, setSubmitProgress] = useState({});
  const pendingCompanySelectionRef = useRef(null);
  const { token, user } = useSession();
  const { executeWithAuth } = useAuthAction(); // Add this hook
  const {
    selectedCompany,
    companies,
    preferredCompany,
    ensureCompaniesLoaded,
    replaceCompanies,
    setSelectedCompany,
  } = useValueNav();
  const { setCompanyStatus } = useNavStatus();
  const selectedCompanyOfficeId =
    selectedCompany?.officeId || selectedCompany?.office_id || "";
  const { ramInfo } = useRam();
  const tabsNum = ramInfo?.recommendedTabs || 1;
  const taqeemLinked = Boolean(extractTaqeemUsernameFromUser(user || {}));

  // Add this useEffect to listen for progress updates
  useEffect(() => {
    const unsubscribe = window.electronAPI.onSubmitReportsQuicklyProgress?.(
      (data) => {
        console.log("[ReportsTable] Progress update:", data);

        if (data.reportId || data.processId) {
          const reportId = data.reportId || data.processId;
          setSubmitProgress((prev) => ({
            ...prev,
            [reportId]: {
              current: data.completed || data.current || 0,
              total: data.total || 1,
              percentage: data.percentage || 0,
              message: data.message || "",
              status: data.status,
            },
          }));
        }
      },
    );

    return () => {
      if (unsubscribe) unsubscribe();
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
          const data = await window.electronAPI.getCompanies();
          const fetched = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.companies)
              ? data.companies
              : [];
          if (fetched.length > 0 && replaceCompanies) {
            list = await replaceCompanies(
              fetched.map((c) => ({ ...c, type: c.type || "equipment" })),
              { autoSelect: false, skipNavigation: true, quiet: true },
            );
          }
        }
      } catch (err) {
        console.warn("Failed to fetch companies for submission", err);
      }

      if (!list || list.length === 0) {
        throw new Error("No companies available. Login to Taqeem and try again.");
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
        await setSelectedCompany(chosen, { skipNavigation: false, quiet: true });
        setCompanyStatus?.("success", `Company: ${chosen.name || "Selected"}`);
        return chosen;
      }

      setCompanyStatus?.("info", "Select a company to continue.");
      setSuccess("Select a company to continue.");
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
    ],
  );

  const [loadingActions, setLoadingActions] = useState({
    fullCheck: {},
    halfCheck: {},
    retry: {},
    send: {},
  });

  

  const handleSubmitToTaqeem = async (reportId) => {
    // Find the report to check status
    const report = allReports.find((r) => r.report_id === reportId);
    if (!report) return;

    const status = getReportStatus(report);
    if (status !== "New") {
      setError("Only NEW status reports can be submitted to Taqeem");
      return;
    }

    if (submitToTaqeemLoading[reportId]) return;

    await executeWithAuth(
      async (params) => {
        const { token: authToken, reportId: id, tabsNum: tabs } = params;

        setSubmitToTaqeemLoading((prev) => ({ ...prev, [reportId]: true }));
        // Initialize progress
        setSubmitProgress((prev) => ({
          ...prev,
          [reportId]: {
            current: 0,
            total: 1,
            percentage: 0,
            message: "Starting submission...",
            status: "RUNNING",
          },
        }));
        setDropdownOpen(null);

        try {
          console.log("[ReportsTable] Calling completeFlow for report:", id);

          if (!report?.company_office_id) {
            const chosen = await ensureCompanySelected({
              forceSelection: true,
              ignorePreferred: true,
            });
            const officeId = chosen?.officeId || chosen?.office_id;
            if (officeId && report?._id) {
              try {
                await window.electronAPI.apiRequest(
                  "PATCH",
                  `/api/report/${report._id}/company-office`,
                  { companyOfficeId: String(officeId) },
                  {
                    Authorization: `Bearer ${authToken}`,
                  },
                );
                report.company_office_id = String(officeId);
                await fetchAllReports(authToken);
              } catch (err) {
                console.warn(
                  "[ReportsTable] Failed to update company office id",
                  err,
                );
              }
            }
          }

          const flowResult = await window.electronAPI.completeFlow(id, tabs);

          console.log("[ReportsTable] completeFlow result:", flowResult);

          if (flowResult?.status === "SUCCESS") {
            const completedAssets = flowResult?.summary?.complete_macros || 0;

            // Clear progress after success
            setTimeout(() => {
              setSubmitProgress((prev) => {
                const next = { ...prev };
                delete next[reportId];
                return next;
              });
            }, 2000);

            return {
              success: true,
              message: `Successfully submitted report "${id}" to Taqeem. ${completedAssets} assets processed.`,
              completedAssets,
              reportId: id,
            };
          } else {
            throw new Error(
              flowResult?.message ||
                "Failed to submit to Taqeem. Please try again.",
            );
          }
        } catch (error) {
          console.error("[ReportsTable] Error submitting to Taqeem:", error);
          // Clear progress on error
          setSubmitProgress((prev) => {
            const next = { ...prev };
            delete next[reportId];
            return next;
          });
          throw error;
        } finally {
          setSubmitToTaqeemLoading((prev) => ({ ...prev, [reportId]: false }));
        }
      },
      { token, reportId, tabsNum },
      {
        requiredPoints: 1,
        deductPoints: (result) => {
          const amount = Number(result?.completedAssets) || 0;
          if (!amount) return null;
          const reportIdValue = result?.reportId || null;
          const reportIds = reportIdValue ? [reportIdValue] : [];
          return {
            amount,
            reportIds,
            reportId: reportIdValue,
            recordId,
            source: "reports-table",
            pageName: REPORTS_TABLE_PAGE_NAME,
            pageSource: "reports-table",
            assetCount: amount,
          };
        },
        showInsufficientPointsModal: () => setShowInsufficientPointsModal(true),
        onAuthSuccess: () => {
          console.log("Submit to Taqeem authentication successful");
        },
        onAuthFailure: (reason) => {
          console.warn("Submit to Taqeem authentication failed:", reason);
          // Clear progress on auth failure
          setSubmitProgress((prev) => {
            const next = { ...prev };
            delete next[reportId];
            return next;
          });
          if (reason !== "INSUFFICIENT_POINTS" && reason !== "LOGIN_REQUIRED") {
            setError(
              reason?.message || "Authentication failed for Submit to Taqeem",
            );
          }
        },
      },
    )
      .then((result) => {
        if (result?.success) {
          setSuccess(result.message);
          fetchAllReports();
        }
      })
      .catch((error) => {
        if (
          !error?.message?.includes("INSUFFICIENT_POINTS") &&
          !error?.message?.includes("LOGIN_REQUIRED")
        ) {
          setError(error?.message || "Failed to submit to Taqeem");
        }
      });
  };

  const handlePauseFlow = async (reportId) => {
    try {
      const result = await window.electronAPI.pauseCompleteFlow?.(reportId);
      if (result?.status === "SUCCESS") {
        console.log("[ReportsTable] Flow paused successfully");
        // Update local paused state
        setFlowPaused((prev) => ({ ...prev, [reportId]: true }));
        // Also update progress status
        setSubmitProgress((prev) => ({
          ...prev,
          [reportId]: {
            ...prev[reportId],
            status: "PAUSED",
          },
        }));
      }
    } catch (error) {
      console.error("[ReportsTable] Error pausing flow:", error);
      setError("Failed to pause flow");
    }
  };

  const handleResumeFlow = async (reportId) => {
    try {
      const result = await window.electronAPI.resumeCompleteFlow?.(reportId);
      if (result?.status === "SUCCESS") {
        console.log("[ReportsTable] Flow resumed successfully");
        // Clear local paused state
        setFlowPaused((prev) => ({ ...prev, [reportId]: false }));
        // Update progress status
        setSubmitProgress((prev) => ({
          ...prev,
          [reportId]: {
            ...prev[reportId],
            status: "RUNNING",
          },
        }));
      }
    } catch (error) {
      console.error("[ReportsTable] Error resuming flow:", error);
      setError("Failed to resume flow");
    }
  };

  const handleStopFlow = async (reportId) => {
    try {
      const result = await window.electronAPI.stopCompleteFlow?.(reportId);
      if (result?.status === "SUCCESS") {
        console.log("[ReportsTable] Flow stopped successfully");
        setSubmitToTaqeemLoading((prev) => ({ ...prev, [reportId]: false }));
        // Clear paused state
        setFlowPaused((prev) => ({ ...prev, [reportId]: false }));
        // Clear progress
        setSubmitProgress((prev) => {
          const next = { ...prev };
          delete next[reportId];
          return next;
        });
        fetchAllReports();
      }
    } catch (error) {
      console.error("[ReportsTable] Error stopping flow:", error);
      setError("Failed to stop flow");
    }
  };

  const setActionLoading = (actionType, reportId, isLoading) => {
    setLoadingActions((prev) => ({
      ...prev,
      [actionType]: {
        ...prev[actionType],
        [reportId]: isLoading,
      },
    }));
  };

  const handleOpenEdit = (asset, reportId) => {
    setSelectedAsset(asset);
    setSelectedReportId(reportId);
    setEditModalOpen(true);
  };

  const isActionLoading = (actionType, reportId) => {
    return loadingActions[actionType]?.[reportId] || false;
  };

  // Helper function to count pending assets for retry action
  const getPendingAssetsCount = (report) => {
    const assetData = getAssetData(report);
    return assetData.filter((asset) => asset.submitState !== 1).length;
  };

  const handleFullCheck = async (reportId, report) => {
    if (isActionLoading("fullCheck", reportId)) return;

    await executeWithAuth(
      async (params) => {
        const { token: authToken, reportId: id, tabsNum: tabs } = params;

        setActionLoading("fullCheck", reportId, true);
        setDropdownOpen(null);
        try {
          await window.electronAPI?.fullCheck?.(id, tabs);
          setTimeout(() => {
            fetchAllReports();
          }, 1000);
        } catch (error) {
          console.error("Full check error:", error);
          setError("Failed to perform full check");
          throw error;
        } finally {
          setTimeout(() => {
            setActionLoading("fullCheck", reportId, false);
          }, 500);
        }
      },
      { token, reportId, tabsNum },
      {
        requiredPoints: 1, // Full check costs 1 point
        showInsufficientPointsModal: () => setShowInsufficientPointsModal(true),
        onAuthSuccess: () => {
          console.log("Full check authentication successful");
        },
        onAuthFailure: (reason) => {
          console.warn("Full check authentication failed:", reason);
          if (reason !== "INSUFFICIENT_POINTS" && reason !== "LOGIN_REQUIRED") {
            setError(reason?.message || "Authentication failed for full check");
          }
        },
      },
    );
  };

  const handleHalfCheck = async (reportId, report) => {
    if (isActionLoading("halfCheck", reportId)) return;

    await executeWithAuth(
      async (params) => {
        const { token: authToken, reportId: id, tabsNum: tabs } = params;

        setActionLoading("halfCheck", reportId, true);
        setDropdownOpen(null);
        try {
          await window.electronAPI?.halfCheck?.(id, tabs);
          setTimeout(() => {
            fetchAllReports();
          }, 1000);
        } catch (error) {
          console.error("Half check error:", error);
          setError("Failed to perform half check");
          throw error;
        } finally {
          setTimeout(() => {
            setActionLoading("halfCheck", reportId, false);
          }, 500);
        }
      },
      { token, reportId, tabsNum },
      {
        requiredPoints: 1, // Half check costs 1 point
        showInsufficientPointsModal: () => setShowInsufficientPointsModal(true),
        onAuthSuccess: () => {
          console.log("Half check authentication successful");
        },
        onAuthFailure: (reason) => {
          console.warn("Half check authentication failed:", reason);
          if (reason !== "INSUFFICIENT_POINTS" && reason !== "LOGIN_REQUIRED") {
            setError(reason?.message || "Authentication failed for half check");
          }
        },
      },
    );
  };

  const handleRetry = async (reportId, report) => {
    if (isActionLoading("retry", reportId)) return;

    const pendingAssetsCount = getPendingAssetsCount(report);

    await executeWithAuth(
      async (params) => {
        const { token: authToken, reportId: id, tabsNum: tabs } = params;

        setActionLoading("retry", reportId, true);
        setDropdownOpen(null);
        try {
          await window.electronAPI?.macroFillRetry?.(id, tabs);
          setTimeout(() => {
            fetchAllReports();
          }, 1000);
        } catch (error) {
          console.error("Retry error:", error);
          setError("Failed to retry macro fill");
          throw error;
        } finally {
          setTimeout(() => {
            setActionLoading("retry", reportId, false);
          }, 500);
        }
      },
      { token, reportId, tabsNum },
      {
        requiredPoints: pendingAssetsCount, // Retry costs pending assets count
        showInsufficientPointsModal: () => setShowInsufficientPointsModal(true),
        onAuthSuccess: () => {
          console.log("Retry authentication successful");
        },
        onAuthFailure: (reason) => {
          console.warn("Retry authentication failed:", reason);
          if (reason !== "INSUFFICIENT_POINTS" && reason !== "LOGIN_REQUIRED") {
            setError(reason?.message || "Authentication failed for retry");
          }
        },
      },
    );
  };

  const handleSend = async (reportId, report) => {
    if (isActionLoading("send", reportId)) return;

    await executeWithAuth(
      async (params) => {
        const { token: authToken, reportId: id } = params;

        setActionLoading("send", reportId, true);
        setDropdownOpen(null);
        try {
          await window.electronAPI?.finalizeMultipleReports?.([id]);
          setTimeout(() => {
            fetchAllReports();
          }, 1000);
        } catch (error) {
          console.error("Send error:", error);
          setError("Failed to send report");
          throw error;
        } finally {
          setTimeout(() => {
            setActionLoading("send", reportId, false);
          }, 500);
        }
      },
      { token, reportId },
      {
        requiredPoints: 1, // Send costs 1 point
        showInsufficientPointsModal: () => setShowInsufficientPointsModal(true),
        onAuthSuccess: () => {
          console.log("Send authentication successful");
        },
        onAuthFailure: (reason) => {
          console.warn("Send authentication failed:", reason);
          if (reason !== "INSUFFICIENT_POINTS" && reason !== "LOGIN_REQUIRED") {
            setError(reason?.message || "Authentication failed for send");
          }
        },
      },
    );
  };

  const fetchAllReports = async (overrideToken) => {
    try {
      setLoading(true);
      setError("");

      const activeToken = overrideToken || token;

      if (!activeToken) return;

      if (!taqeemLinked) {
        setAllReports([]);
        setTotalPages(1);
        setTotalItems(0);
        setFilteredReports([]);
        setReports([]);
        setError("");
        return;
      }

      if (!selectedCompanyOfficeId) {
        setAllReports([]);
        setTotalPages(1);
        setTotalItems(0);
        setFilteredReports([]);
        setReports([]);
        setError("");
        return;
      }

      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: pageSize.toString(),
        sortBy: "createdAt",
        sortOrder: "desc",
        companyOfficeId: String(selectedCompanyOfficeId),
      });

      const result = await window.electronAPI.apiRequest(
        "GET",
        `/api/submit-reports-quickly/user?${params.toString()}`,
        {},
        {
          Authorization: `Bearer ${activeToken}`,
        },
      );

      if (result.success) {
        const rows = Array.isArray(result.data)
          ? result.data
          : Array.isArray(result.reports)
            ? result.reports
            : [];
        setAllReports(rows);
        const pg = result.pagination || {};
        setTotalPages(pg.totalPages || 1);
        setTotalItems(pg.totalItems ?? pg.total ?? rows.length);

        applyFilters(rows);
      } else {
        setError(
          (result?.message || "")
            .replace(/^Error invoking remote method '[^']+':\s*/i, "")
            .replace(/^Error:\s*/i, "") || "Failed to fetch reports",
        );
      }
    } catch (err) {
      console.error("Error fetching reports:", err);
      setError(
        (err?.message || "")
            .replace(/^Error invoking remote method '[^']+':\s*/i, "")
            .replace(/^Error:\s*/i, "") || "Failed to fetch reports",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = () => {
      setDropdownOpen(null);
    };

    document.addEventListener("click", handleClickOutside);
    return () => {
      document.removeEventListener("click", handleClickOutside);
    };
  }, []);

  const applyFilters = (dataToFilter = allReports) => {
    let filtered = [...dataToFilter];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (report) =>
          report.report_id && report.report_id.toLowerCase().includes(query),
      );
    }

    if (statusFilter !== "all") {
      filtered = filtered.filter((report) => {
        const status = getReportStatus(report);
        if (statusFilter === "completed") {
          return status.toLowerCase() === "completed";
        } else if (statusFilter === "pending") {
          return (
            status.toLowerCase() !== "completed" &&
            status.toLowerCase() !== "sent"
          );
        } else if (statusFilter === "sent") {
          return status.toLowerCase() === "sent";
        }
        return true;
      });
    }

    setFilteredReports(filtered);
    setReports(filtered);
  };

  const clearAllFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setFilteredReports(allReports);
    setReports(allReports);
  };

  useEffect(() => {
    fetchAllReports();
  }, [currentPage, pageSize, selectedCompanyOfficeId, taqeemLinked, token]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCompanyOfficeId, taqeemLinked]);

  useEffect(() => {
    applyFilters();
  }, [searchQuery, statusFilter]);

  useEffect(() => {
    if (!allReports.length) return;
    const raw = localStorage.getItem("notification-target");
    if (!raw) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      console.warn("Failed to parse notification target", err);
      localStorage.removeItem("notification-target");
      return;
    }
    if (payload?.type !== "report" || !payload?.id) return;
    const match = allReports.find(
      (report) => report._id === payload.id || report.report_id === payload.id,
    );
    if (!match) return;
    if (match.report_id) {
      setSearchQuery(match.report_id);
    }
    setExpandedReport(match._id);
    setHighlightReportId(match._id);
    setCurrentPage(1);
    setTimeout(() => setHighlightReportId(null), 6000);
    localStorage.removeItem("notification-target");
  }, [allReports]);

  const toggleReportExpand = (reportId) => {
    setExpandedReport(expandedReport === reportId ? null : reportId);
  };

  const handlePageChange = (page) => {
    const pageNumber = Number(page);
    if (pageNumber >= 1 && pageNumber <= totalPages) {
      setCurrentPage(pageNumber);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return "—";
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  };

  const formatCurrency = (value) => {
    if (!value) return "—";
    try {
      const num = parseInt(value);
      if (isNaN(num)) return value;

      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(num);
    } catch {
      return value;
    }
  };

  const capitalizeStatus = (value = "") => {
    return value
      .toString()
      .replace(/_/g, " ")
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const getAssetData = (report) => {
    return report.asset_data || [];
  };

  const getReportStatus = (report) => {
    // First check if report has a status field
    if (report.report_status) {
      const status = capitalizeStatus(report.report_status);
      if (status === "New") return status;
    }

    if (report.status) {
      const status = capitalizeStatus(report.status);
      if (status === "New") return status;
    }

    const assetData = getAssetData(report);
    const allCompleted = assetData.every((asset) => asset.submitState === 1);
    if (allCompleted) return capitalizeStatus("completed");

    if (assetData.length === 0) return capitalizeStatus("draft");

    const anyCompleted = assetData.some((asset) => asset.submitState === 1);

    if (anyCompleted) return capitalizeStatus("in progress");
    return capitalizeStatus("pending");
  };

  const getStatusFilterLabel = useCallback(
    (statusKey) => {
      if (statusKey === "all") {
        return translate("filters.all", "All");
      }
      if (statusKey === "pending") {
        return translate("filters.pending", "Pending");
      }
      if (statusKey === "completed") {
        return translate("filters.completed", "Completed");
      }
      if (statusKey === "sent") {
        return translate("filters.sent", "Sent");
      }
      return statusKey;
    },
    [translate],
  );

  const getLocalizedStatusLabel = useCallback(
    (statusValue) => {
      const normalized = String(statusValue || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

      if (normalized === "new") {
        return quickTranslate("reports.status.new", "New");
      }
      if (normalized === "sent") {
        return quickTranslate("reports.status.sent", "Sent");
      }
      if (normalized === "approved") {
        return quickTranslate("reports.status.approved", "Approved");
      }
      if (normalized === "confirmed") {
        return quickTranslate("reports.status.confirmed", "Confirmed");
      }
      if (normalized === "complete" || normalized === "completed") {
        return quickTranslate("reports.status.complete", "Complete");
      }
      if (normalized === "incomplete") {
        return quickTranslate("reports.status.incomplete", "Incomplete");
      }
      if (
        normalized === "pending" ||
        normalized === "draft" ||
        normalized.includes("progress")
      ) {
        return translate("status.pending", "Pending");
      }

      return statusValue;
    },
    [quickTranslate, translate],
  );

  // Update the getStatusColor function to handle "NEW" status:
  const getStatusColor = (status) => {
    const statusUpper = status.toUpperCase();

    if (statusUpper === "NEW")
      return "border-blue-200 bg-blue-50 text-blue-700";
    if (statusUpper === "CONFIRMED")
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (statusUpper === "SENT")
      return "border-purple-200 bg-purple-50 text-purple-700";
    if (statusUpper === "COMPLETED" || statusUpper === "COMPLETE")
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (statusUpper.includes("PROGRESS"))
      return "border-blue-200 bg-blue-50 text-blue-700";
    if (statusUpper === "PENDING" || statusUpper === "DRAFT")
      return "border-amber-200 bg-amber-50 text-amber-700";
    if (statusUpper === "INCOMPLETE")
      return "border-orange-200 bg-orange-50 text-orange-700";

    return "border-gray-200 bg-gray-50 text-gray-700";
  };

  // Update the getStatusIcon function to handle "NEW" status:
  const getStatusIcon = (status) => {
    const statusUpper = status.toUpperCase();

    if (statusUpper === "NEW") return <ExternalLink className="w-2.5 h-2.5" />;
    if (statusUpper === "CONFIRMED")
      return <CheckCircle2 className="w-2.5 h-2.5" />;
    if (statusUpper === "SENT") return <Send className="w-2.5 h-2.5" />;
    if (statusUpper === "COMPLETED" || statusUpper === "COMPLETE")
      return <CheckCircle2 className="w-2.5 h-2.5" />;
    if (statusUpper.includes("PROGRESS"))
      return <Loader2 className="w-2.5 h-2.5" />;
    if (statusUpper === "PENDING" || statusUpper === "DRAFT")
      return <AlertTriangle className="w-2.5 h-2.5" />;
    if (statusUpper === "INCOMPLETE") return <Clock className="w-2.5 h-2.5" />;

    return <FileText className="w-2.5 h-2.5" />;
  };

  const clearSearch = () => {
    setSearchQuery("");
  };

  useEffect(() => {
    const handleRefreshEvent = async () => {
      const tokenObj = await window.electronAPI.getToken?.();
      const activeToken = tokenObj?.refreshToken || tokenObj?.token;
      fetchAllReports(activeToken);
    };

    window.addEventListener("refreshReportsTable", handleRefreshEvent);

    const handleClickOutside = () => {
      setDropdownOpen(null);
    };

    document.addEventListener("click", handleClickOutside);

    return () => {
      window.removeEventListener("refreshReportsTable", handleRefreshEvent);
      document.removeEventListener("click", handleClickOutside);
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 py-3 px-3">
      <div className="mx-auto flex flex-col gap-3">
        {/* Header Section - Made more compact */}
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-bold text-gray-900">
              {translate("title", "Reports Management")}
            </h1>
            <p className="text-xs text-gray-600">
              {translate("subtitle", "View and manage all reports")}
            </p>
          </div>
          <button
            type="button"
            onClick={fetchAllReports}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-100 text-gray-800 text-xs font-semibold hover:bg-gray-200 border border-gray-200"
          >
            <RefreshCcw className="w-3 h-3" />
            {quickTranslate("reports.refresh.refresh", "Refresh")}
          </button>
        </div>

        {/* Search and Filter Bar - Made more compact */}
        <div className="bg-white border border-gray-200 rounded-md p-3 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            {/* Search Input */}
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
                <Search className="h-3.5 w-3.5 text-gray-400" />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={translate(
                  "searchPlaceholder",
                  "Search by Report ID...",
                )}
                className="w-full pl-8 pr-7 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
              {searchQuery && (
                <button
                  onClick={clearSearch}
                  className="absolute inset-y-0 right-0 pr-2 flex items-center"
                >
                  <X className="h-3.5 w-3.5 text-gray-400 hover:text-gray-600" />
                </button>
              )}
            </div>

            {/* Status Filter - Made more compact */}
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-gray-400" />
              <div className="flex bg-gray-100 rounded-md p-0.5 gap-0.5">
                <button
                  onClick={() => setStatusFilter("all")}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${statusFilter === "all" ? "bg-white shadow-sm text-gray-900" : "text-gray-600 hover:text-gray-900"}`}
                >
                  {translate("filters.all", "All")}
                </button>
                <button
                  onClick={() => setStatusFilter("pending")}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${statusFilter === "pending" ? "bg-white shadow-sm text-amber-600" : "text-gray-600 hover:text-gray-900"}`}
                >
                  {translate("filters.pending", "Pending")}
                </button>
                <button
                  onClick={() => setStatusFilter("completed")}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${statusFilter === "completed" ? "bg-white shadow-sm text-emerald-600" : "text-gray-600 hover:text-gray-900"}`}
                >
                  {translate("filters.completed", "Completed")}
                </button>
                <button
                  onClick={() => setStatusFilter("sent")}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${statusFilter === "sent" ? "bg-white shadow-sm text-purple-600" : "text-gray-600 hover:text-gray-900"}`}
                >
                  {translate("filters.sent", "Sent")}
                </button>
              </div>
            </div>

            {/* Page Size */}
            <div className="w-full sm:w-auto">
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(parseInt(e.target.value));
                  setCurrentPage(1);
                }}
                className="w-full sm:w-auto px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
              >
                <option value="10">
                  {translate("perPage", "{{count}} per page", { count: 10 })}
                </option>
                <option value="20">
                  {translate("perPage", "{{count}} per page", { count: 20 })}
                </option>
                <option value="50">
                  {translate("perPage", "{{count}} per page", { count: 50 })}
                </option>
                <option value="100">
                  {translate("perPage", "{{count}} per page", { count: 100 })}
                </option>
              </select>
            </div>
          </div>
        </div>

        {/* Reports Table - Made more compact */}
        <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              <span className="ml-2 text-xs text-gray-600">
                {quickTranslate("reports.loading", "Loading reports...")}
              </span>
            </div>
          ) : error ? (
            <div className="p-6 text-center">
              <AlertTriangle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
              <p className="text-xs text-rose-600 mb-2">{error}</p>
              <button
                onClick={() => fetchAllReports()}
                className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 font-medium"
              >
                {translate("actions.retry", "Retry")}
              </button>
            </div>
          ) : (
            <>
              {(searchQuery || statusFilter !== "all") && (
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-600">
                  {translate(
                    "filteredSummary",
                    "Showing {{filtered}} of {{total}} reports",
                    {
                      filtered: filteredReports.length,
                      total: allReports.length,
                    },
                  )}
                  {searchQuery &&
                    ` ${translate("matching", 'matching "{{query}}"', {
                      query: searchQuery,
                    })}`}
                  {statusFilter !== "all" &&
                    ` ${translate("withStatus", "with status: {{status}}", {
                      status: getStatusFilterLabel(statusFilter),
                    })}`}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="upload-report-table min-w-full text-xs">
                  <thead className="bg-gray-50 text-gray-700 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold"></th>
                      <th className="px-3 py-2 text-left font-semibold">
                        {quickTranslate("reports.table.reportId", "Report ID")}
                      </th>
                      <th className="px-3 py-2 text-left font-semibold">
                        {quickTranslate("reports.table.status", "Status")}
                      </th>
                      <th className="px-3 py-2 text-left font-semibold">
                        {quickTranslate("reports.assets.label", "Assets")}
                      </th>
                      <th className="px-3 py-2 text-left font-semibold">
                        {translate("table.createdDate", "Created Date")}
                      </th>
                      <th className="px-3 py-2 text-left font-semibold w-60">
                        {quickTranslate("reports.row.actions", "Actions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredReports.length === 0 ? (
                      <tr>
                        <td
                          colSpan="6"
                          className="px-3 py-6 text-center text-gray-500"
                        >
                          <FileText className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                          <p className="text-xs">
                            {translate("noReportsFound", "No reports found")}
                          </p>
                          {(searchQuery || statusFilter !== "all") && (
                            <button
                              onClick={clearAllFilters}
                              className="mt-1 text-xs text-blue-600 hover:text-blue-800"
                            >
                              {translate(
                                "clearFilters",
                                "Clear filters to see all reports",
                              )}
                            </button>
                          )}
                        </td>
                      </tr>
                    ) : (
                      filteredReports.map((report) => {
                        const isExpanded = expandedReport === report._id;
                        const isHighlighted =
                          highlightReportId &&
                          (highlightReportId === report._id ||
                            highlightReportId === report.report_id);
                        const assetData = getAssetData(report);
                        const status = getReportStatus(report);
                        const statusColor = getStatusColor(status);

                        const isNewReport = status === "New";

                        const isFullCheckLoading = isActionLoading(
                          "fullCheck",
                          report.report_id,
                        );
                        const isHalfCheckLoading = isActionLoading(
                          "halfCheck",
                          report.report_id,
                        );
                        const isRetryLoading = isActionLoading(
                          "retry",
                          report.report_id,
                        );
                        const isSendLoading = isActionLoading(
                          "send",
                          report.report_id,
                        );
                        const isSubmitToTaqeemLoading =
                          submitToTaqeemLoading[report.report_id];

                        const isAnyActionLoading =
                          isFullCheckLoading ||
                          isHalfCheckLoading ||
                          isRetryLoading ||
                          isSendLoading ||
                          isSubmitToTaqeemLoading;
                        const progress = submitProgress[report.report_id];
                        const hasProgress = progress && isSubmitToTaqeemLoading;
                        return (
                          <React.Fragment key={report._id}>
                            <tr
                              data-report-id={report.report_id}
                              className={`${isHighlighted ? "bg-amber-50 ring-1 ring-amber-200" : "hover:bg-gray-50"} transition-colors`}
                            >
                              <td className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => toggleReportExpand(report._id)}
                                  className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-gray-200 text-gray-700 hover:bg-gray-50"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="w-3 h-3" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3" />
                                  )}
                                </button>
                              </td>
                              <td className="px-3 py-2">
                                <p className="font-medium text-gray-900">
                                  {report.report_id || "—"}
                                </p>
                              </td>
                              <td className="px-3 py-2">
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border ${statusColor}`}
                                >
                                  {getStatusIcon(status)}
                                  {getLocalizedStatusLabel(status)}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="inline-flex items-center gap-1">
                                  <Package className="w-3 h-3 text-gray-400" />
                                  <span className="text-gray-700">
                                    {assetData.length}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-gray-600">
                                {formatDate(report.createdAt)}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1">
                                  {/* Dropdown Select */}
                                  <div className="relative flex-1">
                                    <select
                                      value={actionDropdown[report._id] || ""}
                                      onChange={(e) => {
                                        const action = e.target.value;
                                        setActionDropdown((prev) => ({
                                          ...prev,
                                          [report._id]: action,
                                        }));
                                      }}
                                      disabled={isAnyActionLoading}
                                      className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 cursor-pointer appearance-none bg-white"
                                    >
                                      <option value="">
                                        {translate(
                                          "actions.selectAction",
                                          "Select action",
                                        )}
                                      </option>
                                      <option
                                        value="submit-to-taqeem"
                                        disabled={!isNewReport}
                                      >
                                        {quickTranslate(
                                          "reports.row.submitToTaqeem",
                                          "Submit to Taqeem",
                                        )}
                                      </option>
                                      <option value="full-check">
                                        {translate(
                                          "actions.fullCheck",
                                          "Full Check",
                                        )}
                                      </option>
                                      <option value="half-check">
                                        {translate(
                                          "actions.halfCheck",
                                          "Half Check",
                                        )}
                                      </option>
                                      <option value="retry">
                                        {translate("actions.retry", "Retry")}
                                      </option>
                                      <option value="send">
                                        {translate("actions.send", "Send")}
                                      </option>
                                    </select>

                                    {/* Dropdown arrow */}
                                    <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                                      <ChevronDown className="w-3 h-3 text-gray-400" />
                                    </div>
                                  </div>

                                  {/* Go Button */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const action = actionDropdown[report._id];
                                      if (action) {
                                        switch (action) {
                                          case "submit-to-taqeem":
                                            handleSubmitToTaqeem(
                                              report.report_id,
                                            );
                                            break;
                                          case "full-check":
                                            handleFullCheck(
                                              report.report_id,
                                              report,
                                            );
                                            break;
                                          case "half-check":
                                            handleHalfCheck(
                                              report.report_id,
                                              report,
                                            );
                                            break;
                                          case "retry":
                                            handleRetry(
                                              report.report_id,
                                              report,
                                            );
                                            break;
                                          case "send":
                                            handleSend(
                                              report.report_id,
                                              report,
                                            );
                                            break;
                                        }
                                        // Clear the dropdown selection after clicking Go
                                        setActionDropdown((prev) => {
                                          const next = { ...prev };
                                          delete next[report._id];
                                          return next;
                                        });
                                      }
                                    }}
                                    disabled={
                                      !actionDropdown[report._id] ||
                                      isAnyActionLoading
                                    }
                                    className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed min-w-[40px]"
                                  >
                                    {(() => {
                                      const action = actionDropdown[report._id];
                                      if (!action) {
                                        return quickTranslate(
                                          "reports.row.go",
                                          "Go",
                                        );
                                      }

                                      if (
                                        action === "submit-to-taqeem" &&
                                        isSubmitToTaqeemLoading
                                      )
                                        return quickTranslate(
                                          "reports.row.working",
                                          "Working...",
                                        );
                                      if (
                                        action === "full-check" &&
                                        isFullCheckLoading
                                      )
                                        return quickTranslate(
                                          "reports.row.working",
                                          "Working...",
                                        );
                                      if (
                                        action === "half-check" &&
                                        isHalfCheckLoading
                                      )
                                        return quickTranslate(
                                          "reports.row.working",
                                          "Working...",
                                        );
                                      if (action === "retry" && isRetryLoading)
                                        return quickTranslate(
                                          "reports.row.working",
                                          "Working...",
                                        );
                                      if (action === "send" && isSendLoading)
                                        return quickTranslate(
                                          "reports.row.working",
                                          "Working...",
                                        );
                                      return quickTranslate(
                                        "reports.row.go",
                                        "Go",
                                      );
                                    })()}
                                  </button>
                                </div>
                              </td>
                            </tr>

                            {hasProgress && (
                              <tr>
                                <td
                                  colSpan="6"
                                  className="px-3 py-0 bg-blue-50 border-t border-blue-200"
                                >
                                  <div className="py-2 space-y-2">
                                    {/* Progress info */}
                                    <div>
                                      <div className="flex items-center justify-between mb-1">
                                        <div className="flex items-center gap-2">
                                          {flowPaused[report.report_id] ? (
                                            <svg
                                              className="w-3 h-3 text-amber-600"
                                              fill="currentColor"
                                              viewBox="0 0 20 20"
                                            >
                                              <path
                                                fillRule="evenodd"
                                                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z"
                                                clipRule="evenodd"
                                              />
                                            </svg>
                                          ) : (
                                            <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
                                          )}
                                          <span className="text-xs font-medium text-blue-900">
                                            {flowPaused[report.report_id]
                                              ? translate(
                                                  "actions.paused",
                                                  "Paused",
                                                )
                                              : progress.message ||
                                                translate(
                                                  "actions.processing",
                                                  "Processing...",
                                                )}
                                          </span>
                                        </div>
                                        <span className="text-xs font-semibold text-blue-900">
                                          {progress.current}/{progress.total} (
                                          {Math.round(progress.percentage)}%)
                                        </span>
                                      </div>
                                      <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
                                        <div
                                          className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
                                          style={{
                                            width: `${progress.percentage}%`,
                                          }}
                                        />
                                      </div>
                                    </div>

                                    {/* Control buttons */}
                                    <div className="flex items-center gap-1.5">
                                      {!flowPaused[report.report_id] ? (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handlePauseFlow(report.report_id);
                                          }}
                                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-600 bg-amber-50 text-amber-700 text-xs font-semibold hover:bg-amber-100 transition-colors"
                                        >
                                          <svg
                                            className="w-2.5 h-2.5"
                                            fill="currentColor"
                                            viewBox="0 0 20 20"
                                          >
                                            <path
                                              fillRule="evenodd"
                                              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z"
                                              clipRule="evenodd"
                                            />
                                          </svg>
                                          {translate("actions.pause", "Pause")}
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleResumeFlow(report.report_id);
                                          }}
                                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-green-600 bg-green-50 text-green-700 text-xs font-semibold hover:bg-green-100 transition-colors"
                                        >
                                          <svg
                                            className="w-2.5 h-2.5"
                                            fill="currentColor"
                                            viewBox="0 0 20 20"
                                          >
                                            <path
                                              fillRule="evenodd"
                                              d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                                              clipRule="evenodd"
                                            />
                                          </svg>
                                          {translate("actions.resume", "Resume")}
                                        </button>
                                      )}

                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleStopFlow(report.report_id);
                                        }}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-600 bg-red-50 text-red-700 text-xs font-semibold hover:bg-red-100 transition-colors"
                                      >
                                        <svg
                                          className="w-2.5 h-2.5"
                                          fill="currentColor"
                                          viewBox="0 0 20 20"
                                        >
                                          <path
                                            fillRule="evenodd"
                                            d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z"
                                            clipRule="evenodd"
                                          />
                                        </svg>
                                        {translate("actions.stop", "Stop")}
                                      </button>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}

                            {isExpanded && (
                              <tr>
                                <td
                                  colSpan="6"
                                  className="bg-gray-50 border-t border-gray-200"
                                >
                                  <div className="px-3 py-2">
                                    <div className="bg-white border border-gray-200 rounded-md overflow-hidden">
                                      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                                        <div className="flex items-center gap-1.5">
                                          <Table className="w-3 h-3 text-gray-600" />
                                          <h4 className="text-xs font-semibold text-gray-900">
                                            {translate(
                                              "assetsSection.title",
                                              "Assets in Report",
                                            )}
                                          </h4>
                                          <span className="text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded-full">
                                            {translate(
                                              "assetsSection.count",
                                              "{{count}} assets",
                                              { count: assetData.length },
                                            )}
                                          </span>
                                        </div>
                                        <div className="text-xs text-gray-500">
                                          {quickTranslate(
                                            "reports.table.reportId",
                                            "Report ID",
                                          )}
                                          : {report.report_id}
                                        </div>
                                      </div>

                                      {/* Asset Filter Buttons */}
                                      <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
                                        <div className="flex items-center gap-1.5">
                                          <span className="text-xs font-medium text-gray-600">
                                            {quickTranslate(
                                              "reports.filter.label",
                                              "Filter:",
                                            )}
                                          </span>
                                          <div className="flex bg-gray-100 rounded-md p-0.5 gap-0.5">
                                            <button
                                              onClick={() =>
                                                setAssetFilter("all")
                                              }
                                              className={`px-2 py-1 text-xs font-medium rounded transition-colors ${assetFilter === "all" ? "bg-white shadow-sm text-gray-900" : "text-gray-600 hover:text-gray-900"}`}
                                            >
                                              {translate("filters.all", "All")}
                                            </button>
                                            <button
                                              onClick={() =>
                                                setAssetFilter("completed")
                                              }
                                              className={`px-2 py-1 text-xs font-medium rounded transition-colors ${assetFilter === "completed" ? "bg-white shadow-sm text-emerald-600" : "text-gray-600 hover:text-gray-900"}`}
                                            >
                                              {translate(
                                                "assetsSection.submitted",
                                                "Submitted",
                                              )}
                                            </button>
                                            <button
                                              onClick={() =>
                                                setAssetFilter("incomplete")
                                              }
                                              className={`px-2 py-1 text-xs font-medium rounded transition-colors ${assetFilter === "incomplete" ? "bg-white shadow-sm text-amber-600" : "text-gray-600 hover:text-gray-900"}`}
                                            >
                                              {translate(
                                                "filters.pending",
                                                "Pending",
                                              )}
                                            </button>
                                          </div>
                                        </div>
                                      </div>

                                      <div className="overflow-x-auto">
                                        <table className="upload-report-table min-w-full text-xs">
                                          <thead className="bg-gray-50 text-gray-500 uppercase">
                                            <tr>
                                              <th className="px-3 py-1.5 text-left font-semibold">
                                                {translate(
                                                  "table.assetId",
                                                  "Asset ID",
                                                )}
                                              </th>
                                              <th className="px-3 py-1.5 text-left font-semibold">
                                                {translate("table.name", "Name")}
                                              </th>
                                              <th className="px-3 py-1.5 text-left font-semibold">
                                                {translate(
                                                  "table.inspectionDate",
                                                  "Inspection Date",
                                                )}
                                              </th>
                                              <th className="px-3 py-1.5 text-left font-semibold">
                                                {translate("table.value", "Value")}
                                              </th>
                                              <th className="px-3 py-1.5 text-left font-semibold">
                                                {translate(
                                                  "table.submitState",
                                                  "Submit State",
                                                )}
                                              </th>
                                              <th className="px-3 py-1.5 text-left font-semibold">
                                                {quickTranslate(
                                                  "reports.row.actions",
                                                  "Actions",
                                                )}
                                              </th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {(() => {
                                              let filteredAssets = [
                                                ...assetData,
                                              ];

                                              if (assetFilter === "completed") {
                                                filteredAssets =
                                                  assetData.filter(
                                                    (asset) =>
                                                      asset.submitState === 1,
                                                  );
                                              } else if (
                                                assetFilter === "incomplete"
                                              ) {
                                                filteredAssets =
                                                  assetData.filter(
                                                    (asset) =>
                                                      asset.submitState !== 1,
                                                  );
                                              }

                                              if (filteredAssets.length === 0) {
                                                return (
                                                  <tr>
                                                    <td
                                                      colSpan="6"
                                                      className="px-3 py-3 text-center text-gray-500"
                                                    >
                                                      <Package className="w-6 h-6 mx-auto mb-1 text-gray-300" />
                                                      <p className="text-xs">
                                                        {assetFilter === "all"
                                                          ? translate(
                                                              "assetsEmpty.all",
                                                              "No assets found in this report",
                                                            )
                                                          : assetFilter ===
                                                              "completed"
                                                            ? translate(
                                                                "assetsEmpty.completed",
                                                                "No completed assets found",
                                                              )
                                                            : translate(
                                                                "assetsEmpty.pending",
                                                                "No pending assets found",
                                                              )}
                                                      </p>
                                                    </td>
                                                  </tr>
                                                );
                                              }

                                              return filteredAssets.map(
                                                (asset) => (
                                                  <tr
                                                    key={asset.internal_uid}
                                                    className="border-t hover:bg-gray-50"
                                                  >
                                                    <td className="px-3 py-1.5">
                                                      <span className="font-mono text-gray-900">
                                                        {asset.id || "—"}
                                                      </span>
                                                    </td>
                                                    <td className="px-3 py-1.5 text-gray-700">
                                                      {asset.asset_name || "—"}
                                                    </td>
                                                    <td className="px-3 py-1.5">
                                                      <span className="bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-xs">
                                                        {asset.inspection_date ||
                                                          "—"}
                                                      </span>
                                                    </td>
                                                    <td className="px-3 py-1.5">
                                                      <span className="font-medium">
                                                        {formatCurrency(
                                                          asset.final_value,
                                                        )}
                                                      </span>
                                                    </td>
                                                    <td className="px-3 py-1.5">
                                                      <span
                                                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium border ${
                                                          asset.submitState ===
                                                          1
                                                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                                            : "border-amber-200 bg-amber-50 text-amber-700"
                                                        }`}
                                                      >
                                                        {asset.submitState ===
                                                        1 ? (
                                                          <CheckCircle2 className="w-2.5 h-2.5" />
                                                        ) : (
                                                          <Clock className="w-2.5 h-2.5" />
                                                        )}
                                                        {asset.submitState === 1
                                                          ? translate(
                                                              "assetsSection.submitted",
                                                              "Submitted",
                                                            )
                                                          : translate(
                                                              "status.pending",
                                                              "Pending",
                                                            )}
                                                      </span>
                                                    </td>
                                                    <td className="px-3 py-1.5">
                                                      <button
                                                        type="button"
                                                        onClick={() =>
                                                          handleOpenEdit(
                                                            asset,
                                                            report._id,
                                                          )
                                                        }
                                                        className="text-xs text-blue-600 hover:text-blue-800 hover:underline font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                                        disabled={
                                                          editLoading[
                                                            asset.internal_uid
                                                          ]
                                                        }
                                                      >
                                                        {editLoading[
                                                          asset.internal_uid
                                                        ] ? (
                                                          <Loader2 className="w-3 h-3 animate-spin" />
                                                        ) : (
                                                          quickTranslate(
                                                            "reports.row.edit",
                                                            "Edit",
                                                          )
                                                        )}
                                                      </button>
                                                    </td>
                                                  </tr>
                                                ),
                                              );
                                            })()}
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
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination - Made more compact */}
              {filteredReports.length > 0 && (
                <div className="px-3 py-2 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
                  <div className="text-xs text-gray-600">
                    {quickTranslate(
                      "reports.pagination.summary",
                      "Showing {{from}} to {{to}} of {{total}} reports",
                      {
                        from: (currentPage - 1) * pageSize + 1,
                        to: Math.min(currentPage * pageSize, totalItems),
                        total: totalItems,
                      },
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1}
                      className="inline-flex items-center justify-center w-6 h-6 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-3 h-3" />
                    </button>

                    <div className="flex items-center gap-0.5 mx-1">
                      {Array.from(
                        { length: Math.min(5, totalPages) },
                        (_, i) => {
                          let pageNum;
                          if (totalPages <= 5) {
                            pageNum = i + 1;
                          } else if (currentPage <= 3) {
                            pageNum = i + 1;
                          } else if (currentPage >= totalPages - 2) {
                            pageNum = totalPages - 4 + i;
                          } else {
                            pageNum = currentPage - 2 + i;
                          }

                          return (
                            <button
                              key={pageNum}
                              type="button"
                              onClick={() => handlePageChange(pageNum)}
                              className={`w-6 h-6 rounded text-xs font-medium ${
                                currentPage === pageNum
                                  ? "bg-blue-600 text-white border-blue-600"
                                  : "border border-gray-300 bg-white hover:bg-gray-50 text-gray-700"
                              }`}
                            >
                              {pageNum}
                            </button>
                          );
                        },
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className="inline-flex items-center justify-center w-6 h-6 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronRightIcon className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Edit Asset Modal */}
      {editModalOpen && selectedAsset && (
        <EditAssetModal
          asset={selectedAsset}
          reportId={selectedReportId}
          isOpen={editModalOpen}
          onClose={() => {
            setEditModalOpen(false);
            setSelectedAsset(null);
            setSelectedReportId(null);
          }}
          onSave={() => {
            fetchAllReports();
          }}
        />
      )}
    </div>
  );
};

export default ReportsTable;
