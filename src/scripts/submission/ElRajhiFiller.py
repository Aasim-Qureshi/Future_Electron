import asyncio
import sys
import traceback
from datetime import datetime
from urllib.parse import urlparse

from scripts.core.company_context import (
    build_report_create_url,
    get_selected_company,
    require_selected_company,
    set_selected_company,
)
from scripts.core.httpClient import http_get, http_patch
from scripts.core.processControl import (
    check_and_wait,
    clear_process,
    create_process,
    emit_progress,
    get_process_manager,
    update_progress,
)
from scripts.core.utils import log, wait_for_element, wait_for_table_rows

from .formFiller import fill_form
from .formSteps import form_steps, macro_form_config
from .macroFiller import fill_macro_form

# Global pause state management
pause_states = {}
DEFAULT_ELRAJHI_ASSET_VALUE_BASE_ID = "6"


def get_pause_state(batch_id):
    """Get pause state for a batch"""
    return pause_states.get(batch_id, {"paused": False, "stopped": False})


def set_pause_state(batch_id, paused=None, stopped=None):
    """Set pause state for a batch"""
    if batch_id not in pause_states:
        pause_states[batch_id] = {"paused": False, "stopped": False}

    if paused is not None:
        pause_states[batch_id]["paused"] = paused
    if stopped is not None:
        pause_states[batch_id]["stopped"] = stopped

    return pause_states[batch_id]


def clear_pause_state(batch_id):
    """Clear pause state for a batch"""
    if batch_id in pause_states:
        del pause_states[batch_id]


async def check_pause_state(batch_id):
    """Check if processing should pause or stop"""
    state = get_pause_state(batch_id)

    if state.get("stopped"):
        return {"action": "stop"}

    while state.get("paused"):
        await asyncio.sleep(0.5)
        state = get_pause_state(batch_id)

        if state.get("stopped"):
            return {"action": "stop"}

    return {"action": "continue"}


def balanced_chunks(lst, n):
    """Split list into n balanced chunks"""
    k, m = divmod(len(lst), n)
    chunks = []
    start = 0
    for i in range(n):
        size = k + (1 if i < m else 0)
        chunks.append(lst[start : start + size])
        start += size
    return chunks


def extract_asset_from_report(report_record):
    # Convert inspection_date from MongoDB Date to yyyy-mm-dd
    inspection_date = report_record.get("inspection_date")

    if inspection_date:
        try:
            # If it's already a datetime object (from MongoDB)
            if isinstance(inspection_date, datetime):
                formatted_date = inspection_date.strftime("%Y-%m-%d")
            # If it's a string (fallback)
            elif isinstance(inspection_date, str):
                # Handle string formats
                if "T" in inspection_date:
                    # ISO format string
                    date_obj = datetime.fromisoformat(
                        inspection_date.replace("Z", "+00:00")
                    )
                    formatted_date = date_obj.strftime("%Y-%m-%d")
                else:
                    # Try parsing other string formats
                    try:
                        date_obj = datetime.strptime(inspection_date, "%Y-%m-%d")
                        formatted_date = date_obj.strftime("%Y-%m-%d")
                    except Exception:
                        formatted_date = inspection_date[:10]  # Take first 10 chars
            else:
                formatted_date = ""
        except Exception as e:
            print(
                f"Warning: Could not format inspection_date: {type(inspection_date)} - {inspection_date}, error: {e}"
            )
            formatted_date = ""
    else:
        formatted_date = ""

    return {
        "asset_type": "مركبة",
        "production_capacity": "0",
        "production_capacity_measuring_unit": "0",
        "product_type": "0",
        "asset_name": report_record.get("asset_name"),
        "asset_usage_id": report_record.get("asset_usage"),
        "value_base": str(
            report_record.get("value_base")
            or report_record.get("value_base_id")
            or DEFAULT_ELRAJHI_ASSET_VALUE_BASE_ID
        ),
        "inspection_date": formatted_date,  # Use the formatted date
        "final_value": report_record.get("final_value"),
        "market_approach": "1",
        "market_approach_value": report_record.get("final_value"),
        "owner_name": report_record.get("client_name"),
        "region": report_record.get("region"),
        "city": report_record.get("city"),
    }


async def create_report_and_collect_macro(page, report_record, create_url):
    """Create a single report and collect its macro ID without filling it"""
    try:
        # Navigate to create report page
        nav_result = await navigate_page_resilient(
            page,
            create_url,
            label="report creation page",
            timeout=40,
            settle_seconds=1,
        )
        if nav_result.get("status") != "SUCCESS":
            return {
                "status": "FAILED",
                "step": "navigate_create",
                "error": nav_result.get("error") or "Failed to open create report page",
                "record_id": str(report_record["_id"]),
            }

        # Fill form steps with report data (steps 1 and 2)
        for step_num, step_config in enumerate(form_steps, 1):
            is_last = step_num == len(form_steps)
            valuers = report_record.get("valuers")
            is_valuers_step = bool(valuers) and step_config.get(
                "is_valuers_step", False
            )

            if valuers:
                result = await fill_form(
                    page,
                    report_record,
                    step_config["field_map"],
                    step_config["field_types"],
                    is_last,
                    is_valuers=is_valuers_step,
                )
            else:
                result = await fill_form(
                    page,
                    report_record,
                    step_config["field_map"],
                    step_config["field_types"],
                    is_last,
                )

            if isinstance(result, dict) and result.get("status") == "FAILED":
                return {
                    "status": "FAILED",
                    "step": step_num,
                    "error": result.get("error"),
                    "record_id": str(report_record["_id"]),
                }

            if is_last:
                # Get the report ID from URL
                main_url = await page.evaluate("window.location.href")
                form_id = main_url.split("/")[-1]

                if not form_id:
                    return {
                        "status": "FAILED",
                        "step": "report_id",
                        "error": "Could not determine report_id",
                        "record_id": str(report_record["_id"]),
                    }

                await http_patch(
                    f"/new-scripts/{report_record['_id']}/set-report-id",
                    json={"report_id": form_id},
                )

                # Get the macro ID without filling it
                await asyncio.sleep(2)
                await wait_for_table_rows(page)
                macro_link = await wait_for_element(
                    page, "#m-table tbody tr:first-child td:nth-child(1) a"
                )

                if not macro_link:
                    return {
                        "status": "FAILED",
                        "error": "Could not find macro link in table",
                        "report_id": form_id,
                        "record_id": str(report_record["_id"]),
                    }

                macro_id = macro_link.text.strip()

                # Get asset data (single asset per report)
                macro_data = extract_asset_from_report(report_record)

                return {
                    "status": "SUCCESS",
                    "report_id": form_id,
                    "macro_id": macro_id,
                    "macro_data": macro_data,
                    "record_id": str(report_record["_id"]),
                }

    except Exception as e:
        tb = traceback.format_exc()
        return {
            "status": "FAILED",
            "error": str(e),
            "traceback": tb,
            "record_id": str(report_record["_id"]),
        }


DUMMY_PDF_NAME = "dummy_placeholder.pdf"


def is_dummy_pdf(report_record):
    """Return True if this report is using the dummy placeholder PDF."""
    pdf_path = report_record.get("pdf_path") or ""
    return isinstance(pdf_path, str) and pdf_path.endswith(DUMMY_PDF_NAME)


async def get_page_url(page, timeout=6):
    try:
        return str(
            await asyncio.wait_for(page.evaluate("window.location.href"), timeout=timeout)
            or ""
        ).strip()
    except Exception:
        return ""


