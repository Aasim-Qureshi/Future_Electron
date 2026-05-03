import asyncio
import json
import os
import sys
import traceback
from datetime import datetime, timezone

from scripts.core.httpClient import http_get, http_patch
from scripts.core.utils import wait_for_element, wait_for_table_rows
from scripts.submission.ElRajhiFiller import (
    complete_macro_report,
    extract_asset_from_report,
    is_macro_fill_failed,
    open_workflow_page,
)

from .formSteps import macro_form_config
from .macroFiller import fill_macro_form
from .validateReport import check_report_existence

VALID_STATUSES = {"INCOMPLETE", "COMPLETE", "SENT", "CONFIRMED"}
SENT_BUTTON_MARKER = 'id="reject"'
SENT_STATUS_LABEL = "حالة التقرير"
SENT_STATUS_VALUE = "مرسل"
CONFIRMED_BUTTON_TEXT = "شهادة التسجيل"


def chunk_items(items, n):
    """Split items into n reasonably balanced chunks (one chunk per parallel tab)."""
    n = max(1, n)
    k, m = divmod(len(items), n)
    chunks = []
    start = 0
    for i in range(n):
        size = k + (1 if i < m else 0)
        chunks.append(items[start : start + size])
        start += size
    return chunks


async def _mark_submit_state(
    report, submit_state, report_status=None, clear_report_id=False
):
    update = {
        "submit_state": submit_state,
    }

    if report_status:
        update["report_status"] = report_status

    if clear_report_id:
        update["report_id"] = None

    record_id = report.get("_id")
    await http_patch(
        f"/new-scripts/update-elrajhi-status/{record_id}",
        json=update,
    )


async def _check_single_report(page, report):
    report_id = report.get("report_id")
    if not report_id:
        await _mark_submit_state(report, 0, "INCOMPLETE")
        return {
            "batchId": report.get("batch_id"),
            "reportId": None,
            "status": "INCOMPLETE",
            "reason": "missing_report_id",
            "client_name": report.get("client_name"),
            "asset_name": report.get("asset_name"),
            "macroId": None,
        }

    try:
        url = f"https://qima.taqeem.gov.sa/report/{report_id}"
        await page.get(url)
        await asyncio.sleep(0.45)

        # -------------------------------
        # Existence: skip second navigation (caller already loaded report URL).
        # -------------------------------
        existence = await check_report_existence(
            page, report_id, skip_navigation=True
        )

        if not existence.get("exists"):
            await _mark_submit_state(report, -1, "NOT_FOUND", clear_report_id=True)
            return {
                "batchId": report.get("batch_id"),
                "reportId": report_id,
                "status": "NOT_FOUND",
                "reason": "report_not_accessible_or_missing",
                "client_name": report.get("client_name"),
                "asset_name": report.get("asset_name"),
                "checkedAt": datetime.now(timezone.utc).isoformat(),
            }

        # -------------------------------
        # Existing logic (UNCHANGED)
        # -------------------------------
        delete_btn = await wait_for_element(page, "#delete_report", timeout=8)
        submit_state = 1 if delete_btn else 0
        status_value = "COMPLETE" if submit_state else "INCOMPLETE"
        macro_id = None

        if not delete_btn:
            try:
                table_ready = await wait_for_table_rows(page, timeout=5)
                if table_ready:
                    macro_link = await wait_for_element(
                        page,
                        "#m-table tbody tr:first-child td:nth-child(1) a",
                        timeout=5,
                    )
                    if macro_link and macro_link.text:
                        macro_id = macro_link.text.strip()
            except Exception:
                macro_id = None

        try:
            html = await page.get_content()
        except Exception:
            html = ""

        html_lower = html.lower() if isinstance(html, str) else ""
        has_sent_marker = (
            SENT_BUTTON_MARKER in html_lower or 'name="reject"' in html_lower
        )
        has_sent_status_text = (
            isinstance(html, str)
            and SENT_STATUS_LABEL in html
            and SENT_STATUS_VALUE in html
        )
        has_confirmed_marker = isinstance(html, str) and CONFIRMED_BUTTON_TEXT in html

        if has_sent_marker or has_sent_status_text:
            status_value = "SENT"
            submit_state = 1

        if has_confirmed_marker:
            status_value = "CONFIRMED"
            submit_state = 1

        await _mark_submit_state(report, submit_state, status_value)

        return {
            "batchId": report.get("batch_id"),
            "reportId": report_id,
            "status": status_value,
            "reportStatus": status_value,
            "client_name": report.get("client_name"),
            "asset_name": report.get("asset_name"),
            "macroId": macro_id,
            "checkedAt": datetime.now(timezone.utc).isoformat(),
            "markers": {
                "hasDeleteButton": bool(delete_btn),
                "hasRejectButton": has_sent_marker,
                "hasCertificateButton": has_confirmed_marker,
            },
        }

    except Exception as e:
        await _mark_submit_state(report, 0, "INCOMPLETE")
        return {
            "batchId": report.get("batch_id"),
            "reportId": report_id,
            "status": "FAILED",
            "error": str(e),
            "client_name": report.get("client_name"),
            "asset_name": report.get("asset_name"),
        }


