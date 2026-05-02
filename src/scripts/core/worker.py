import asyncio
import json
import platform
import sys
import traceback
from datetime import datetime

from motor.motor_asyncio import AsyncIOMotorClient

from scripts.core.company_context import set_selected_company
from scripts.core.httpClient import http_get, http_post
from scripts.core.processControl import clear_process, create_process, emit_progress
from scripts.delete.cancelledReportHandler import handle_cancelled_report
from scripts.delete.deleteIncompleteAssets import (
    delete_incomplete_assets_flow,
    pause_delete_incomplete_assets,
    resume_delete_incomplete_assets,
    stop_delete_incomplete_assets,
)
from scripts.delete.reportDelete import (
    delete_multiple_reports_flow,
    delete_report_flow,
    pause_delete_report,
    resume_delete_report,
    stop_delete_report,
)
from scripts.loginFlow.companyNavigate import navigate_to_company
from scripts.loginFlow.getCompanies import get_companies
from scripts.loginFlow.getProfile import get_profile
from scripts.loginFlow.login import startLogin, submitOtp
from scripts.loginFlow.newLogin import public_login_flow
from scripts.loginFlow.register import register_user
from scripts.submission.checkMacroStatus import (
    RunCheckMacroStatus,
    RunHalfCheckMacroStatus,
    pause_full_check,
    pause_half_check,
    resume_full_check,
    resume_half_check,
    stop_full_check,
    stop_half_check,
)
from scripts.submission.completeFlow import (
    pause_complete_flow,
    resume_complete_flow,
    run_complete_report_flow,
    stop_complete_flow,
)
from scripts.submission.createMacros import (
    pause_create_macros,
    resume_create_macros,
    run_create_assets,
    stop_create_macros,
)
from scripts.submission.duplicateReport import run_duplicate_report
from scripts.submission.ElRajhiChecker import (
    check_elrajhi_batches,
    reupload_elrajhi_report,
)
from scripts.submission.ElRajhiFiller import (
    ElRajhiFiller,
    ElrajhiRetry,
    ElrajhiRetryByRecordIds,
    ElrajhiRetryByReportIds,
    finalize_multiple_reports,
    pause_batch,
    resume_batch,
    stop_batch,
)
from scripts.submission.grabMacroIds import (
    get_all_macro_ids_parallel,
    pause_grab_macro_ids,
    pause_retry_macro_ids,
    resume_grab_macro_ids,
    resume_retry_macro_ids,
    retry_get_missing_macro_ids,
    stop_grab_macro_ids,
    stop_retry_macro_ids,
)
from scripts.submission.macroFiller import (
    pause_macro_edit,
    resume_macro_edit,
    run_macro_edit,
    run_macro_edit_retry,
    stop_macro_edit,
)
from scripts.submission.mutliReportFiller import (
    create_new_report,
    create_reports_by_batch,
    retry_create_new_report,
)
from scripts.submission.registrationCertificateDownloader import (
    download_registration_certificates,
)
from scripts.submission.validateReport import validate_report

from .browser import check_browser_status, closeBrowser, get_browser, spawn_new_browser

if platform.system().lower() == "windows":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")

# Mongo connection (shared with submission flows)
MONGO_URI = "mongodb+srv://Aasim:userAasim123@electron.cwbi8id.mongodb.net"
mongo_client = AsyncIOMotorClient(MONGO_URI)
mongo_db = mongo_client["test"]

# Track running macro-edit tasks
running_tasks = {}

# Serialize heavy browser automation so concurrent IPC (e.g. get-companies during
# public-login or elrajhi-filler) cannot corrupt the shared nodriver session.
_command_serial_lock = asyncio.Lock()


async def _run_command_safe(cmd):
    """Always emit a JSON line with commandId so Electron never hangs on stdin."""
    command_id = cmd.get("commandId")
    action = cmd.get("action")
    try:
        await handle_command(cmd)
    except Exception as e:
        tb = traceback.format_exc()
        print(
            json.dumps(
                {
                    "status": "FAILED",
                    "error": str(e),
                    "traceback": tb,
                    "commandId": command_id,
                }
            ),
            flush=True,
        )
    finally:
        print(
            f"[PY] Finished action: {action} id={command_id}",
            file=sys.stderr,
            flush=True,
        )


