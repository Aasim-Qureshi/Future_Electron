// hooks/useAuthAction.js
import { useState, useCallback } from "react";
import { useSession } from "../context/SessionContext";
import { useNavStatus } from "../context/NavStatusContext";
import { useValueNav } from "../context/ValueNavContext";
import { ensureTaqeemAuthorized } from "../../shared/helper/taqeemAuthWrap";
import { useSystemControl } from "../context/SystemControlContext";
import { deductPoints } from "../utils/points";

const isTaqeemAuthSuccess = (authStatus) => {
  if (authStatus === true) return true;
  if (authStatus?.success === true) return true;
  const status = String(authStatus?.status || "").toUpperCase();
  return (
    status === "SUCCESS" ||
    status === "CHECK" ||
    status === "AUTHORIZED" ||
    status === "SYNCED" ||
    status === "LOGIN_SUCCESS" ||
    status === "NORMAL_ACCOUNT" ||
    status === "BOOTSTRAP_GRANTED"
  );
};

export const useAuthAction = () => {
  const { token, login, isGuest, user } = useSession();
  const { taqeemStatus, setTaqeemStatus } = useNavStatus();
  const { systemState } = useSystemControl();
  const { selectedCompany } = useValueNav();

  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState(null);

  const executeWithAuth = useCallback(
    async (action, actionParams = {}, options = {}) => {
      const {
        requiredPoints = 1,
        deductPoints: deductPointsOption = 0,
        showInsufficientPointsModal = () => {},
        onAuthSuccess = () => {},
        onAuthFailure = () => {},
        onViewChange = null,
        skipAuth = false,
        /** When true, do not enqueue navigate-to-company before the action */
        skipNavigateToCompany = true,
      } = options;

      console.log("[useAuthAction] executeWithAuth called");
      setAuthLoading(true);
      setAuthError(null);

      try {
        if (skipAuth) {
          console.log(
            "[useAuthAction] skipAuth=true → executing action directly",
          );
          return await action(actionParams);
        }

        const isTaqeemLoggedIn = taqeemStatus?.state === "success";
        const guestSession = isGuest || !token;
        const selectedCompanyOfficeId =
          selectedCompany?.officeId || selectedCompany?.office_id || null;

        console.log("[useAuthAction] auth context", {
          hasToken: !!token,
          isGuest,
          guestSession,
          taqeemLoggedIn: isTaqeemLoggedIn,
          requiredPoints,
          guestAccessEnabled: systemState?.guestAccessEnabled,
        });

        console.log("[useAuthAction] calling ensureTaqeemAuthorized");

        const authStatus = await ensureTaqeemAuthorized(
          token,
          onViewChange,
          isTaqeemLoggedIn,
          requiredPoints,
          login,
          setTaqeemStatus,
          {
            isGuest: guestSession,
            guestAccessEnabled: systemState?.guestAccessEnabled ?? true,
            cachedUser: user || null,
            selectedCompanyOfficeId,
            disableAppAuthRedirects: true,
          },
        );

        console.log("[useAuthAction] authStatus returned", authStatus);

        if (authStatus?.status === "INSUFFICIENT_POINTS") {
          console.log("[useAuthAction] insufficient points");
          const required =
            Number(authStatus?.required ?? authStatus?.requiredPoints ?? requiredPoints) ||
            Number(requiredPoints) ||
            0;
          const availableRaw = Number(
            authStatus?.available ?? authStatus?.remainingPoints,
          );
          const available = Number.isFinite(availableRaw) ? availableRaw : undefined;
          showInsufficientPointsModal({
            requiredPoints: required || undefined,
            availablePoints: available,
            assetCount: required || undefined,
            customMessage: authStatus?.message || authStatus?.reason,
          });
          onAuthFailure("INSUFFICIENT_POINTS");
          return null;
        }

        if (authStatus?.status === "LOGIN_REQUIRED") {
          console.log("[useAuthAction] login required");
          onAuthFailure("LOGIN_REQUIRED");
          return null;
        }

        if (!isTaqeemAuthSuccess(authStatus)) {
          const failureReason =
            authStatus?.status ||
            authStatus?.reason ||
            authStatus?.error ||
            "TAQEEM_AUTH_REQUIRED";
          const failureMessage =
            authStatus?.message || authStatus?.error || "Taqeem authorization failed";
          console.log("[useAuthAction] auth failed", {
            failureReason,
            failureMessage,
            authStatus,
          });
          setAuthError(failureMessage);
          onAuthFailure(failureReason);
          return null;
        }

        const activeToken = authStatus?.token || token;
        actionParams.token = activeToken;

        console.log("[useAuthAction] auth success, token attached to action");
        onAuthSuccess(authStatus);

        if (
          !skipNavigateToCompany &&
          selectedCompany &&
          window?.electronAPI?.navigateToCompany
        ) {
          console.log(
            "[useAuthAction] navigating to company",
            selectedCompany.name,
          );

          try {
            const officeId =
              selectedCompany.officeId || selectedCompany.office_id;
            const companyUrl =
              (selectedCompany.url && String(selectedCompany.url).trim()) ||
              (officeId
                ? `https://qima.taqeem.gov.sa/organization/show/${officeId}`
                : "");
            await window.electronAPI.navigateToCompany({
              name: selectedCompany.name,
              url: companyUrl || selectedCompany.url,
              officeId,
              sectorId: selectedCompany.sectorId || selectedCompany.sector_id,
              skipNavigation: false,
            });

            console.log("[useAuthAction] navigation complete");
          } catch (err) {
            console.warn(
              "[useAuthAction] navigateToCompany failed/skipped",
              err?.message || err,
            );
          }
        }

        console.log("[useAuthAction] executing action");
        const actionResult = await action(actionParams);

        let deductionAmount = 0;
        let deductionMeta = {};
        const deductionValue =
          typeof deductPointsOption === "function"
            ? deductPointsOption(actionResult)
            : deductPointsOption;

        if (deductionValue !== null && deductionValue !== undefined) {
          if (typeof deductionValue === "object") {
            deductionAmount = Number(deductionValue.amount) || 0;
            deductionMeta = { ...deductionValue };
            delete deductionMeta.amount;
          } else {
            deductionAmount = Number(deductionValue) || 0;
          }
        }

        if (activeToken && Number.isFinite(deductionAmount) && deductionAmount > 0) {
          try {
            await deductPoints(activeToken, deductionAmount, deductionMeta);
          } catch (deductErr) {
            console.error("[useAuthAction] point deduction failed", deductErr);
          }
        }

        return actionResult;
      } catch (error) {
        console.error("[useAuthAction] error during execution", error);
        setAuthError(error?.message || String(error));
        onAuthFailure(error);
        return null;
      } finally {
        console.log("[useAuthAction] execution finished");
        setAuthLoading(false);
      }
    },
    [
      token,
      login,
      taqeemStatus,
      setTaqeemStatus,
      isGuest,
      user,
      systemState?.guestAccessEnabled,
      selectedCompany,
    ],
  );

  return {
    executeWithAuth,
    authLoading,
    authError,
    clearAuthError: () => setAuthError(null),
  };
};