def urls_match(current_url, target_url):
    current = str(current_url or "").strip()
    target = str(target_url or "").strip()
    if not current or not target:
        return False
    if current == target:
        return True

    try:
        current_parts = urlparse(current)
        target_parts = urlparse(target)
        return (
            current_parts.scheme == target_parts.scheme
            and current_parts.netloc == target_parts.netloc
            and current_parts.path == target_parts.path
        )
    except Exception:
        return False


async def navigate_page_resilient(
    page,
    target_url,
    *,
    label="page",
    timeout=35,
    settle_seconds=1.5,
):
    last_error = None
    for attempt in range(2):
        try:
            await asyncio.wait_for(page.get(target_url), timeout=timeout)
            if settle_seconds:
                await asyncio.sleep(settle_seconds)
            current_url = await get_page_url(page)
            if not current_url or urls_match(current_url, target_url):
                return {"status": "SUCCESS", "url": current_url or target_url}
            return {"status": "SUCCESS", "url": current_url}
        except Exception as err:
            last_error = err
            current_url = await get_page_url(page)
            if urls_match(current_url, target_url):
                return {"status": "SUCCESS", "url": current_url}

            try:
                await asyncio.wait_for(
                    page.evaluate(
                        """(url) => {
                            window.location.href = url;
                            return window.location.href;
                        }""",
                        target_url,
                    ),
                    timeout=5,
                )
                if settle_seconds:
                    await asyncio.sleep(settle_seconds)
                current_url = await get_page_url(page)
                if urls_match(current_url, target_url):
                    return {"status": "SUCCESS", "url": current_url}
            except Exception as fallback_err:
                last_error = fallback_err

        await asyncio.sleep(1)

    return {
        "status": "FAILED",
        "error": f"Timed out opening {label}: {last_error}",
        "url": await get_page_url(page),
    }


async def open_workflow_page(
    browser,
    *,
    force_spawn=False,
    headless=False,
    spawn_timeout=25.0,
    surface_timeout=30.0,
):
    """
    Open a dedicated surface for ElRajhi steps.

    Prefer a new window/tab in the already-authenticated Taqeem browser. Starting
    a second nodriver Chrome process can hang on Windows before uc.start returns,
    which blocks the Python worker and leaves the UI loading forever.
    """
    if browser is None:
        return None, None, None

    if force_spawn:
        page = None
        last_err = None
        try:
            page = await asyncio.wait_for(
                browser.get("about:blank", new_window=True),
                timeout=surface_timeout,
            )
        except Exception as err:
            last_err = err
            print(
                f"[PY] ElRajhiFiller: new_window failed ({err}); trying new_tab.",
                file=sys.stderr,
                flush=True,
            )
            try:
                page = await asyncio.wait_for(
                    browser.get("about:blank", new_tab=True),
                    timeout=surface_timeout,
                )
            except Exception as err2:
                last_err = err2

        if page is not None:
            print(
                "[PY] ElRajhiFiller: using dedicated window/tab in existing "
                "Taqeem browser session.",
                file=sys.stderr,
                flush=True,
            )
            return browser, page, None

        print(
            f"[PY] ElRajhiFiller: could not open Taqeem action window/tab: {last_err}",
            file=sys.stderr,
            flush=True,
        )
        return None, None, None

    page = None
    last_err = None
    try:
        page = await asyncio.wait_for(
            browser.get("about:blank", new_window=True),
            timeout=surface_timeout,
        )
    except Exception as err:
        last_err = err
        print(
            f"[PY] ElRajhiFiller: new_window failed ({err}); trying new_tab.",
            file=sys.stderr,
            flush=True,
        )
        try:
            page = await asyncio.wait_for(
                browser.get("about:blank", new_tab=True),
                timeout=surface_timeout,
            )
        except Exception as err2:
            last_err = err2

    if page is None:
        print(
            f"[PY] ElRajhiFiller: could not open automation tab/window: {last_err}",
            file=sys.stderr,
            flush=True,
        )
        return None, None, None

    print(
        "[PY] ElRajhiFiller: using new tab/window on existing Chrome (shared Taqeem session).",
        file=sys.stderr,
        flush=True,
    )

    # new_browser stays None → finally block must not stop the login browser instance
    return browser, page, None


async def open_workflow_pages(workflow_browser, first_page, total_pages, timeout=30.0):
    pages = [first_page]
    for _ in range(max(0, int(total_pages or 1) - 1)):
        try:
            page = await asyncio.wait_for(
                workflow_browser.get("about:blank", new_tab=True),
                timeout=timeout,
            )
            pages.append(page)
        except Exception as err:
            print(
                f"[PY] ElRajhiFiller: failed to open extra action tab: {err}",
                file=sys.stderr,
                flush=True,
            )
            break
    return pages


def is_macro_fill_failed(result):
    return isinstance(result, dict) and str(result.get("status", "")).upper() == "FAILED"


async def update_elrajhi_record_status(
    record_id,
    *,
    report_id=None,
    submit_state=1,
    report_status="COMPLETE",
):
    if not record_id:
        return False

    payload = {
        "submit_state": submit_state,
        "report_status": report_status,
    }
    if report_id:
        payload["report_id"] = str(report_id)

    try:
        await http_patch(
            f"/new-scripts/update-elrajhi-status/{record_id}",
            json=payload,
        )
        return True
    except Exception as e:
        log(f"Failed to update ElRajhi status for {record_id}: {e}", "WARN")
        return False


async def update_elrajhi_record_status_by_report_id(
    report_id,
    *,
    submit_state=1,
    report_status="SENT",
):
    if not report_id:
        return False

    try:
        report_data = await http_get(f"/new-scripts/report-id/{report_id}")
        report = report_data.get("report")
        record_id = report.get("_id") if report else None
        if not record_id:
            return False
        return await update_elrajhi_record_status(
            record_id,
            report_id=report_id,
            submit_state=submit_state,
            report_status=report_status,
        )
    except Exception as e:
        log(f"Failed to update ElRajhi status by report_id {report_id}: {e}", "WARN")
        return False


async def complete_macro_report(page, macro_info, finalize_submission):
    """Mark the asset filled, then optionally send the report to the confirmer."""
    report_id = macro_info.get("report_id")
    record_id = macro_info.get("record_id")

    status_updated = await update_elrajhi_record_status(
        record_id,
        report_id=report_id,
        submit_state=1,
        report_status="COMPLETE",
    )

    finalization_result = None
    finalization_succeeded = False
    if finalize_submission:
        if report_id:
            finalization_result = await finalize_report_submission(page, report_id)
            finalization_succeeded = finalization_result.get("status") == "SUCCESS"
            if finalization_succeeded:
                await update_elrajhi_record_status(
                    record_id,
                    report_id=report_id,
                    submit_state=1,
                    report_status="SENT",
                )
        else:
            finalization_result = {"status": "FAILED", "error": "Missing report_id"}

    return {
        "status_updated": status_updated,
        "finalization": finalization_result,
        "finalization_succeeded": finalization_succeeded,
    }


