import React, { useState } from "react";
import { RefreshCw, CheckCircle, XCircle, AlertCircle } from "lucide-react";

const CheckBrowser = () => {
    const [isChecking, setIsChecking] = useState(false);
    const [browserStatus, setBrowserStatus] = useState({
        status: null,
        isOpen: null,
        message: "Check browser status"
    });

    // Mock API functions that will call Electron's exposed API
    const checkBrowserStatus = async () => {
        return await window.electronAPI.checkStatus();
    };

    const handleCheckBrowser = async () => {
        setIsChecking(true);
        setBrowserStatus({
            isOpen: null,
            message: "Checking browser status..."
        });

        const result = await checkBrowserStatus();
        console.log("Browser status result:", result);

        setBrowserStatus({
            status: result.status,
            isOpen: result.browserOpen,
            message: result.message,
            error: result.error
        });

        setIsChecking(false);
    };

    const getStatusIcon = () => {
        if (browserStatus.isOpen === true) {
            if (browserStatus.status === 'NOT_LOGGED_IN' || browserStatus.status === 'not_logged_in') {
                return <AlertCircle className="w-8 h-8 text-orange-500" />;
            }
            // Check for both 'SUCCESS' and 'success'
            if (browserStatus.status === 'SUCCESS' || browserStatus.status === true) {
                return <CheckCircle className="w-8 h-8 text-green-600" />;
            }
            return <CheckCircle className="w-8 h-8 text-green-600" />; // Default to success if browser is open
        } else if (browserStatus.isOpen === false) {
            return browserStatus.error ? (
                <AlertCircle className="w-8 h-8 text-orange-500" />
            ) : (
                <XCircle className="w-8 h-8 text-red-600" />
            );
        }
        return <RefreshCw className="w-8 h-8 text-gray-400" />;
    };

    const getStatusColor = () => {
        if (browserStatus.isOpen === true) {
            if (browserStatus.status === 'NOT_LOGGED_IN' || browserStatus.status === 'not_logged_in') {
                return "text-orange-500";
            }
            // Check for both 'SUCCESS' and 'success'
            if (browserStatus.status === 'SUCCESS' || browserStatus.status === true) {
                return "text-green-600";
            }
            return "text-green-600"; // Default to success color
        }
        if (browserStatus.isOpen === false) {
            return browserStatus.error ? "text-orange-500" : "text-red-600";
        }
        return "text-gray-400";
    };

    const getStatusText = () => {
        if (browserStatus.isOpen === true) {
            if (browserStatus.status === 'NOT_LOGGED_IN' || browserStatus.status === 'not_logged_in') {
                return "Browser Open - Not Logged In";
            }
            // Check for both 'SUCCESS' and 'success'
            if (browserStatus.status === 'SUCCESS' || browserStatus.status === true) {
                return "Browser is Open & Logged In";
            }
            return "Browser is Open & Logged In"; // Default to logged in
        }
        if (browserStatus.isOpen === false) {
            return browserStatus.error ? "Browser Issue" : "Browser is Closed";
        }
        return "Check Browser Status";
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-8">
            <div className="max-w-4xl mx-auto px-4">
                {/* Header */}
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-800 mb-2">🌐 Check Browser</h1>
                    <p className="text-gray-600">Check browser status and monitor resource usage</p>
                </div>

                {/* Main Content */}
                <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
                    <div className="text-center">
                        {/* Status Icon */}
                        <div className="mb-4">
                            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto">
                                {getStatusIcon()}
                            </div>
                        </div>

                        {/* Status Text */}
                        <h2 className={`text-2xl font-bold mb-2 ${getStatusColor()}`}>
                            {getStatusText()}
                        </h2>

                        {/* Status Message */}
                        <p className="text-gray-600 mb-4">
                            {browserStatus.message}
                        </p>

                        {/* Error Display */}
                        {browserStatus.error && (
                            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 mb-4">
                                <div className="flex items-center gap-2 justify-center">
                                    <AlertCircle className="w-4 h-4 text-orange-500" />
                                    <span className="text-orange-700 text-sm">{browserStatus.error}</span>
                                </div>
                            </div>
                        )}

                        {/* Detailed Status Info */}
                        {browserStatus.isOpen !== null && (
                            <div className="bg-gray-50 rounded-lg p-3 mb-4">
                                <div className="text-sm text-gray-600">
                                    <div className="flex justify-between">
                                        <span>Browser:</span>
                                        <span className={
                                            browserStatus.isOpen
                                                ? ((browserStatus.status === 'NOT_LOGGED_IN' || browserStatus.status === 'not_logged_in') ? "text-orange-600 font-medium" : "text-green-600 font-medium")
                                                : "text-red-600 font-medium"
                                        }>
                                            {browserStatus.isOpen ? "Open" : "Closed"}
                                        </span>
                                    </div>
                                    <div className="flex justify-between mt-1">
                                        <span>Authentication:</span>
                                        <span className={
                                            browserStatus.status === 'SUCCESS' || browserStatus.status === true
                                                ? "text-green-600 font-medium"
                                                : browserStatus.status === 'NOT_LOGGED_IN' || browserStatus.status === 'not_logged_in'
                                                    ? "text-orange-600 font-medium"
                                                    : "text-red-600 font-medium"
                                        }>
                                            {browserStatus.status === 'SUCCESS' || browserStatus.status === true
                                                ? "Logged In"
                                                : browserStatus.status === 'NOT_LOGGED_IN' || browserStatus.status === 'not_logged_in'
                                                    ? "Not Logged In"
                                                    : "Not Authenticated"
                                            }
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Action Button */}
                        <div className="flex justify-center mb-4">
                            <button
                                onClick={handleCheckBrowser}
                                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold flex items-center justify-center gap-2 transition-colors"
                            >
                                {isChecking ? (
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="w-4 h-4" />
                                )}
                                {isChecking ? "Checking..." : "Check Status"}
                            </button>
                        </div>

                        {/* Additional Info */}
                        <p className="text-xs text-gray-500">
                            Click "Check Status" to verify the current browser state.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CheckBrowser;