def _elrajhi_check_env_float(name, default):
    raw = os.getenv(name, "").strip()
    if not raw:
        return float(default)
    try:
        return float(raw)
    except ValueError:
        return float(default)


def _elrajhi_check_env_int(name, default, lo=1, hi=32):
    raw = os.getenv(name, "").strip()
    if not raw:
        v = int(default)
    else:
        try:
            v = int(raw)
        except ValueError:
            v = int(default)
    return max(lo, min(hi, v))


async def check_elrajhi_batches(browser, batch_id=None, tabs_num=3):
    """
    Refresh Taqeem status for reports in a batch using parallel browser tabs.

    ``tabs_num`` should match the UI \"recommended tabs\" (RAM-based). Work is
    split across that many tabs with asyncio.gather. A short stagger between
    tab workers reduces CDP load spikes; tune via ELRAJHI_CHECK_TAB_STAGGER_SEC.
    """
    per_report_timeout = _elrajhi_check_env_float(
        "ELRAJHI_CHECK_REPORT_TIMEOUT_SEC", 95.0
    )
    pause_intra = _elrajhi_check_env_float("ELRAJHI_CHECK_BETWEEN_REPORTS_SEC", 0.08)
    recover_timeout = _elrajhi_check_env_float(
        "ELRAJHI_CHECK_RECOVER_NAV_TIMEOUT_SEC", 14.0
    )
    stagger_sec = _elrajhi_check_env_float("ELRAJHI_CHECK_TAB_STAGGER_SEC", 0.2)

    max_tabs_cap = _elrajhi_check_env_int("ELRAJHI_CHECK_MAX_TABS", 16, 1, 32)
    requested = max(1, int(tabs_num or 3))

    report_data = await http_get(f"/new-scripts/batch/{batch_id}")
    reports = report_data.get("reports", [])

    if not reports:
        return {
            "status": "FAILED",
            "error": "No reports found for provided batch"
            if batch_id
            else "No reports found",
        }

    effective_tabs = min(len(reports), requested, max_tabs_cap)

    print(
        f"[PY] ElRajhiChecker: batch_id={batch_id} reports={len(reports)} "
        f"parallel_tabs={effective_tabs} (requested={requested} cap={max_tabs_cap}) "
        f"timeout={per_report_timeout}s stagger={stagger_sec}s",
        file=sys.stderr,
        flush=True,
    )

    workflow_browser = None
    main_page = None
    new_browser = None
    pages = []
    try:
        workflow_browser, main_page, new_browser = await open_workflow_page(
            browser,
            force_spawn=True,
        )
        if workflow_browser is None or main_page is None:
            return {
                "status": "FAILED",
                "error": "Could not open Taqeem action browser.",
            }

        print(
            f"[PY] ElRajhiChecker: action browser ready; checking {len(reports)} report(s)",
            file=sys.stderr,
            flush=True,
        )

        async def recover_stuck_tab(page):
            try:
                await asyncio.wait_for(
                    page.get("about:blank"),
                    timeout=recover_timeout,
                )
                await asyncio.sleep(0.12)
            except Exception as err:
                print(
                    json.dumps(
                        {
                            "event": "elrajhi-check-recover",
                            "warning": str(err) or type(err).__name__,
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                )

        tabs = effective_tabs
        pages = [main_page]
        try:
            extra_pages = []
            for _ in range(max(0, tabs - 1)):
                try:
                    extra_pages.append(
                        await asyncio.wait_for(
                            workflow_browser.get("about:blank", new_tab=True),
                            timeout=30.0,
                        )
                    )
                except Exception:
                    break
            pages = [main_page] + extra_pages
        except Exception:
            pages = [main_page]

        chunks = chunk_items(reports, len(pages))

        async def process_chunk(page, chunk, worker_index):
            await asyncio.sleep(stagger_sec * worker_index)
            out = []
            for rep in chunk:
                try:
                    res = await asyncio.wait_for(
                        _check_single_report(page, rep),
                        timeout=per_report_timeout,
                    )
                except asyncio.TimeoutError:
                    await recover_stuck_tab(page)
                    res = {
                        "batchId": rep.get("batch_id") or batch_id,
                        "reportId": rep.get("report_id"),
                        "status": "FAILED",
                        "error": "Status check timed out for this report",
                        "client_name": rep.get("client_name"),
                        "asset_name": rep.get("asset_name"),
                    }
                except Exception as err:
                    await recover_stuck_tab(page)
                    res = {
                        "batchId": rep.get("batch_id") or batch_id,
                        "reportId": rep.get("report_id"),
                        "status": "FAILED",
                        "error": str(err) or type(err).__name__,
                        "client_name": rep.get("client_name"),
                        "asset_name": rep.get("asset_name"),
                    }
                print(json.dumps({"event": "elrajhi-check", **res}), flush=True)
                out.append(res)
                await asyncio.sleep(pause_intra)
            return out

        parts = await asyncio.gather(
            *(
                process_chunk(p, c, i)
                for i, (p, c) in enumerate(zip(pages, chunks))
            )
        )
        results = [item for part in parts for item in part]

        grouped = {}
        for item in results:
            key = item.get("batchId") or batch_id or "unknown"
            grouped.setdefault(key, {"batchId": key, "reports": []})
            grouped[key]["reports"].append(item)

        for group in grouped.values():
            sent = 0
            confirmed = 0
            complete = 0

            for r in group["reports"]:
                status = (r.get("status") or "").upper()
                if status == "SENT":
                    sent += 1
                if status == "CONFIRMED":
                    confirmed += 1
                if status in ("COMPLETE", "SENT", "CONFIRMED"):
                    complete += 1

            group["complete"] = complete
            group["sent"] = sent
            group["confirmed"] = confirmed
            group["total"] = len(group["reports"])
            group["incomplete"] = group["total"] - complete

        return {"status": "SUCCESS", "batches": list(grouped.values())}
    finally:
        if new_browser:
            new_browser.stop()
        else:
            for page in pages:
                try:
                    await page.close()
                except Exception:
                    pass


async def reupload_elrajhi_report(browser, report_id):
    """Refill macro data for a specific ElRajhi report and finalize it."""
    if not report_id:
        return {"status": "FAILED", "error": "reportId is required"}

    report_data = await http_get(f"/new-scripts/report-id/{report_id}")
    report = report_data.get("report")
    if not report:
        return {
            "status": "FAILED",
            "error": f"Report {report_id} not found in database",
        }

    new_browser = None
    action_page = None
    try:
        workflow_browser, page, new_browser = await open_workflow_page(
            browser,
            force_spawn=True,
        )
        if workflow_browser is None or page is None:
            return {
                "status": "FAILED",
                "error": "Could not open Taqeem action browser.",
            }
        action_page = page

        await page.get(f"https://qima.taqeem.gov.sa/report/{report_id}")
        await asyncio.sleep(1)

        macro_link = await wait_for_element(
            page, "#m-table tbody tr:first-child td:nth-child(1) a", timeout=12
        )
        if not macro_link or not macro_link.text:
            return {"status": "FAILED", "error": "Could not locate macro id for report"}

        macro_id = macro_link.text.strip()
        macro_data = extract_asset_from_report(report)

        macro_result = await fill_macro_form(
            page,
            macro_id=macro_id,
            macro_data=macro_data,
            field_map=macro_form_config["field_map"],
            field_types=macro_form_config["field_types"],
        )

        if is_macro_fill_failed(macro_result):
            await _mark_submit_state(report, 0, "INCOMPLETE")
            return {
                "status": "FAILED",
                "reportId": report_id,
                "macroId": macro_id,
                "submitState": 0,
                "reportStatus": "INCOMPLETE",
                "macroResult": macro_result,
            }

        completion_result = await complete_macro_report(
            page,
            {
                "macro_id": macro_id,
                "macro_data": macro_data,
                "report_id": report_id,
                "record_id": str(report["_id"]),
            },
            True,
        )

        submit_state = 1
        status_value = (
            "SENT" if completion_result.get("finalization_succeeded") else "COMPLETE"
        )

        return {
            "status": "SUCCESS"
            if completion_result.get("finalization_succeeded")
            else "FAILED",
            "reportId": report_id,
            "macroId": macro_id,
            "submitState": submit_state,
            "reportStatus": status_value,
            "macroResult": macro_result,
            "finalize": completion_result.get("finalization"),
        }
    except Exception as e:
        tb = traceback.format_exc()
        await _mark_submit_state(report, 0, "INCOMPLETE")
        return {"status": "FAILED", "error": str(e), "traceback": tb}
    finally:
        if new_browser:
            new_browser.stop()
        elif action_page is not None:
            try:
                await action_page.close()
            except Exception:
                pass