async def finalize_report_submission(page, report_id):
    """Open the report page, accept policy checkbox, and send the report."""
    try:
        report_url = f"https://qima.taqeem.gov.sa/report/{report_id}"
        nav_result = await navigate_page_resilient(
            page,
            report_url,
            label=f"report {report_id}",
            timeout=35,
            settle_seconds=1,
        )
        if nav_result.get("status") != "SUCCESS":
            return {
                "status": "FAILED",
                "error": nav_result.get("error") or f"Failed to open report {report_id}",
            }

        checkbox_selector = "input#agree"
        agree_checkbox = await wait_for_element(page, checkbox_selector, timeout=20)
        if not agree_checkbox:
            return {"status": "FAILED", "error": "Agree checkbox not found"}

        try:
            await page.evaluate(
                """(selector) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.checked = true;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }""",
                checkbox_selector,
            )
        except Exception:
            try:
                await agree_checkbox.click()
            except Exception:
                return {"status": "FAILED", "error": "Could not toggle agree checkbox"}

        send_selector = "input#send"
        send_button = await wait_for_element(page, send_selector, timeout=15)
        if not send_button:
            return {"status": "FAILED", "error": "Send button not found"}

        try:
            await page.evaluate(
                """(selector) => {
                    const btn = document.querySelector(selector);
                    if (btn) btn.disabled = false;
                }""",
                send_selector,
            )
        except Exception:
            pass

        await send_button.click()
        await asyncio.sleep(2)

        return {"status": "SUCCESS", "report_id": report_id}
    except Exception as e:
        return {"status": "FAILED", "error": str(e)}


async def finalize_multiple_reports(browser, report_ids):
    new_browser = None
    action_page = None
    try:
        workflow_browser, page, new_browser = await open_workflow_page(
            browser,
            force_spawn=True,
            headless=False,
        )
        if workflow_browser is None or page is None:
            return {"status": "FAILED", "error": "Could not open Taqeem action browser."}
        action_page = page
        finalized_reports = 0
        failed_reports = 0
        for report_id in report_ids:
            result = await finalize_report_submission(page, report_id)
            if result.get("status") == "SUCCESS":
                finalized_reports += 1
                await update_elrajhi_record_status_by_report_id(
                    report_id,
                    submit_state=1,
                    report_status="SENT",
                )
            else:
                failed_reports += 1

        return {
            "status": "SUCCESS",
            "message": f"Finalized {finalized_reports} report(s). {failed_reports} failed.",
            "finalized_reports": finalized_reports,
            "failed_reports": failed_reports,
        }
    except Exception as e:
        return {"status": "FAILED", "error": str(e)}
    finally:
        if new_browser:
            new_browser.stop()
        elif action_page is not None:
            try:
                await action_page.close()
            except Exception:
                pass