async def _run_close_command(cmd):
    """Close Taqeem browser session immediately; never wait behind serialized automation."""
    command_id = cmd.get("commandId")
    action = "close"
    print(f"[PY] Received action: {action} id={command_id}", file=sys.stderr, flush=True)
    try:
        await closeBrowser()
        print(
            json.dumps(
                {
                    "status": "SUCCESS",
                    "message": "Browser closed successfully",
                    "commandId": command_id,
                }
            ),
            flush=True,
        )
    except Exception as e:
        print(
            json.dumps(
                {
                    "status": "FAILED",
                    "error": str(e),
                    "commandId": command_id,
                }
            ),
            flush=True,
        )
    finally:
        print(
            f"[PY] Finished action: {action} id={command_id}",
            file=sys.stderr,
            flush=True,
        )


async def _process_one_command(cmd):
    action = str(cmd.get("action") or "").lower()
    # Pause/resume/stop must not wait behind long-running fills; they only flip flags.
    if action.startswith(("pause-", "resume-", "stop-")):
        asyncio.create_task(_run_command_safe(cmd))
        return
    # App quit must close Chrome even while elrajhi-filler owns the automation lock.
    if action == "close":
        await _run_close_command(cmd)
        return
    # check-status must stay responsive while long jobs (e.g. certificate download) hold the lock.
    if action == "check-status":
        await _run_command_safe(cmd)
        return
    async with _command_serial_lock:
        await _run_command_safe(cmd)


def _extract_report_ids(records):
    """Normalize report IDs from API payload and preserve order."""
    if not isinstance(records, list):
        return []

    report_ids = []
    seen = set()

    for item in records:
        if isinstance(item, dict):
            report_id = item.get("report_id") or item.get("reportId") or item.get(
                "reportid"
            )
        else:
            report_id = item

        normalized = str(report_id).strip() if report_id is not None else ""
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        report_ids.append(normalized)

    return report_ids


async def get_reports_by_batch(batch_id):
    if not batch_id:
        return {"status": "FAILED", "error": "Missing batchId", "reports": []}

    primary_error = None

    # Primary source for ElRajhi upload batches: returns report records.
    try:
        response = await http_get(f"/new-scripts/batch/{batch_id}")
        if response.get("success"):
            report_ids = _extract_report_ids(response.get("reports", []))
            if report_ids:
                return {
                    "status": "SUCCESS",
                    "message": response.get("message", ""),
                    "reports": report_ids,
                }
            return {
                "status": "FAILED",
                "error": f"No submitted report IDs found for batch {batch_id}",
                "reports": [],
            }
        primary_error = response.get("message", "Not found")
    except Exception as e:
        primary_error = str(e)

    # Legacy fallback for older urgent batches.
    try:
        response = await http_get(f"/new-scripts/urgent-batch/{batch_id}")
        if response.get("success"):
            report_ids = _extract_report_ids(response.get("reports", []))
            if report_ids:
                return {
                    "status": "SUCCESS",
                    "message": response.get("message", ""),
                    "reports": report_ids,
                }
            return {
                "status": "FAILED",
                "error": f"No submitted report IDs found for batch {batch_id}",
                "reports": [],
            }

        fallback_error = response.get("message", "Not found")
        if primary_error:
            fallback_error = f"{primary_error} | fallback: {fallback_error}"
        return {
            "status": "FAILED",
            "error": fallback_error,
            "reports": [],
        }
    except Exception as e:
        fallback_error = str(e)
        if primary_error:
            fallback_error = f"{primary_error} | fallback: {fallback_error}"
        return {
            "status": "FAILED",
            "error": fallback_error,
            "reports": [],
        }


