import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRam } from "./RAMContext";

const ElrajhiUploadContext = createContext(null);

export const useElrajhiUpload = () => {
    const ctx = useContext(ElrajhiUploadContext);
    if (!ctx) {
        throw new Error("useElrajhiUpload must be used within ElrajhiUploadProvider");
    }
    return ctx;
};

const defaultRememberedFiles = {
    mainExcel: null,
    mainPdfs: [],
    validationExcel: null,
    validationPdfs: [],
};

export const ElrajhiUploadProvider = ({ children }) => {
    // All state is in-memory only (clears on logout/app restart).
    const { ramInfo } = useRam();
    const [activeTab, setActiveTab] = useState("no-validation");
    const [numTabs, setNumTabs] = useState(1);

    const [excelFile, setExcelFile] = useState(null);
    const [pdfFiles, setPdfFiles] = useState([]);
    const [validationFolderFiles, setValidationFolderFiles] = useState([]);
    const [validationExcelFile, setValidationExcelFile] = useState(null);
    const [validationPdfFiles, setValidationPdfFiles] = useState([]);

    const [batchId, setBatchId] = useState("");
    const [excelResult, setExcelResult] = useState(null);
    const [downloadPath, setDownloadPath] = useState(null);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const [validationReports, setValidationReports] = useState([]);
    const [marketAssets, setMarketAssets] = useState([]);
    const [validationMessage, setValidationMessage] = useState(null);
    const [validationDownloadPath, setValidationDownloadPath] = useState(null);

    const [rememberedFiles, setRememberedFiles] = useState(defaultRememberedFiles);
    const [sendingTaqeem, setSendingTaqeem] = useState(false);
    const [sendingValidation, setSendingValidation] = useState(false);
    const [loadingValuers, setLoadingValuers] = useState(false);

    useEffect(() => {
        if (!ramInfo?.recommendedTabs) return;

        setNumTabs((prev) => {
            // Only auto-set if still at default (1)
            if (prev !== 1) return prev;
            return ramInfo.recommendedTabs;
        });
    }, [ramInfo?.recommendedTabs]);


    // Clean any legacy persisted keys from previous versions so nothing lingers after restart/logout.
    useEffect(() => {
        try {
            if (typeof window !== "undefined" && window.localStorage) {
                Object.keys(window.localStorage).forEach((key) => {
                    if (key.startsWith("elrajhi:")) {
                        window.localStorage.removeItem(key);
                    }
                });
            }
            if (typeof window !== "undefined" && window.sessionStorage) {
                Object.keys(window.sessionStorage).forEach((key) => {
                    if (key.startsWith("elrajhi:")) {
                        window.sessionStorage.removeItem(key);
                    }
                });
            }
        } catch (err) {
            console.warn("Could not clear legacy Elrajhi storage", err);
        }
    }, []);

    const resetAllFiles = () => {
        setExcelFile(null);
        setPdfFiles([]);
        setValidationFolderFiles([]);
        setValidationExcelFile(null);
        setValidationPdfFiles([]);
    };

    const resetMainFlow = () => {
        setBatchId("");
        setExcelResult(null);
        setDownloadPath(null);
        setError("");
        setSuccess("");
        setNumTabs(1);
        setSendingTaqeem(false);
        setRememberedFiles((prev) => ({
            ...prev,
            mainExcel: null,
            mainPdfs: [],
        }));
    };

    const resetValidationFlow = () => {
        setValidationReports([]);
        setMarketAssets([]);
        setValidationMessage(null);
        setValidationDownloadPath(null);
        setSendingValidation(false);
        setLoadingValuers(false);
        setRememberedFiles((prev) => ({
            ...prev,
            validationExcel: null,
            validationPdfs: [],
        }));
    };

    const value = useMemo(
        () => ({
            activeTab,
            setActiveTab,
            excelFile,
            setExcelFile,
            pdfFiles,
            setPdfFiles,
            validationFolderFiles,
            setValidationFolderFiles,
            validationExcelFile,
            setValidationExcelFile,
            validationPdfFiles,
            setValidationPdfFiles,
            resetAllFiles,
            batchId,
            setBatchId,
            excelResult,
            setExcelResult,
            downloadPath,
            setDownloadPath,
            error,
            setError,
            success,
            setSuccess,
            validationReports,
            setValidationReports,
            marketAssets,
            setMarketAssets,
            validationMessage,
            setValidationMessage,
            validationDownloadPath,
            setValidationDownloadPath,
            rememberedFiles,
            setRememberedFiles,
            sendingTaqeem,
            setSendingTaqeem,
            sendingValidation,
            setSendingValidation,
            loadingValuers,
            setLoadingValuers,
            resetMainFlow,
            resetValidationFlow,
        }),
        [
            activeTab,
            excelFile,
            pdfFiles,
            validationFolderFiles,
            validationExcelFile,
            validationPdfFiles,
            batchId,
            excelResult,
            downloadPath,
            error,
            success,
            validationReports,
            marketAssets,
            validationMessage,
            validationDownloadPath,
            rememberedFiles,
            sendingTaqeem,
            sendingValidation,
            loadingValuers,
        ]
    );

    return (
        <ElrajhiUploadContext.Provider value={value}>
            {children}
        </ElrajhiUploadContext.Provider>
    );
};

export default ElrajhiUploadContext;
