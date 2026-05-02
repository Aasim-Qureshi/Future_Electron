import React from "react";
import { X } from "lucide-react"; // Add X icon import
import navigation from "../constants/navigation";

const { DEFAULT_HOME_VIEW } = navigation;

const InsufficientPointsModal = ({ viewChange, onClose, details = {} }) => {
    const { assetCount, requiredPoints, availablePoints, customMessage } = details;
    const hasAssetCount = Number.isFinite(assetCount) && assetCount > 0;
    const requiredLabel = Number.isFinite(requiredPoints)
        ? `${requiredPoints} point${requiredPoints === 1 ? '' : 's'}`
        : 'enough points';
    const assetLabel = hasAssetCount
        ? `${assetCount} asset${assetCount === 1 ? '' : 's'}`
        : 'items';
    const availableLabel = Number.isFinite(availablePoints) ? `${availablePoints} available` : '';
    const mainMessage = customMessage
        ? customMessage
        : `You need ${requiredLabel}${hasAssetCount ? ` for ${assetLabel}` : ''} to continue.`;
    const secondaryMessage = availableLabel
        ? `You currently have ${availableLabel}.`
        : "You can continue from the reports upload area.";
    return (
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 relative border border-gray-200">
            {/* Close button */}
            <button
                onClick={onClose}
                className="absolute top-3 right-3 p-1 rounded-full hover:bg-gray-100 transition-colors"
                aria-label="Close"
            >
                <X className="w-4 h-4 text-gray-500" />
            </button>

            <h3 className="text-lg font-semibold text-gray-900 pr-6">
                Insufficient points
            </h3>

            <p className="mt-2 text-sm text-gray-600">
                {mainMessage}
            </p>
            <p className="mt-1 text-xs text-gray-500">
                {secondaryMessage}
            </p>

            <div className="mt-5 flex gap-3">
                <button
                    className="flex-1 rounded-xl px-4 py-2 font-medium border border-gray-300 hover:bg-gray-50 transition"
                    onClick={onClose}
                >
                    Cancel
                </button>
                <button
                    className="flex-1 rounded-xl px-4 py-2 font-medium bg-blue-600 text-white hover:bg-blue-700 transition"
                    onClick={() => {
                        onClose(); // Close modal first
                        viewChange(DEFAULT_HOME_VIEW);
                    }}
                >
                    Go to reports
                </button>
            </div>
        </div>
    );
};

export default InsufficientPointsModal;