async def handle_command(cmd):
    """Handle a single command"""
    action = cmd.get("action")
    cid = cmd.get("commandId")

    print(f"[PY] Received action: {action} id={cid}", file=sys.stderr, flush=True)

    if action == "login":
        browser = await get_browser(force_new=True)
        page = await browser.get(
            "https://sso.taqeem.gov.sa/realms/REL_TAQEEM/protocol/openid-connect/auth"
            "?client_id=cli-qima-valuers&redirect_uri=https%3A%2F%2Fqima.taqeem.gov.sa%2Fkeycloak%2Flogin%2Fcallback"
            "&scope=openid&response_type=code"
        )
        result = await startLogin(
            page,
            cmd.get("email", ""),
            cmd.get("password", ""),
            cmd.get("method", ""),
            cmd.get("autoOtp", False),
        )

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "public-login":
        base_url = (
            "https://sso.taqeem.gov.sa/realms/REL_TAQEEM/protocol/openid-connect/auth"
        )

        params = (
            "?client_id=cli-qima-valuers"
            "&redirect_uri=https%3A%2F%2Fqima.taqeem.gov.sa%2Fkeycloak%2Flogin%2Fcallback"
            "&scope=openid"
            "&response_type=code"
        )

        login_url = base_url + params
        is_auth = cmd.get("isAuth", False)

        result = await public_login_flow(login_url, is_auth)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "otp":
        browser = await get_browser()
        if not browser or not browser.main_tab:
            result = {
                "status": "FAILED",
                "error": "No active browser session. Please login first.",
                "commandId": cmd.get("commandId"),
            }
            print(json.dumps(result), flush=True)
            return
        page = browser.main_tab
        result = await submitOtp(page, cmd.get("otp", ""), cmd.get("recordId"))
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "check-status":
        # Must always finish: a stuck nodriver evaluate used to block the whole command queue
        # (no JSON reply → Electron spinners never end, get-companies / elrajhi never run).
        try:
            result = await asyncio.wait_for(check_browser_status(), timeout=28.0)
        except asyncio.TimeoutError:
            result = {
                "status": "FAILED",
                "error": "Browser check timed out — the automation browser may be busy. If a long task is running, wait for it to finish then retry.",
                "browserOpen": True,
            }
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "open-login-page":
        login_url = cmd.get("loginUrl") or (
            "https://sso.taqeem.gov.sa/realms/REL_TAQEEM/protocol/openid-connect/auth"
            "?client_id=cli-qima-valuers&redirect_uri=https%3A%2F%2Fqima.taqeem.gov.sa%2Fkeycloak%2Flogin%2Fcallback"
            "&scope=openid&response_type=code"
        )
        only_if_closed = bool(cmd.get("onlyIfClosed", True))
        navigate_if_open = bool(cmd.get("navigateIfOpen", False))
        force_new = bool(cmd.get("forceNew", False))
        skip_status_check = bool(cmd.get("skipStatusCheck", False))
        opened_new = False
        navigated = False

        try:
            status_timed_out = False
            if skip_status_check:
                browser_status = {
                    "status": "FAILED",
                    "browserOpen": False,
                }
            else:
                try:
                    browser_status = await asyncio.wait_for(check_browser_status(), timeout=10.0)
                except asyncio.TimeoutError:
                    status_timed_out = True
                    browser_status = {
                        "status": "FAILED",
                        "error": "Browser status check timed out before opening login page",
                        "browserOpen": False,
                    }
            browser_open = bool(browser_status.get("browserOpen"))

            if only_if_closed and browser_open and not force_new and not status_timed_out:
                result = {
                    "status": "SUCCESS",
                    "message": "Browser already running; skipped opening login page",
                    "browserOpen": True,
                    "alreadyOpen": True,
                    "openedNewBrowser": False,
                    "navigated": False,
                }
            else:
                effective_force_new = force_new or status_timed_out
                opened_new = effective_force_new or not browser_open
                b = await get_browser(force_new=effective_force_new, headless_override=False)
                page = b.main_tab
                if page is None:
                    page = await b.get("about:blank")

                if opened_new or navigate_if_open or effective_force_new:
                    await page.get(login_url)
                    navigated = True
                    try:
                        from scripts.loginFlow.taqeem_login_assist import (
                            ensure_taqeem_primary_login_assist,
                        )

                        await ensure_taqeem_primary_login_assist(page)
                    except Exception:
                        pass

                result = {
                    "status": "SUCCESS",
                    "message": "Opened Taqeem login page in automation browser",
                    "browserOpen": True,
                    "alreadyOpen": not opened_new,
                    "openedNewBrowser": opened_new,
                    "navigated": navigated,
                    "statusTimedOut": status_timed_out,
                    "skippedStatusCheck": skip_status_check,
                    "url": login_url,
                }
        except Exception as e:
            result = {
                "status": "FAILED",
                "error": str(e),
                "browserOpen": False,
                "openedNewBrowser": opened_new,
                "navigated": navigated,
            }

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "validate-report":
        result = await validate_report(cmd)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "create-macros":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        macro_count = cmd.get("macroCount")
        tabs_num = cmd.get("tabsNum")
        batch_size = cmd.get("batchSize")

        result = await run_create_assets(
            browser, report_id, macro_count, tabs_num, batch_size
        )
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "grab-macro-ids":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        tabs_num = cmd.get("tabsNum")

        result = await get_all_macro_ids_parallel(browser, report_id, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "pause-grab-macro-ids":
        report_id = cmd.get("reportId")
        result = await pause_grab_macro_ids(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-grab-macro-ids":
        report_id = cmd.get("reportId")
        result = await resume_grab_macro_ids(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-grab-macro-ids":
        report_id = cmd.get("reportId")
        result = await stop_grab_macro_ids(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "pause-retry-macro-ids":
        report_id = cmd.get("reportId")
        result = await pause_retry_macro_ids(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-retry-macro-ids":
        report_id = cmd.get("reportId")
        result = await resume_retry_macro_ids(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-retry-macro-ids":
        report_id = cmd.get("reportId")
        result = await stop_retry_macro_ids(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "retry-macro-ids":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        tabs_num = cmd.get("tabsNum")

        result = await retry_get_missing_macro_ids(browser, report_id, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "macro-edit":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        tabs_num = int(cmd.get("tabsNum", 3))

        # Run macro-edit as a background task so we can handle pause/resume
        # while it's running
        task = asyncio.create_task(run_macro_edit(browser, report_id, tabs_num))
        running_tasks[report_id] = task

        try:
            result = await task
        except asyncio.CancelledError:
            result = {"status": "CANCELLED", "message": "Macro edit was cancelled"}
        finally:
            # Clean up task reference
            if report_id in running_tasks:
                del running_tasks[report_id]

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "run-macro-edit-retry":
        try:
            browser = await get_browser()

            report_id = cmd.get("reportId")
            tabs_num = int(cmd.get("tabsNum", 3))

            result = await run_macro_edit_retry(browser, report_id, tabs_num)
            result["commandId"] = cmd.get("commandId")
            print(json.dumps(result), flush=True)

        except Exception:
            pass

    elif action == "pause-macro-edit":
        report_id = cmd.get("reportId")
        # Pause command can be processed immediately
        result = await pause_macro_edit(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-macro-edit":
        report_id = cmd.get("reportId")
        # Resume command can be processed immediately
        result = await resume_macro_edit(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-macro-edit":
        report_id = cmd.get("reportId")
        # Stop command can be processed immediately
        result = await stop_macro_edit(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "elrajhi-filler":
        browser = await get_browser()

        batch_id = cmd.get("batchId")
        tabs_num = int(cmd.get("tabsNum", 3))
        pdf_only = bool(cmd.get("pdfOnly", False))
        finalize_submission = bool(cmd.get("finalizeSubmission", True))
        company = cmd.get("company") or cmd.get("companyUrl")

        result = await ElRajhiFiller(
            browser,
            batch_id,
            tabs_num,
            pdf_only,
            company_url=company,
            finalize_submission=finalize_submission,
        )
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "pause-elrajhi-batch":
        batch_id = cmd.get("batchId")

        result = await pause_batch(batch_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "resume-elrajhi-batch":
        batch_id = cmd.get("batchId")

        result = await resume_batch(batch_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "stop-elrajhi-batch":
        batch_id = cmd.get("batchId")

        result = await stop_batch(batch_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "elrajhi-check-batches":
        browser = await get_browser()

        batch_id = cmd.get("batchId")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await check_elrajhi_batches(browser, batch_id, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "download-registration-certificates":
        result = await download_registration_certificates(cmd)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "elrajhi-reupload-report":
        browser = await get_browser()

        report_id = cmd.get("reportId")

        result = await reupload_elrajhi_report(browser, report_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "duplicate-report":
        record_id = cmd.get("recordId")
        company_url = cmd.get("companyUrl") or cmd.get("url") or cmd.get("company")
        tabs_num = cmd.get("tabsNum")
        try:
            tabs_num = int(tabs_num) if tabs_num is not None else 3
        except Exception:
            tabs_num = 3
        result = await run_duplicate_report(
            record_id=record_id, company_url=company_url, tabs_num=tabs_num
        )
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "full-check":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await RunCheckMacroStatus(browser, report_id, tabs_num, same=True)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "half-check":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await RunHalfCheckMacroStatus(browser, report_id, tabs_num, same=True)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    # Add these elif blocks in your handle_command function:

    elif action == "pause-full-check":
        report_id = cmd.get("reportId")
        result = await pause_full_check(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-full-check":
        report_id = cmd.get("reportId")
        result = await resume_full_check(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-full-check":
        report_id = cmd.get("reportId")
        result = await stop_full_check(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "pause-half-check":
        report_id = cmd.get("reportId")
        result = await pause_half_check(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-half-check":
        report_id = cmd.get("reportId")
        result = await resume_half_check(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-half-check":
        report_id = cmd.get("reportId")
        result = await stop_half_check(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "delete-report":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        max_rounds = int(cmd.get("maxRounds", 10))
        user_id = cmd.get("userId")
        company_office_id = cmd.get("companyOfficeId")

        result = await delete_report_flow(
            report_id=report_id,
            max_rounds=max_rounds,
            user_id=user_id,
            company_office_id=company_office_id,
        )
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "complete-flow":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await run_complete_report_flow(browser, report_id, tabs_num=tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "delete-multiple-reports":
        browser = await get_browser()

        report_ids = cmd.get("reportIds")
        max_rounds = int(cmd.get("maxRounds", 10))

        result = await delete_multiple_reports_flow(
            report_ids=report_ids, max_rounds=max_rounds
        )
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "pause-delete-report":
        report_id = cmd.get("reportId")
        result = await pause_delete_report(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-delete-report":
        report_id = cmd.get("reportId")
        result = await resume_delete_report(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-delete-report":
        report_id = cmd.get("reportId")
        result = await stop_delete_report(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "delete-incomplete-assets":
        browser = await get_browser()

        report_id = cmd.get("reportId")
        max_rounds = int(cmd.get("maxRounds", 10))
        user_id = cmd.get("userId")
        company_office_id = cmd.get("companyOfficeId")

        result = await delete_incomplete_assets_flow(
            report_id=report_id,
            max_rounds=max_rounds,
            user_id=user_id,
            company_office_id=company_office_id,
        )
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "get-report-deletions":
        user_id = cmd.get("userId")
        delete_type = cmd.get("deleteType")
        company_office_id = cmd.get("companyOfficeId")
        page = int(cmd.get("page", 1))
        limit = int(cmd.get("limit", 10))
        search_term = cmd.get("searchTerm")

        if not user_id:
            result = {"status": "FAILED", "error": "Missing userId"}
        else:
            try:
                params = {"userId": user_id, "page": page, "limit": limit}
                if company_office_id:
                    params["companyOfficeId"] = company_office_id
                if delete_type:
                    params["deleteType"] = delete_type
                if search_term:
                    params["searchTerm"] = search_term

                response = await http_get(
                    "/new-scripts/report-deletions", params=params
                )
                if response.get("success"):
                    result = {
                        "status": "SUCCESS",
                        "items": response.get("items", []),
                        "total": response.get("total", 0),
                        "page": page,
                        "limit": limit,
                    }
                else:
                    result = {
                        "status": "FAILED",
                        "error": response.get("message", "Failed"),
                    }
            except Exception as e:
                result = {"status": "FAILED", "error": str(e)}

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "store-report-deletion":
        deletion_data = cmd.get("deletionData")
        if not deletion_data:
            result = {"status": "FAILED", "error": "Missing deletionData"}
        else:
            try:
                response = await http_post(
                    "/new-scripts/report-deletions", json=deletion_data
                )
                if response.get("success"):
                    result = {"status": "SUCCESS", "message": "Deletion record stored"}
                else:
                    result = {
                        "status": "FAILED",
                        "error": response.get("message", "Failed"),
                    }
            except Exception as e:
                result = {"status": "FAILED", "error": str(e)}

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "get-checked-reports":
        user_id = cmd.get("userId")
        company_office_id = cmd.get("companyOfficeId")
        page = int(cmd.get("page", 1))
        limit = int(cmd.get("limit", 10))
        search_term = cmd.get("searchTerm")

        if not user_id:
            result = {"status": "FAILED", "error": "Missing userId"}
        else:
            try:
                params = {"userId": user_id, "page": page, "limit": limit}
                if company_office_id:
                    params["companyOfficeId"] = company_office_id
                if search_term:
                    params["searchTerm"] = search_term

                response = await http_get("/new-scripts/checked-reports", params=params)
                if response.get("success"):
                    result = {
                        "status": "SUCCESS",
                        "items": response.get("items", []),
                        "total": response.get("total", 0),
                        "page": page,
                        "limit": limit,
                    }
                else:
                    result = {
                        "status": "FAILED",
                        "error": response.get("message", "Failed"),
                    }
            except Exception as e:
                result = {"status": "FAILED", "error": str(e)}

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "get-validation-results":
        user_id = cmd.get("userId")
        report_ids = cmd.get("reportIds", [])

        if not user_id or not report_ids:
            result = {"status": "FAILED", "error": "Missing userId or reportIds"}
        else:
            try:
                response = await http_post(
                    "/new-scripts/validation-results",
                    params={"userId": user_id},
                    json={"reportIds": report_ids},
                )
                if response.get("success"):
                    result = {"status": "SUCCESS", "items": response.get("items", [])}
                else:
                    result = {
                        "status": "FAILED",
                        "error": response.get("message", "Failed"),
                    }
            except Exception as e:
                result = {"status": "FAILED", "error": str(e)}

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "pause-delete-incomplete-assets":
        report_id = cmd.get("reportId")

        result = await pause_delete_incomplete_assets(report_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "resume-delete-incomplete-assets":
        report_id = cmd.get("reportId")

        result = await resume_delete_incomplete_assets(report_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "stop-delete-incomplete-assets":
        report_id = cmd.get("reportId")

        result = await stop_delete_incomplete_assets(report_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "handle-cancelled-report":
        browser = await get_browser()

        report_id = cmd.get("reportId")

        result = await handle_cancelled_report(report_id=report_id)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "get-companies":
        try:
            result = await asyncio.wait_for(get_companies(), timeout=900.0)
        except asyncio.TimeoutError:
            result = {
                "status": "FAILED",
                "error": "get-companies timed out after 15 minutes (browser may be stuck).",
                "data": [],
            }
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "get-profile":
        try:
            result = await asyncio.wait_for(get_profile(), timeout=60.0)
        except asyncio.TimeoutError:
            result = {
                "status": "FAILED",
                "error": "get-profile timed out",
                "data": None,
            }
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "retry-ElRajhi-report":
        browser = await get_browser()

        batch_id = cmd.get("batchId")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await ElrajhiRetry(browser, batch_id, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "elrajhi-retry-by-record-ids":
        browser = await get_browser()

        record_ids = cmd.get("recordIds")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await ElrajhiRetryByRecordIds(browser, record_ids, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "elrajhi-retry-by-report-ids":
        browser = await get_browser()

        report_ids = cmd.get("reportIds")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await ElrajhiRetryByReportIds(browser, report_ids, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "finalize-multiple-reports":
        browser = await get_browser()

        report_ids = cmd.get("reportIds")

        result = await finalize_multiple_reports(browser, report_ids)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "pause-complete-flow":
        report_id = cmd.get("reportId")
        result = await pause_complete_flow(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-complete-flow":
        report_id = cmd.get("reportId")
        result = await resume_complete_flow(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-complete-flow":
        report_id = cmd.get("reportId")
        result = await stop_complete_flow(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "navigate-to-company":
        company = cmd.get("company") or cmd.get("url")

        # If caller only wants to persist selection, avoid launching browser
        if isinstance(company, dict) and company.get("skipNavigation"):
            selected = set_selected_company(
                company.get("url"),
                name=company.get("name"),
                office_id=company.get("officeId") or company.get("office_id"),
                sector_id=company.get("sectorId") or company.get("sector_id"),
            )
            result = {
                "status": "SUCCESS",
                "message": "Company context stored without navigation",
                "url": selected.get("url"),
                "selectedCompany": selected,
            }
        else:
            browser = await get_browser()
            result = await navigate_to_company(browser, company)

        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "pause-create-macros":
        report_id = cmd.get("reportId")
        result = await pause_create_macros(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "resume-create-macros":
        report_id = cmd.get("reportId")
        result = await resume_create_macros(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "stop-create-macros":
        report_id = cmd.get("reportId")
        result = await stop_create_macros(report_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "get-reports-by-batch":
        batch_id = cmd.get("batchId") or cmd.get("batch_id")
        result = await get_reports_by_batch(batch_id)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "create-reports-by-batch":
        browser = await get_browser()

        batch_id = cmd.get("batchId")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await create_reports_by_batch(browser, batch_id, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "create-report-by-id":
        # Spawn a new browser for each report submission (like create-reports-by-batch)
        new_browser = None
        process_id = None
        result = None

        try:
            record_id = cmd.get("recordId") or cmd.get("record_id")
            tabs_num = int(cmd.get("tabsNum", 3))
            process_id = str(record_id).strip() if record_id is not None else None

            if process_id:
                create_process(
                    process_id=process_id,
                    process_type="submit-report-quickly",
                    total=100,
                    report_id=process_id,
                    tabs_num=tabs_num,
                )
                emit_progress(
                    process_id,
                    current_item="bootstrap",
                    message="Preparing browser session for report submission...",
                )

            # Get the existing browser first, then spawn a new one from it
            browser = await get_browser()
            new_browser = await spawn_new_browser(browser)
            if process_id:
                emit_progress(
                    process_id,
                    current_item="browser_ready",
                    message="Browser ready. Starting report submission workflow...",
                )

            result = await create_new_report(new_browser, record_id, tabs_num)
        except Exception as e:
            result = {
                "status": "FAILED",
                "error": str(e),
                "traceback": traceback.format_exc(),
            }
        finally:
            # Close the browser after completion
            if new_browser:
                new_browser.stop()
            if process_id:
                clear_process(process_id)

        if not isinstance(result, dict):
            result = {
                "status": "FAILED",
                "error": "Invalid response from create_new_report",
            }
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    elif action == "retry-create-report-by-id":
        browser = await get_browser()

        record_id = cmd.get("recordId")
        tabs_num = int(cmd.get("tabsNum", 3))

        result = await retry_create_new_report(browser, record_id, tabs_num)
        result["commandId"] = cmd.get("commandId")

        print(json.dumps(result), flush=True)

    elif action == "ping":
        result = {
            "status": "SUCCESS",
            "message": "pong",
            "commandId": cmd.get("commandId"),
        }
        print(json.dumps(result), flush=True)

    elif action == "register":
        user_data = {
            "userType": cmd.get("userType"),
            "phone": cmd.get("phone"),
            "password": cmd.get("password"),
        }

        result = await register_user(user_data)
        result["commandId"] = cmd.get("commandId")
        print(json.dumps(result), flush=True)

    else:
        result = {
            "status": "FAILED",
            "error": f"Unknown action: {action}",
            "supported_actions": [
                "login",
                "otp",
                "check-status",
                "validate-report",
                "create-macros",
                "grab-macro-ids",
                "macro-edit",
                "pause-macro-edit",
                "resume-macro-edit",
                "stop-macro-edit",
                "full-check",
                "half-check",
                "register",
                "close",
                "ping",
                "duplicate-report",
                "get-reports-by-batch",
                "create-report-by-id",
                "download-registration-certificates",
                "open-login-page",
            ],
            "commandId": cmd.get("commandId"),
        }
        print(json.dumps(result), flush=True)


async def read_stdin_lines():
    """Generator that yields lines from stdin"""
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        yield line.strip()


async def _stdin_to_queue(queue: asyncio.Queue):
    """Read JSON commands from stdin without blocking the automation queue."""
    async for line in read_stdin_lines():
        if not line:
            continue
        try:
            cmd = json.loads(line)
            await queue.put(cmd)
        except json.JSONDecodeError as e:
            print(
                json.dumps(
                    {
                        "status": "FAILED",
                        "error": f"Invalid JSON: {str(e)}",
                        "received": line[:500],
                    }
                ),
                flush=True,
            )
        except Exception as e:
            tb = traceback.format_exc()
            print(
                json.dumps(
                    {
                        "status": "FAILED",
                        "error": f"stdin reader error: {str(e)}",
                        "traceback": tb,
                    }
                ),
                flush=True,
            )
    await queue.put(None)


async def command_handler():
    """
    Process one browser-heavy command at a time (pause/resume/stop run in parallel).
    stdin is read on a separate async path so control commands still enqueue while
    a long job (public-login, get-companies, elrajhi-filler) is running.
    """
    queue: asyncio.Queue = asyncio.Queue()
    reader_task = asyncio.create_task(_stdin_to_queue(queue))
    try:
        while True:
            cmd = await queue.get()
            if cmd is None:
                break
            await _process_one_command(cmd)
    finally:
        reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass


async def main():
    try:
        await command_handler()
    except Exception as e:
        print(json.dumps({"status": "FATAL", "error": str(e)}), flush=True)
    finally:
        # Cancel any running tasks
        for task in running_tasks.values():
            if not task.done():
                task.cancel()

        # Wait for tasks to finish
        if running_tasks:
            await asyncio.gather(*running_tasks.values(), return_exceptions=True)

        await closeBrowser()


if __name__ == "__main__":
    asyncio.run(main())