async def ElRajhiFiller(
    browser,
    batch_id,
    tabs_num=3,
    pdf_only=False,
    company_url=None,
    finalize_submission=True,
):
    new_browser = None
    automation_surface_page = None
    try:
        # Create process for this batch
        process_id = f"elrajhi-filler-{batch_id}"
        process_manager = get_process_manager()

        record_data = await http_get(f"/new-scripts/batch/{batch_id}")
        raw_records = record_data.get("reports", [])
        print(
            f"[PY] ElRajhiFiller fetched batch {batch_id}: "
            f"success={record_data.get('success', True)} raw_count={len(raw_records)}",
            file=sys.stderr,
            flush=True,
        )

        # Deduplicate in case the batch contains repeated IDs
        seen_ids = set()
        report_records = []
        for rec in raw_records:
            rec_id = str(rec.get("_id"))
            if rec_id in seen_ids:
                continue
            seen_ids.add(rec_id)
            report_records.append(rec)

        if not report_records:
            return {
                "status": "FAILED",
                "error": f"No reports found for batch_id: {batch_id}",
            }

        if pdf_only:
            report_records = [
                report for report in report_records if not is_dummy_pdf(report)
            ]

        try:
            if company_url:
                if isinstance(company_url, dict):
                    set_selected_company(
                        company_url.get("url"),
                        name=company_url.get("name"),
                        office_id=company_url.get("officeId")
                        or company_url.get("office_id"),
                        sector_id=company_url.get("sectorId")
                        or company_url.get("sector_id"),
                    )
                else:
                    set_selected_company(company_url)
            require_selected_company()
            create_url = build_report_create_url()
        except Exception as ctx_err:
            return {"status": "FAILED", "error": str(ctx_err)}

        total_reports = len(report_records)

        # Create process state
        process_state = create_process(
            process_id=process_id,
            process_type="elrajhi-filler",
            total=total_reports,
            batch_id=batch_id,
            tabs_num=tabs_num,
            pdf_only=pdf_only,
            finalize_submission=finalize_submission,
            company_url=company_url,
        )

        await http_patch(f"/new-scripts/set-start-time-by-batch-id/{batch_id}")

        # ElRajhi runs in a dedicated window/tab on the authenticated Taqeem
        # browser. This avoids the Windows uc.start hang seen in check status.
        workflow_browser = None
        main_page = None
        workflow_browser, main_page, new_browser = await open_workflow_page(
            browser,
            force_spawn=True,
            headless=False,
        )

        if main_page is None:
            return {
                "status": "FAILED",
                "error": "No browser tab available for El Rajhi automation.",
            }
        automation_surface_page = main_page

        # Land on the selected office first (visible window + correct session scope)
        try:
            company_ctx = get_selected_company()
            org_url = (company_ctx.get("url") or "").strip()
            if org_url:
                emit_progress(
                    process_id,
                    message="Opening company page in automation browser...",
                )
                nav_result = await navigate_page_resilient(
                    main_page,
                    org_url,
                    label="company page",
                    timeout=35,
                    settle_seconds=2,
                )
                if nav_result.get("status") == "SUCCESS":
                    emit_progress(
                        process_id,
                        message="Company page ready. Starting report creation phase...",
                    )
                else:
                    emit_progress(
                        process_id,
                        message=nav_result.get("error")
                        or "Failed to open company page in automation browser.",
                    )
        except Exception as nav_err:
            log(
                f"ElRajhi: optional company page navigation failed: {nav_err}",
                "WARN",
            )

        # Array to collect macro IDs and their data
        macros_to_fill = []
        report_creation_results = []

        completed_reports = 0
        failed_reports = 0
        finalized_reports = 0
        finalization_failed = 0
        completed_macros = 0
        failed_macros = 0

        # Send initial progress using process controller
        emit_progress(process_id, message="Starting report creation phase...")

        # Phase 1: Create all reports sequentially and collect macro IDs
        for idx, report_record in enumerate(report_records):
            # Check pause/stop state using process controller
            action = await check_and_wait(process_id)
            if action == "stop":
                log(
                    f"Report creation stopped by user request for batch {batch_id}",
                    "INFO",
                )
                clear_process(process_id)
                return {
                    "status": "STOPPED",
                    "message": "Report creation stopped by user",
                    "completed": completed_reports,
                    "failed": failed_reports,
                    "total": total_reports,
                }

            try:
                # Update progress before processing
                await update_progress(
                    process_id, completed=completed_reports, failed=failed_reports
                )
                emit_progress(
                    process_id,
                    current_item=str(report_record["_id"]),
                    message=f"Creating report {completed_reports + 1}/{total_reports}",
                )

                # Create report and collect macro ID
                result = await create_report_and_collect_macro(
                    main_page,
                    report_record,
                    create_url,
                )

                if result.get("status") == "SUCCESS":
                    # Store macro info for later filling
                    macros_to_fill.append(
                        {
                            "macro_id": result["macro_id"],
                            "macro_data": result["macro_data"],
                            "report_id": result["report_id"],
                            "record_id": result["record_id"],
                        }
                    )
                    completed_reports += 1
                else:
                    failed_reports += 1

                report_creation_results.append(result)

                # Update progress after processing
                await update_progress(
                    process_id, completed=completed_reports, failed=failed_reports
                )
                emit_progress(
                    process_id,
                    current_item=str(report_record["_id"]),
                    message=f"Created report {completed_reports}/{total_reports}",
                )

            except Exception as e:
                failed_reports += 1
                error_result = {
                    "status": "FAILED",
                    "error": str(e),
                    "record_id": str(report_record["_id"]),
                }
                report_creation_results.append(error_result)

                # Update progress on error
                await update_progress(
                    process_id, completed=completed_reports, failed=failed_reports
                )
                emit_progress(
                    process_id,
                    current_item=str(report_record["_id"]),
                    message=f"Error creating report: {str(e)}",
                )

        log(
            f"Phase 1 complete: Created {completed_reports} reports, collected {len(macros_to_fill)} macros to fill",
            "INFO",
        )

        # Phase 2: Fill all macros in parallel using multiple tabs
        if macros_to_fill:
            # Update process for macro filling phase
            process_state.total += len(macros_to_fill)  # Add macros to total count
            process_state.metadata["phase"] = "macro_filling"

            # Create additional tabs for parallel macro filling
            tabs_num = max(1, min(int(tabs_num or 1), len(macros_to_fill)))
            pages = await open_workflow_pages(workflow_browser, main_page, tabs_num)

            # Split macros into balanced chunks
            macro_chunks = balanced_chunks(macros_to_fill, len(pages))

            completed_macros = 0
            failed_macros = 0
            total_macros = len(macros_to_fill)
            completed_lock = asyncio.Lock()

            # Send macro filling phase start
            emit_progress(
                process_id,
                message=f"Starting macro filling phase with {tabs_num} tabs...",
            )

            async def process_macro_chunk(macro_chunk, page, chunk_index):
                nonlocal \
                    completed_macros, \
                    failed_macros, \
                    finalized_reports, \
                    finalization_failed
                log(
                    f"Processing macro chunk {chunk_index} with {len(macro_chunk)} macros",
                    "INFO",
                )

                for macro_info in macro_chunk:
                    # Check pause/stop state
                    action = await check_and_wait(process_id)
                    if action == "stop":
                        log(
                            f"Macro chunk {chunk_index} stopped by user request", "INFO"
                        )
                        return

                    try:
                        # Update progress before filling
                        async with completed_lock:
                            current_completed = completed_macros
                            current_failed = failed_macros

                        emit_progress(
                            process_id,
                            current_item=macro_info["macro_id"],
                            message=f"Filling macro {current_completed + 1}/{total_macros}",
                        )

                        # Fill the macro
                        macro_result = await fill_macro_form(
                            page,
                            macro_id=macro_info["macro_id"],
                            macro_data=macro_info["macro_data"],
                            field_map=macro_form_config["field_map"],
                            field_types=macro_form_config["field_types"],
                        )

                        macro_failed = is_macro_fill_failed(macro_result)
                        if not macro_failed:
                            completion_result = await complete_macro_report(
                                page,
                                macro_info,
                                finalize_submission,
                            )
                            if finalize_submission:
                                if completion_result.get("finalization_succeeded"):
                                    finalized_reports += 1
                                else:
                                    finalization_failed += 1
                        elif finalize_submission:
                            finalization_failed += 1

                        async with completed_lock:
                            if macro_failed:
                                failed_macros += 1
                            completed_macros += 1
                            current_completed = completed_macros
                            current_failed = failed_macros

                        # Update overall progress (reports + macros)
                        await update_progress(
                            process_id,
                            completed=completed_reports + current_completed,
                            failed=failed_reports + current_failed,
                        )

                        emit_progress(
                            process_id,
                            current_item=macro_info["macro_id"],
                            message=f"Filled macro {current_completed}/{total_macros}",
                        )

                    except Exception as e:
                        async with completed_lock:
                            failed_macros += 1
                            completed_macros += 1
                            current_completed = completed_macros
                            current_failed = failed_macros

                        # Update progress on error
                        await update_progress(
                            process_id,
                            completed=completed_reports + current_completed,
                            failed=failed_reports + current_failed,
                        )
                        emit_progress(
                            process_id,
                            current_item=macro_info["macro_id"],
                            message=f"Error filling macro: {str(e)}",
                        )

            # Create tasks for parallel macro filling
            tasks = []
            for i, (page, macro_chunk) in enumerate(zip(pages, macro_chunks)):
                if macro_chunk:
                    tasks.append(process_macro_chunk(macro_chunk, page, i))

            await asyncio.gather(*tasks)
            log(
                f"Phase 2 complete: Filled {completed_macros} macros ({failed_macros} failed)",
                "INFO",
            )

            for page in pages[1:]:
                try:
                    await page.close()
                except Exception:
                    pass

        # Clear process state after completion
        clear_process(process_id)

        return {
            "status": "SUCCESS",
            "message": f"Completed processing batch",
            "reports_created": completed_reports,
            "reports_failed": failed_reports,
            "macros_filled": completed_macros if macros_to_fill else 0,
            "macros_failed": failed_macros if macros_to_fill else 0,
            "reports_finalized": finalized_reports
            if finalize_submission and macros_to_fill
            else 0,
            "finalization_failed": finalization_failed
            if finalize_submission and macros_to_fill
            else 0,
            "total_reports": total_reports,
            "results": report_creation_results,
        }

    except Exception as e:
        tb = traceback.format_exc()

        # Clear process state on error
        if "process_id" in locals():
            clear_process(process_id)

        return {"status": "FAILED", "error": str(e), "traceback": tb}

    finally:
        if automation_surface_page is not None:
            try:
                await automation_surface_page.close()
                print(
                    "[PY] ElRajhiFiller: closed automation window/tab.",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:
                pass
        if new_browser:
            new_browser.stop()


async def ElrajhiRetry(
    browser,
    batch_id,
    tabs_num=3,
    pdf_only=False,
    company_url=None,
    finalize_submission=False,
):
    new_browser = None
    automation_surface_page = None
    try:
        # Create process for retry
        process_id = f"elrajhi-retry-{batch_id}"
        process_manager = get_process_manager()

        # Fetch all report records with this batch_id
        reports_data = await http_get(f"/new-scripts/batch/{batch_id}")
        raw_records = reports_data.get("reports", [])

        # Deduplicate
        seen_ids = set()
        report_records = []
        for rec in raw_records:
            rec_id = str(rec.get("_id"))
            if rec_id in seen_ids:
                continue
            seen_ids.add(rec_id)
            report_records.append(rec)

        if not report_records:
            return {
                "status": "FAILED",
                "error": f"No reports found for batch_id: {batch_id}",
            }

        # Filter incomplete records: have report_id but submit_state is 0
        incomplete_records = [
            rec
            for rec in report_records
            if rec.get("report_id")
            and len(rec["report_id"]) >= 7
            and rec.get("submit_state") == 0
        ]

        # Filter non-created records: no report_id at all
        non_created_records = [
            rec
            for rec in report_records
            if not rec.get("report_id") or len(rec.get("report_id")) < 7
        ]

        if pdf_only:
            incomplete_records = [r for r in incomplete_records if not is_dummy_pdf(r)]
            non_created_records = [
                r for r in non_created_records if not is_dummy_pdf(r)
            ]

        total_incomplete = len(incomplete_records)
        total_non_created = len(non_created_records)
        total_records = total_incomplete + total_non_created

        if total_records == 0:
            return {
                "status": "SUCCESS",
                "message": "No records to retry",
                "incomplete": 0,
                "non_created": 0,
            }

        try:
            if company_url:
                if isinstance(company_url, dict):
                    set_selected_company(
                        company_url.get("url"),
                        name=company_url.get("name"),
                        office_id=company_url.get("officeId")
                        or company_url.get("office_id"),
                        sector_id=company_url.get("sectorId")
                        or company_url.get("sector_id"),
                    )
                else:
                    set_selected_company(company_url)
            require_selected_company()
            create_url = build_report_create_url()
        except Exception as ctx_err:
            return {"status": "FAILED", "error": str(ctx_err)}

        # Create process state
        process_state = create_process(
            process_id=process_id,
            process_type="elrajhi-retry",
            total=total_records,
            batch_id=batch_id,
            tabs_num=tabs_num,
            pdf_only=pdf_only,
            finalize_submission=finalize_submission,
            company_url=company_url,
            incomplete_count=total_incomplete,
            non_created_count=total_non_created,
        )

        # Use the same action surface strategy as Send all reports.
        workflow_browser, main_page, new_browser = await open_workflow_page(
            browser,
            force_spawn=True,
            headless=False,
        )
        if workflow_browser is None or main_page is None:
            return {"status": "FAILED", "error": "Could not open Taqeem action browser."}
        automation_surface_page = main_page

        # Counters
        completed_incomplete = 0
        failed_incomplete = 0
        completed_non_created = 0
        failed_non_created = 0
        finalized_reports = 0
        finalization_failed = 0

        macros_to_fill = []
        retry_results = []

        # Send initial progress
        emit_progress(
            process_id,
            message=f"Starting retry: {total_incomplete} incomplete, {total_non_created} non-created",
        )

        # ===== PHASE 1: Process incomplete records =====
        for idx, report_record in enumerate(incomplete_records):
            # Check pause/stop state
            action = await check_and_wait(process_id)
            if action == "stop":
                log(
                    f"Retry stopped by user request during incomplete phase for batch {batch_id}",
                    "INFO",
                )
                clear_process(process_id)
                return {
                    "status": "STOPPED",
                    "message": "Retry stopped by user",
                    "completed_incomplete": completed_incomplete,
                    "failed_incomplete": failed_incomplete,
                    "completed_non_created": completed_non_created,
                    "failed_non_created": failed_non_created,
                }

            try:
                report_id = report_record.get("report_id")

                # Update progress
                current_total = (
                    completed_incomplete
                    + completed_non_created
                    + failed_incomplete
                    + failed_non_created
                )
                await update_progress(process_id, completed=current_total, failed=0)
                emit_progress(
                    process_id,
                    current_item=str(report_record["_id"]),
                    message=f"Processing incomplete report {completed_incomplete + 1}/{total_incomplete}",
                )

                # Navigate to the report page
                report_url = f"https://qima.taqeem.gov.sa/report/{report_id}"
                await main_page.get(report_url)
                await asyncio.sleep(2)

                # Check if macro exists in table
                table = await wait_for_table_rows(main_page, timeout=10)
                macro_link = None
                if table:
                    macro_link = await wait_for_element(
                        main_page,
                        "#m-table tbody tr:first-child td:nth-child(1) a",
                        timeout=5,
                    )

                macro_id = None
                if macro_link:
                    # Macro exists, grab the ID
                    macro_id = macro_link.text.strip()
                    log(f"Found existing macro: {macro_id}", "INFO")
                else:
                    asset_create_url = (
                        f"https://qima.taqeem.gov.sa/report/asset/create/{report_id}"
                    )
                    main_page = await asyncio.wait_for(
                        workflow_browser.get(asset_create_url),
                        timeout=40.0,
                    )
                    await asyncio.sleep(1)
                    log(
                        f"No macro found for report {report_id}, creating one...",
                        "INFO",
                    )

                    # Import the create assets function
                    from .createMacros import run_create_assets_by_count

                    # Get macro data for this report
                    macro_data = extract_asset_from_report(report_record)

                    # Create one macro using the run_create_assets function
                    create_result = await run_create_assets_by_count(
                        browser=new_browser,
                        num_macros=1,
                        macro_data_template=macro_data,
                        tabs_num=1,
                    )

                    if create_result.get("status") == "FAILED":
                        raise Exception(
                            f"Failed to create macro: {create_result.get('error')}"
                        )

                    # Go back to report page to get the newly created macro ID
                    await main_page.get(report_url)
                    await asyncio.sleep(2)
                    await wait_for_table_rows(main_page)
                    macro_link = await wait_for_element(
                        main_page, "#m-table tbody tr:first-child td:nth-child(1) a"
                    )

                    if not macro_link:
                        raise Exception("Could not find newly created macro")

                    macro_id = macro_link.text.strip()
                    log(f"Created new macro: {macro_id}", "INFO")

                # Collect macro for filling
                macro_data = extract_asset_from_report(report_record)
                macros_to_fill.append(
                    {
                        "macro_id": macro_id,
                        "macro_data": macro_data,
                        "report_id": report_id,
                        "record_id": str(report_record["_id"]),
                    }
                )

                completed_incomplete += 1
                retry_results.append(
                    {
                        "status": "SUCCESS",
                        "type": "incomplete",
                        "report_id": report_id,
                        "macro_id": macro_id,
                        "record_id": str(report_record["_id"]),
                    }
                )

                # Update progress after processing
                current_total = (
                    completed_incomplete
                    + completed_non_created
                    + failed_incomplete
                    + failed_non_created
                )
                await update_progress(process_id, completed=current_total, failed=0)
                emit_progress(
                    process_id,
                    current_item=str(report_record["_id"]),
                    message=f"Processed incomplete report {completed_incomplete}/{total_incomplete}",
                )

            except Exception as e:
                failed_incomplete += 1
                error_result = {
                    "status": "FAILED",
                    "type": "incomplete",
                    "error": str(e),
                    "record_id": str(report_record["_id"]),
                    "report_id": report_record.get("report_id"),
                }
                retry_results.append(error_result)

                # Update progress on error
                current_total = (
                    completed_incomplete
                    + completed_non_created
                    + failed_incomplete
                    + failed_non_created
                )
                await update_progress(
                    process_id,
                    completed=current_total,
                    failed=failed_incomplete + failed_non_created,
                )
                emit_progress(
                    process_id,
                    current_item=str(report_record["_id"]),
                    message=f"Error processing incomplete report: {str(e)}",
                )

        log(
            f"Phase 1 complete: Processed {completed_incomplete} incomplete reports, {failed_incomplete} failed",
            "INFO",
        )

        # ===== PHASE 2: Process non-created records =====
        if non_created_records:
            emit_progress(process_id, message=f"Starting non-created reports phase...")

            for idx, report_record in enumerate(non_created_records):
                # Check pause/stop state
                action = await check_and_wait(process_id)
                if action == "stop":
                    log(
                        f"Retry stopped by user request during non-created phase for batch {batch_id}",
                        "INFO",
                    )
                    clear_process(process_id)
                    return {
                        "status": "STOPPED",
                        "message": "Retry stopped by user",
                        "completed_incomplete": completed_incomplete,
                        "failed_incomplete": failed_incomplete,
                        "completed_non_created": completed_non_created,
                        "failed_non_created": failed_non_created,
                    }

                try:
                    # Update progress
                    current_total = (
                        completed_incomplete
                        + completed_non_created
                        + failed_incomplete
                        + failed_non_created
                    )
                    await update_progress(
                        process_id,
                        completed=current_total,
                        failed=failed_incomplete + failed_non_created,
                    )
                    emit_progress(
                        process_id,
                        current_item=str(report_record["_id"]),
                        message=f"Creating report {completed_non_created + 1}/{total_non_created}",
                    )

                    # Create report and collect macro (same as ElRajhiFiller)
                    result = await create_report_and_collect_macro(
                        main_page,
                        report_record,
                        create_url,
                    )

                    if result.get("status") == "SUCCESS":
                        macros_to_fill.append(
                            {
                                "macro_id": result["macro_id"],
                                "macro_data": result["macro_data"],
                                "report_id": result["report_id"],
                                "record_id": result["record_id"],
                            }
                        )
                        completed_non_created += 1
                        retry_results.append({**result, "type": "non_created"})
                    else:
                        failed_non_created += 1
                        retry_results.append({**result, "type": "non_created"})

                    # Update progress after processing
                    current_total = (
                        completed_incomplete
                        + completed_non_created
                        + failed_incomplete
                        + failed_non_created
                    )
                    await update_progress(
                        process_id,
                        completed=current_total,
                        failed=failed_incomplete + failed_non_created,
                    )
                    emit_progress(
                        process_id,
                        current_item=str(report_record["_id"]),
                        message=f"Created report {completed_non_created}/{total_non_created}",
                    )

                except Exception as e:
                    failed_non_created += 1
                    error_result = {
                        "status": "FAILED",
                        "type": "non_created",
                        "error": str(e),
                        "record_id": str(report_record["_id"]),
                    }
                    retry_results.append(error_result)

                    # Update progress on error
                    current_total = (
                        completed_incomplete
                        + completed_non_created
                        + failed_incomplete
                        + failed_non_created
                    )
                    await update_progress(
                        process_id,
                        completed=current_total,
                        failed=failed_incomplete + failed_non_created,
                    )
                    emit_progress(
                        process_id,
                        current_item=str(report_record["_id"]),
                        message=f"Error creating report: {str(e)}",
                    )

            log(
                f"Phase 2 complete: Created {completed_non_created} reports, {failed_non_created} failed",
                "INFO",
            )

        # ===== PHASE 3: Fill all collected macros in parallel =====
        if macros_to_fill:
            # Update process for macro filling phase
            process_state.total += len(macros_to_fill)  # Add macros to total count
            process_state.metadata["phase"] = "macro_filling"

            tabs_num = max(1, min(int(tabs_num or 1), len(macros_to_fill)))
            pages = await open_workflow_pages(workflow_browser, main_page, tabs_num)

            macro_chunks = balanced_chunks(macros_to_fill, len(pages))

            completed_macros = 0
            failed_macros = 0
            total_macros = len(macros_to_fill)
            completed_lock = asyncio.Lock()

            # Send macro filling phase start
            emit_progress(
                process_id,
                message=f"Starting macro filling phase with {tabs_num} tabs...",
            )

            async def process_macro_chunk(macro_chunk, page, chunk_index):
                nonlocal \
                    completed_macros, \
                    failed_macros, \
                    finalized_reports, \
                    finalization_failed

                for macro_info in macro_chunk:
                    # Check pause/stop state
                    action = await check_and_wait(process_id)
                    if action == "stop":
                        log(
                            f"Macro chunk {chunk_index} stopped by user request", "INFO"
                        )
                        return

                    try:
                        # Update progress before filling
                        async with completed_lock:
                            current_completed = completed_macros
                            current_failed = failed_macros

                        emit_progress(
                            process_id,
                            current_item=macro_info["macro_id"],
                            message=f"Filling macro {current_completed + 1}/{total_macros}",
                        )

                        # Fill the macro
                        macro_result = await fill_macro_form(
                            page,
                            macro_id=macro_info["macro_id"],
                            macro_data=macro_info["macro_data"],
                            field_map=macro_form_config["field_map"],
                            field_types=macro_form_config["field_types"],
                        )

                        macro_failed = is_macro_fill_failed(macro_result)
                        if not macro_failed:
                            completion_result = await complete_macro_report(
                                page,
                                macro_info,
                                finalize_submission,
                            )
                            if finalize_submission:
                                if completion_result.get("finalization_succeeded"):
                                    finalized_reports += 1
                                else:
                                    finalization_failed += 1
                        elif finalize_submission:
                            finalization_failed += 1

                        async with completed_lock:
                            if macro_failed:
                                failed_macros += 1
                            completed_macros += 1
                            current_completed = completed_macros
                            current_failed = failed_macros

                        # Update overall progress
                        total_completed = (
                            completed_incomplete
                            + completed_non_created
                            + current_completed
                        )
                        total_failed = (
                            failed_incomplete + failed_non_created + current_failed
                        )
                        await update_progress(
                            process_id, completed=total_completed, failed=total_failed
                        )

                        emit_progress(
                            process_id,
                            current_item=macro_info["macro_id"],
                            message=f"Filled macro {current_completed}/{total_macros}",
                        )

                    except Exception as e:
                        async with completed_lock:
                            failed_macros += 1
                            completed_macros += 1
                            current_completed = completed_macros
                            current_failed = failed_macros

                        # Update progress on error
                        total_completed = (
                            completed_incomplete
                            + completed_non_created
                            + current_completed
                        )
                        total_failed = (
                            failed_incomplete + failed_non_created + current_failed
                        )
                        await update_progress(
                            process_id, completed=total_completed, failed=total_failed
                        )
                        emit_progress(
                            process_id,
                            current_item=macro_info["macro_id"],
                            message=f"Error filling macro: {str(e)}",
                        )

            # Create tasks for parallel macro filling
            tasks = []
            for i, (page, macro_chunk) in enumerate(zip(pages, macro_chunks)):
                if macro_chunk:
                    tasks.append(process_macro_chunk(macro_chunk, page, i))

            await asyncio.gather(*tasks)

            # Close extra tabs
            for page in pages[1:]:
                await page.close()

            log(
                f"Phase 3 complete: Filled {completed_macros} macros ({failed_macros} failed)",
                "INFO",
            )

        # Clear process state after completion
        clear_process(process_id)

        return {
            "status": "SUCCESS",
            "message": "Completed retry processing",
            "incomplete_processed": completed_incomplete,
            "incomplete_failed": failed_incomplete,
            "non_created_processed": completed_non_created,
            "non_created_failed": failed_non_created,
            "macros_filled": completed_macros if macros_to_fill else 0,
            "macros_failed": failed_macros if macros_to_fill else 0,
            "reports_finalized": finalized_reports
            if finalize_submission and macros_to_fill
            else 0,
            "finalization_failed": finalization_failed
            if finalize_submission and macros_to_fill
            else 0,
            "total_incomplete": total_incomplete,
            "total_non_created": total_non_created,
            "results": retry_results,
        }

    except Exception as e:
        tb = traceback.format_exc()

        # Clear process state on error
        if "process_id" in locals():
            clear_process(process_id)

        return {"status": "FAILED", "error": str(e), "traceback": tb}

    finally:
        if automation_surface_page is not None and not new_browser:
            try:
                await automation_surface_page.close()
            except Exception:
                pass
        if new_browser:
            new_browser.stop()


async def ElrajhiRetryByReportIds(
    browser,
    report_ids,
    tabs_num=3,
    pdf_only=False,
    company_url=None,
    finalize_submission=False,
):
    new_browser = None
    automation_surface_page = None
    try:
        if not report_ids:
            return {"status": "FAILED", "error": "report_ids array is empty"}

        # Create stable process id
        process_id = f"elrajhi-retry-report-ids-{hash(tuple(sorted(report_ids)))}"
        process_manager = get_process_manager()

        # Fetch records by report_ids
        record_data = await http_get("new-scripts/bulk/report_id", json=report_ids)
        raw_records = record_data.get("reports", [])

        # Deduplicate
        seen_ids = set()
        report_records = []
        for rec in raw_records:
            rid = str(rec["_id"])
            if rid not in seen_ids:
                seen_ids.add(rid)
                report_records.append(rec)

        if not report_records:
            return {
                "status": "FAILED",
                "error": "No matching records found for provided report_ids",
            }

        if pdf_only:
            report_records = [r for r in report_records if not is_dummy_pdf(r)]

        # Split records
        incomplete_records = [
            r
            for r in report_records
            if r.get("report_id")
            and len(r["report_id"]) >= 7
            and r.get("submit_state") == 0
        ]

        non_created_records = [
            r
            for r in report_records
            if not r.get("report_id") or len(r.get("report_id", "")) < 7
        ]

        total_records = len(incomplete_records) + len(non_created_records)
        if total_records == 0:
            return {"status": "SUCCESS", "message": "Nothing to retry"}

        # Company context
        try:
            if company_url:
                if isinstance(company_url, dict):
                    set_selected_company(
                        company_url.get("url"),
                        name=company_url.get("name"),
                        office_id=company_url.get("officeId")
                        or company_url.get("office_id"),
                        sector_id=company_url.get("sectorId")
                        or company_url.get("sector_id"),
                    )
                else:
                    set_selected_company(company_url)
            require_selected_company()
            create_url = build_report_create_url()
        except Exception as e:
            return {"status": "FAILED", "error": str(e)}

        # Process state
        process_state = create_process(
            process_id=process_id,
            process_type="elrajhi-retry-report-ids",
            total=total_records,
            report_ids=report_ids,
            tabs_num=tabs_num,
            pdf_only=pdf_only,
            finalize_submission=finalize_submission,
        )

        workflow_browser, main_page, new_browser = await open_workflow_page(
            browser,
            force_spawn=True,
            headless=False,
        )
        if workflow_browser is None or main_page is None:
            return {"status": "FAILED", "error": "Could not open Taqeem action browser."}
        automation_surface_page = main_page

        macros_to_fill = []
        results = []

        completed = failed = 0
        finalized_reports = finalization_failed = 0

        emit_progress(process_id, message=f"Starting retry for {total_records} reports")

        # ---- PHASE 1: INCOMPLETE REPORTS ----
        for rec in incomplete_records:
            action = await check_and_wait(process_id)
            if action == "stop":
                clear_process(process_id)
                return {"status": "STOPPED"}

            try:
                report_id = rec["report_id"]
                report_url = f"https://qima.taqeem.gov.sa/report/{report_id}"

                await main_page.get(report_url)
                await asyncio.sleep(2)
                await wait_for_table_rows(main_page, timeout=5)

                macro_link = await wait_for_element(
                    main_page,
                    "#m-table tbody tr:first-child td:nth-child(1) a",
                    timeout=5,
                )

                if not macro_link:
                    raise Exception("No macro found")

                macro_id = macro_link.text.strip()

                macros_to_fill.append(
                    {
                        "macro_id": macro_id,
                        "macro_data": extract_asset_from_report(rec),
                        "report_id": report_id,
                        "record_id": str(rec["_id"]),
                    }
                )

                completed += 1
                results.append(
                    {"status": "SUCCESS", "type": "incomplete", "report_id": report_id}
                )

            except Exception as e:
                failed += 1
                results.append(
                    {
                        "status": "FAILED",
                        "type": "incomplete",
                        "error": str(e),
                        "record_id": str(rec["_id"]),
                    }
                )

            await update_progress(process_id, completed=completed, failed=failed)

        # ---- PHASE 2: NON-CREATED REPORTS ----
        for rec in non_created_records:
            action = await check_and_wait(process_id)
            if action == "stop":
                clear_process(process_id)
                return {"status": "STOPPED"}

            result = await create_report_and_collect_macro(main_page, rec, create_url)

            if result.get("status") == "SUCCESS":
                macros_to_fill.append(result)
                completed += 1
            else:
                failed += 1

            results.append(result)
            await update_progress(process_id, completed=completed, failed=failed)

        # ---- PHASE 3: MACRO FILLING ----
        if macros_to_fill:
            process_state.total += len(macros_to_fill)
            pages = await open_workflow_pages(
                workflow_browser,
                main_page,
                min(tabs_num, len(macros_to_fill)),
            )

            chunks = balanced_chunks(macros_to_fill, len(pages))
            lock = asyncio.Lock()
            filled = failed_macros = 0

            async def worker(chunk, page):
                nonlocal filled, failed_macros, finalized_reports, finalization_failed

                for m in chunk:
                    action = await check_and_wait(process_id)
                    if action == "stop":
                        return

                    try:
                        res = await fill_macro_form(
                            page,
                            m["macro_id"],
                            m["macro_data"],
                            macro_form_config["field_map"],
                            macro_form_config["field_types"],
                        )

                        macro_failed = is_macro_fill_failed(res)
                        if not macro_failed:
                            completion_result = await complete_macro_report(
                                page,
                                m,
                                finalize_submission,
                            )
                            if finalize_submission:
                                if completion_result.get("finalization_succeeded"):
                                    finalized_reports += 1
                                else:
                                    finalization_failed += 1
                        elif finalize_submission:
                            finalization_failed += 1

                        async with lock:
                            filled += 1
                            if macro_failed:
                                failed_macros += 1

                    except Exception:
                        async with lock:
                            filled += 1
                            failed_macros += 1

                    await update_progress(
                        process_id,
                        completed=completed + filled,
                        failed=failed + failed_macros,
                    )

            await asyncio.gather(*[worker(c, p) for c, p in zip(chunks, pages) if c])

            for p in pages[1:]:
                await p.close()

        clear_process(process_id)

        return {
            "status": "SUCCESS",
            "reports_processed": completed,
            "reports_failed": failed,
            "macros_filled": filled if macros_to_fill else 0,
            "macros_failed": failed_macros if macros_to_fill else 0,
            "reports_finalized": finalized_reports,
            "finalization_failed": finalization_failed,
            "results": results,
        }

    except Exception as e:
        clear_process(process_id)
        return {
            "status": "FAILED",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }

    finally:
        if automation_surface_page is not None and not new_browser:
            try:
                await automation_surface_page.close()
            except Exception:
                pass
        if new_browser:
            new_browser.stop()


async def ElrajhiRetryByRecordIds(
    browser,
    record_ids,
    tabs_num=3,
    pdf_only=False,
    company_url=None,
    finalize_submission=False,
):
    new_browser = None
    automation_surface_page = None
    try:
        if not record_ids:
            return {"status": "FAILED", "error": "record_ids array is empty"}

        process_id = f"elrajhi-retry-record-ids-{hash(tuple(sorted([str(r) for r in record_ids])))}"
        process_manager = get_process_manager()

        records_data = await http_get(
            "new-scripts/bulk", json={"record_ids": record_ids}
        )
        raw_records = records_data.get("reports", [])

        # Deduplicate
        seen_ids = set()
        report_records = []
        for rec in raw_records:
            rid = str(rec["_id"])
            if rid not in seen_ids:
                seen_ids.add(rid)
                report_records.append(rec)

        if not report_records:
            return {
                "status": "FAILED",
                "error": "No matching records found for provided record_ids",
            }

        if pdf_only:
            report_records = [r for r in report_records if not is_dummy_pdf(r)]

        incomplete_records = [
            r
            for r in report_records
            if r.get("report_id")
            and len(r["report_id"]) >= 7
            and r.get("submit_state") == 0
        ]

        non_created_records = [
            r
            for r in report_records
            if not r.get("report_id") or len(r.get("report_id", "")) < 7
        ]

        total_records = len(incomplete_records) + len(non_created_records)
        if total_records == 0:
            return {"status": "SUCCESS", "message": "Nothing to retry"}

        try:
            if company_url:
                if isinstance(company_url, dict):
                    set_selected_company(
                        company_url.get("url"),
                        name=company_url.get("name"),
                        office_id=company_url.get("officeId")
                        or company_url.get("office_id"),
                        sector_id=company_url.get("sectorId")
                        or company_url.get("sector_id"),
                    )
                else:
                    set_selected_company(company_url)
            require_selected_company()
            create_url = build_report_create_url()
        except Exception as e:
            return {"status": "FAILED", "error": str(e)}

        process_state = create_process(
            process_id=process_id,
            process_type="elrajhi-retry-record-ids",
            total=total_records,
            record_ids=[str(r) for r in record_ids],
            tabs_num=tabs_num,
            pdf_only=pdf_only,
            finalize_submission=finalize_submission,
        )

        workflow_browser, main_page, new_browser = await open_workflow_page(
            browser,
            force_spawn=True,
            headless=False,
        )
        if workflow_browser is None or main_page is None:
            return {"status": "FAILED", "error": "Could not open Taqeem action browser."}
        automation_surface_page = main_page

        macros_to_fill = []
        results = []

        completed = failed = 0
        finalized_reports = finalization_failed = 0

        emit_progress(process_id, message=f"Starting retry for {total_records} reports")

        # ---- PHASE 1: INCOMPLETE REPORTS ----
        for rec in incomplete_records:
            action = await check_and_wait(process_id)
            if action == "stop":
                clear_process(process_id)
                return {"status": "STOPPED"}

            try:
                report_id = rec["report_id"]
                report_url = f"https://qima.taqeem.gov.sa/report/{report_id}"

                await main_page.get(report_url)
                await asyncio.sleep(2)
                await wait_for_table_rows(main_page, timeout=5)

                macro_link = await wait_for_element(
                    main_page,
                    "#m-table tbody tr:first-child td:nth-child(1) a",
                    timeout=5,
                )

                if not macro_link:
                    raise Exception("No macro found")

                macro_id = macro_link.text.strip()

                macros_to_fill.append(
                    {
                        "macro_id": macro_id,
                        "macro_data": extract_asset_from_report(rec),
                        "report_id": report_id,
                        "record_id": str(rec["_id"]),
                    }
                )

                completed += 1
                results.append(
                    {"status": "SUCCESS", "type": "incomplete", "report_id": report_id}
                )

            except Exception as e:
                failed += 1
                results.append(
                    {
                        "status": "FAILED",
                        "type": "incomplete",
                        "error": str(e),
                        "record_id": str(rec["_id"]),
                    }
                )

            await update_progress(process_id, completed=completed, failed=failed)

        # ---- PHASE 2: NON-CREATED REPORTS ----
        for rec in non_created_records:
            action = await check_and_wait(process_id)
            if action == "stop":
                clear_process(process_id)
                return {"status": "STOPPED"}

            result = await create_report_and_collect_macro(main_page, rec, create_url)

            if result.get("status") == "SUCCESS":
                macros_to_fill.append(result)
                completed += 1
            else:
                failed += 1

            results.append(result)
            await update_progress(process_id, completed=completed, failed=failed)

        # ---- PHASE 3: MACRO FILLING ----
        if macros_to_fill:
            process_state.total += len(macros_to_fill)
            pages = await open_workflow_pages(
                workflow_browser,
                main_page,
                min(tabs_num, len(macros_to_fill)),
            )

            chunks = balanced_chunks(macros_to_fill, len(pages))
            lock = asyncio.Lock()
            filled = failed_macros = 0

            async def worker(chunk, page):
                nonlocal filled, failed_macros, finalized_reports, finalization_failed

                for m in chunk:
                    action = await check_and_wait(process_id)
                    if action == "stop":
                        return

                    try:
                        res = await fill_macro_form(
                            page,
                            m["macro_id"],
                            m["macro_data"],
                            macro_form_config["field_map"],
                            macro_form_config["field_types"],
                        )

                        macro_failed = is_macro_fill_failed(res)
                        if not macro_failed:
                            completion_result = await complete_macro_report(
                                page,
                                m,
                                finalize_submission,
                            )
                            if finalize_submission:
                                if completion_result.get("finalization_succeeded"):
                                    finalized_reports += 1
                                else:
                                    finalization_failed += 1
                        elif finalize_submission:
                            finalization_failed += 1

                        async with lock:
                            filled += 1
                            if macro_failed:
                                failed_macros += 1

                    except Exception:
                        async with lock:
                            filled += 1
                            failed_macros += 1

                    await update_progress(
                        process_id,
                        completed=completed + filled,
                        failed=failed + failed_macros,
                    )

            await asyncio.gather(*[worker(c, p) for c, p in zip(chunks, pages) if c])

            for p in pages[1:]:
                await p.close()

        clear_process(process_id)

        return {
            "status": "SUCCESS",
            "reports_processed": completed,
            "reports_failed": failed,
            "macros_filled": filled if macros_to_fill else 0,
            "macros_failed": failed_macros if macros_to_fill else 0,
            "reports_finalized": finalized_reports,
            "finalization_failed": finalization_failed,
            "results": results,
        }

    except Exception as e:
        clear_process(process_id)
        return {
            "status": "FAILED",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }

    finally:
        if automation_surface_page is not None and not new_browser:
            try:
                await automation_surface_page.close()
            except Exception:
                pass
        if new_browser:
            new_browser.stop()


async def pause_batch(batch_id):
    """Pause batch processing"""
    try:
        state = set_pause_state(batch_id, paused=True)
        return {
            "status": "SUCCESS",
            "message": f"Paused batch processing for {batch_id}",
            "paused": state["paused"],
        }
    except Exception as e:
        return {"status": "FAILED", "error": str(e)}


async def pause_batch(batch_id):
    """Pause ElRajhi batch processing"""
    try:
        process_manager = get_process_manager()

        # Try both process types
        for process_type in ["elrajhi-filler", "elrajhi-retry"]:
            process_id = f"{process_type}-{batch_id}"
            state = process_manager.pause_process(process_id)
            if state:
                return {
                    "status": "SUCCESS",
                    "message": f"Paused {process_type} for batch {batch_id}",
                    "paused": state.paused,
                    "process_type": process_type,
                }

        return {
            "status": "FAILED",
            "error": f"No active process found for batch {batch_id}",
        }
    except Exception as e:
        return {"status": "FAILED", "error": str(e)}


async def resume_batch(batch_id):
    """Resume ElRajhi batch processing"""
    try:
        process_manager = get_process_manager()

        # Try both process types
        for process_type in ["elrajhi-filler", "elrajhi-retry"]:
            process_id = f"{process_type}-{batch_id}"
            state = process_manager.resume_process(process_id)
            if state:
                return {
                    "status": "SUCCESS",
                    "message": f"Resumed {process_type} for batch {batch_id}",
                    "paused": state.paused,
                    "process_type": process_type,
                }

        return {
            "status": "FAILED",
            "error": f"No active process found for batch {batch_id}",
        }
    except Exception as e:
        return {"status": "FAILED", "error": str(e)}


async def stop_batch(batch_id):
    """Stop ElRajhi batch processing"""
    try:
        process_manager = get_process_manager()

        # Try both process types
        for process_type in ["elrajhi-filler", "elrajhi-retry"]:
            process_id = f"{process_type}-{batch_id}"
            state = process_manager.stop_process(process_id)
            if state:
                return {
                    "status": "SUCCESS",
                    "message": f"Stopped {process_type} for batch {batch_id}",
                    "stopped": state.stopped,
                    "process_type": process_type,
                }

        return {
            "status": "FAILED",
            "error": f"No active process found for batch {batch_id}",
        }
    except Exception as e:
        return {"status": "FAILED", "error": str(e)}
