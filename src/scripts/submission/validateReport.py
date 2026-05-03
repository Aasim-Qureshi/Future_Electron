import asyncio
import json
import re
import sys
import traceback
from datetime import datetime
from html import unescape

from motor.motor_asyncio import AsyncIOMotorClient

from scripts.core.browser import check_browser_status, new_window
from scripts.core.httpClient import http_get, http_patch
from scripts.core.utils import wait_for_table_rows
from scripts.submission.createMacros import run_create_assets
from scripts.submission.grabMacroIds import get_all_macro_ids_parallel, get_macro_count

MONGO_URI = "mongodb+srv://Aasim:userAasim123@electron.cwbi8id.mongodb.net"
_mongo_client = AsyncIOMotorClient(MONGO_URI)
_db = _mongo_client["test"]
_check_report_coll = _db["report_deletions"]
_REPORT_SOURCE_COLLECTIONS = [
    "reports",
    "duplicatereports",
    "multiapproachreports",
    "submitreportsquicklies",
    "elrajhireports",
    "urgentreports",
]


async def _resolve_company_office_id(report_id: str) -> str | None:
    if not report_id:
        return None
    report_id_str = str(report_id)

    try:
        data = await http_get(f"/new-scripts/resolve-company-office-id/{report_id_str}")
        if data and data.get("company_office_id"):
            return str(data["company_office_id"])

    except Exception:
        pass
    return None


async def wait_for_report_info_html(page, timeout_seconds=10):
    """
    Repeatedly fetch page HTML until we see key report info text (e.g. 'حالة التقرير').
    This avoids DOM/iframe issues and handles late-loaded content.
    """
    steps = int(timeout_seconds / 0.5)
    last_html = ""
    for _ in range(max(1, steps)):
        try:
            last_html = await page.get_content()
        except Exception:
            pass

        if last_html and (
            "حالة التقرير" in last_html or "معلومات التقرير" in last_html
        ):
            return last_html

        await asyncio.sleep(0.5)

    return last_html


def _clean_text(s: str) -> str:
    s = unescape(s or "")
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)  # strip tags
    s = re.sub(r"\s+", " ", s).strip()  # normalize whitespace
    return s


def _normalize_report_status(value: str):
    """
    Convert Arabic / mixed status text into internal constants.
    """
    if not value:
        return None

    v = _normalize_text(value)

    STATUS_MAP = {
        "مسودة": "DRAFT",
        "مقبول": "APPROVED",
        "معتمد": "APPROVED",
        "مرفوض": "REJECTED",
        "قيد المراجعة": "UNDER_REVIEW",
        "قيد التنفيذ": "IN_PROGRESS",
    }

    # exact match first
    if v in STATUS_MAP:
        return STATUS_MAP[v]

    # partial match (safer for messy HTML)
    for ar, normalized in STATUS_MAP.items():
        if ar in v:
            return normalized

    return v  # fallback → return cleaned original


def _fix_mojibake(text: str) -> str:
    """
    Repair UTF-8 text that was accidentally decoded as latin-1.
    If not broken, returns original text.
    """
    if not text:
        return text
    try:
        repaired = text.encode("latin1").decode("utf-8")
        # avoid replacing valid latin text accidentally
        if repaired:
            return repaired
    except Exception:
        pass
    return text


def _normalize_text(text: str) -> str:
    """
    Clean + normalize extracted text.
    """
    text = _fix_mojibake(text)
    return _clean_text(text or "").strip()


def extract_report_info_from_html(html: str) -> dict:
    """
    Extract key/value pairs from report HTML.

    Returns:
    {
        "info": {label: value, ...},
        "reportStatusLabel": "...",
        "reportStatus": "..."
    }
    """
    if not html:
        return {
            "info": {},
            "reportStatusLabel": None,
            "reportStatus": None,
        }

    # --------------------------------------------------
    # isolate accordion body (fallback to full html)
    # --------------------------------------------------
    m = re.search(
        r'(<div[^>]*class="[^"]*accordion-body[^"]*"[^>]*>.*?</div>)',
        html,
        flags=re.S | re.I,
    )
    block = m.group(1) if m else html

    info = {}

    # --------------------------------------------------
    # helper to insert values safely
    # --------------------------------------------------
    def add_info(label_raw, value_raw):
        label = _normalize_text(label_raw)
        value = _normalize_text(value_raw)
        if label:
            info[label] = value or None

    # --------------------------------------------------
    # 1) span + <b>
    # --------------------------------------------------
    for span_txt, b_txt in re.findall(
        r"<span[^>]*>(.*?)</span>\s*<b[^>]*>(.*?)</b>",
        block,
        flags=re.S | re.I,
    ):
        add_info(span_txt, b_txt)

    # --------------------------------------------------
    # 2) span + link
    # --------------------------------------------------
    for span_txt, href in re.findall(
        r"<span[^>]*>(.*?)</span>.*?<a[^>]*href=[\"']([^\"']+)[\"']",
        block,
        flags=re.S | re.I,
    ):
        label = _normalize_text(span_txt)
        if label and label not in info:
            info[label] = href.strip()

    # --------------------------------------------------
    # fallback search (broader extraction)
    # --------------------------------------------------
    if not info:
        for span_txt, val_txt in re.findall(
            r"<span[^>]*>(.*?)</span>\s*"
            r"(?:<b[^>]*>|<strong[^>]*>)(.*?)"
            r"(?:</b>|</strong>)",
            html,
            flags=re.S | re.I,
        ):
            add_info(span_txt, val_txt)

    # --------------------------------------------------
    # detect report status (Arabic-safe)
    # --------------------------------------------------
    status_label = None
    status_value = None

    TARGET_STATUS = "حالة التقرير"

    for k, v in info.items():
        normalized_key = _normalize_text(k)
        if TARGET_STATUS in normalized_key:
            status_label = k
            status_value = _normalize_report_status(v)
            break

    return {
        "info": info,
        "reportStatusLabel": status_label,
        "reportStatus": status_value,
    }


async def calculate_total_assets(page) -> dict:
    """
    Calculate total assets using DataTables pagination and current rows.
    Returns:
      {
        "total_micros": int|None,
        "assets_exact": int|None,
        "last_page_num": int|None,
        "last_page_ids": list,
        "first_page_ids": list,
        "error": str|None
      }
    """
    result = {
        "total_micros": None,
        "assets_exact": None,
        "last_page_num": None,
        "last_page_ids": [],
        "first_page_ids": [],
        "error": None,
    }

    try:
        # Always count current page first (covers single-page reports)
        await wait_for_table_rows(page, timeout=15)
        first_page_ids = await page.evaluate(r"""
            (() => {
                const rows = Array.from(document.querySelectorAll('#m-table tbody tr'));
                const ids = [];
                for (const tr of rows) {
                    const a = tr.querySelector('td:nth-child(1) a[href*="/report/macro/"]');
                    if (!a) continue;
                    const href = a.getAttribute('href') || '';
                    const m = href.match(/\/macro\/(\d+)\//);
                    if (m) ids.push(parseInt(m[1], 10));
                    else {
                        const txt = (a.textContent || '').trim();
                        if (/^\d+$/.test(txt)) ids.push(parseInt(txt, 10));
                    }
                }
                return ids;
            })()
        """)
        result["first_page_ids"] = first_page_ids
        first_count = len(first_page_ids) if isinstance(first_page_ids, list) else 0

        # Detect last page number; if no pagination => 1 page
        last_page_num = await page.evaluate(r"""
            (() => {
                const selectors = ['nav ul', '.dataTables_paginate ul', 'ul.pagination'];
                let ul = null;
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.querySelectorAll('li').length > 0) { ul = el; break; }
                }

                // No pagination UI => single page
                if (!ul) return 1;

                const lis = Array.from(ul.querySelectorAll('li'));
                const numericLis = lis.filter(li => /^\d+$/.test(li.textContent.trim()));
                if (numericLis.length === 0) return 1;

                const lastLi = numericLis[numericLis.length - 1];
                const pageNum = parseInt(lastLi.textContent.trim(), 10) || 1;

                // Click last page (ok if it's already active)
                const clickable = lastLi.querySelector('a,button') || lastLi;
                try { clickable.click(); } catch (_) {}

                return pageNum;
            })()
        """)

        last_page_num = int(last_page_num or 1)
        result["last_page_num"] = last_page_num

        # Single page
        if last_page_num <= 1:
            result["assets_exact"] = first_count
            result["total_micros"] = first_count
            result["last_page_ids"] = first_page_ids
            return result

        # Multi-page: wait for last page rows then collect IDs on last page
        await asyncio.sleep(1)
        try:
            await wait_for_table_rows(page, timeout=3)
        except Exception:
            pass

        last_page_ids = await page.evaluate(r"""
            (() => {
                const rows = Array.from(document.querySelectorAll('#m-table tbody tr'));
                const ids = [];
                for (const tr of rows) {
                    const a = tr.querySelector('td:nth-child(1) a[href*="/report/macro/"]');
                    if (!a) continue;
                    const href = a.getAttribute('href') || '';
                    const m = href.match(/\/macro\/(\d+)\//);
                    if (m) ids.push(parseInt(m[1], 10));
                    else {
                        const txt = (a.textContent || '').trim();
                        if (/^\d+$/.test(txt)) ids.push(parseInt(txt, 10));
                    }
                }
                return ids;
            })()
        """)

        result["last_page_ids"] = last_page_ids
        count_on_last = len(last_page_ids) if isinstance(last_page_ids, list) else 0

        # Keep the original assumption: 15 rows per page
        result["assets_exact"] = int((last_page_num - 1) * 15 + count_on_last)
        result["total_micros"] = int(last_page_num) * 15
        return result

    except Exception as e:
        result["error"] = str(e)
        return result


async def _update_report_check_status(
    report_id: str,
    user_id: str | None,
    updates: dict,
    company_office_id: str | None = None,
) -> None:
    if not report_id or not updates:
        return

    try:
        payload = {
            "report_id": str(report_id),
            "user_id": str(user_id) if user_id else None,
            "updates": updates,
        }

        if company_office_id:
            payload["company_office_id"] = str(company_office_id)

        await http_patch(
            "/new-scripts/update-check-status",
            json=payload,
        )

    except Exception as e:
        print(
            json.dumps(
                {
                    "event": "http_update_failed",
                    "reportId": report_id,
                    "error": str(e),
                }
            ),
            file=sys.stderr,
        )


async def validate_report(cmd):
    report_id = cmd.get("reportId")
    user_id = cmd.get("userId")
    company_office_id = cmd.get("companyOfficeId")
    if not report_id:
        return {"status": "FAILED", "error": "Missing reportId in command"}

    if company_office_id:
        source_company_id = await _resolve_company_office_id(report_id)
        if source_company_id and str(source_company_id) != str(company_office_id):
            await _update_report_check_status(
                report_id,
                user_id,
                {
                    "last_status_check_status": "NOT_FOUND",
                    "last_status_check_source": "validate_report",
                    "status_reason": "COMPANY_MISMATCH",
                },
                company_office_id,
            )
            return {
                "status": "NOT_FOUND",
                "message": "Report belongs to another company",
                "reportId": report_id,
                "exists": False,
            }

    browser_status = await check_browser_status()
    print(
        json.dumps({"event": "browser_status", "browserStatus": browser_status}),
        file=sys.stderr,
    )

    if not browser_status.get("browserOpen", False):
        return {
            "status": "FAILED",
            "error": "Browser is not open",
            "reportId": report_id,
        }

    if browser_status.get("status") != "SUCCESS":
        return {
            "status": "FAILED",
            "error": "User not logged in",
            "reportId": report_id,
        }

    url = f"https://qima.taqeem.gov.sa/report/{report_id}"

    print(
        json.dumps({"event": "checking_report", "reportId": report_id, "url": url}),
        file=sys.stderr,
    )

    page = None

    try:
        page = await new_window(url)
        await asyncio.sleep(3)

        html = await wait_for_report_info_html(page, timeout_seconds=10)

        print(
            json.dumps(
                {
                    "event": "html_contains_report_info",
                    "hasStatusText": ("حالة التقرير" in (html or "")),
                    "hasAccordionText": ("معلومات التقرير" in (html or "")),
                    "htmlLength": len(html or ""),
                }
            ),
            file=sys.stderr,
        )

        error_text_1 = "ليس لديك صلاحية للتواجد هنا !"
        error_text_2 = "هذه الصفحة غير موجودة!"

        if error_text_1 in html or error_text_2 in html:
            await _update_report_check_status(
                report_id,
                user_id,
                {
                    "last_status_check_status": "NOT_FOUND",
                    "last_status_check_source": "validate_report",
                },
                company_office_id,
            )
            return {
                "status": "NOT_FOUND",
                "message": "Report not accessible or does not exist",
                "reportId": report_id,
                "exists": False,
                "url": url,
            }

        # --- Extract full report info + report status from raw HTML (most reliable) ---
        extracted = extract_report_info_from_html(html)
        report_info = extracted.get("info") or {}
        report_status_label = extracted.get("reportStatusLabel")
        report_status = extracted.get("reportStatus")

        print(
            json.dumps(
                {
                    "event": "report_info_extracted",
                    "reportStatusLabel": report_status_label,
                    "reportStatus": report_status,
                    "keysCount": len(report_info),
                }
            ),
            file=sys.stderr,
        )

        # Report exists – check macros table
        macros_table = await wait_for_table_rows(page)
        print(
            json.dumps(
                {"event": "macros_table_check", "tableFound": bool(macros_table)}
            ),
            file=sys.stderr,
        )

        if macros_table:
            assets_info = await calculate_total_assets(page)
            total_micros = assets_info.get("total_micros")
            assets_exact = assets_info.get("assets_exact")
            last_page_num = assets_info.get("last_page_num")
            last_page_ids = assets_info.get("last_page_ids") or []

            if assets_info.get("error"):
                print(
                    json.dumps(
                        {"event": "compute_error", "error": assets_info.get("error")}
                    ),
                    file=sys.stderr,
                )

            print(
                json.dumps(
                    {
                        "event": "assets_computed",
                        "page": last_page_num,
                        "countLastPage": len(last_page_ids)
                        if isinstance(last_page_ids, list)
                        else None,
                        "assetsExact": assets_exact,
                    }
                ),
                file=sys.stderr,
            )
            await _update_report_check_status(
                report_id,
                user_id,
                {
                    "report_status": report_status,
                    "report_status_label": report_status_label,
                    "assets_exact": assets_exact,
                    "last_status_check_status": "MACROS_EXIST",
                    "last_status_check_source": "validate_report",
                },
                company_office_id,
            )

            return {
                "status": "MACROS_EXIST",
                "message": (
                    "Report has macros – "
                    f"last page #{int(last_page_num) if last_page_num else 'unknown'}, "
                    f"ids on last page: {len(last_page_ids) if isinstance(last_page_ids, list) else 'unknown'}, "
                    f"exact assets: {assets_exact if assets_exact is not None else 'unknown'}"
                ),
                "reportId": report_id,
                "exists": True,
                "url": url,
                "reportStatus": report_status,
                "reportStatusLabel": report_status_label,
                "reportInfo": report_info,
                "hasMacros": True,
                "microsCount": total_micros,
                "assetsExact": assets_exact,
                "lastPageMicroIds": last_page_ids,
            }

        # No macros table → report is valid and empty
        print(json.dumps({"event": "report_empty_macros"}), file=sys.stderr)

        await _update_report_check_status(
            report_id,
            user_id,
            {
                "report_status": report_status,
                "report_status_label": report_status_label,
                "assets_exact": None,
                "last_status_check_status": "SUCCESS",
                "last_status_check_source": "validate_report",
            },
            company_office_id,
        )

        return {
            "status": "SUCCESS",
            "reportStatus": report_status,
            "reportStatusLabel": report_status_label,
            "reportInfo": report_info,
            "message": "Report appears to exist and is accessible",
            "reportId": report_id,
            "exists": True,
            "url": url,
            "hasMacros": False,
        }

    except Exception as e:
        tb = traceback.format_exc()

        print(
            json.dumps({"event": "exception", "error": str(e), "traceback": tb}),
            file=sys.stderr,
        )

        return {
            "status": "FAILED",
            "reportId": report_id,
            "error": str(e),
            "traceback": tb,
        }

    finally:
        if page:
            await page.close()


async def check_report_existence(
    page, report_id=None, *, skip_navigation=False, post_nav_sleep=3.0
):
    ERROR_TEXT_NOT_ALLOWED = "ليس لديك صلاحية للتواجد هنا !"
    ERROR_TEXT_NOT_FOUND = "هذه الصفحة غير موجودة!"

    if report_id:
        url = f"https://qima.taqeem.gov.sa/report/{report_id}"

        if not skip_navigation:
            print(
                json.dumps(
                    {
                        "event": "navigating_to_report",
                        "reportId": report_id,
                        "url": url,
                    }
                ),
                file=sys.stderr,
            )

            await page.get(url)
            await asyncio.sleep(float(post_nav_sleep))
        else:
            await asyncio.sleep(0.12)
    else:
        url = await page.evaluate("window.location.href")

    html = await page.get_content()

    if ERROR_TEXT_NOT_ALLOWED in html or ERROR_TEXT_NOT_FOUND in html:
        return {
            "status": "NOT_FOUND",
            "exists": False,
            "reportId": report_id,
            "url": url,
        }

    return {"status": "EXISTS", "exists": True, "reportId": report_id, "url": url}


async def validate_for_retry(browser, report_id: str, asset_data: list[dict]):
    """
    Ensures:
    1) Remote report has correct asset count
    2) Every asset in asset_data has a valid `id` string

    Mutates asset_data in-place when re-grabbing IDs.

    Returns:
      {
        "status": "SUCCESS" | "FAILED",
        "created": int,
        "error": str | None
      }
    """

    try:
        expected_count = len(asset_data)

        # ----------------------------
        # STEP 1 — reconcile asset count
        # ----------------------------
        current_count = await get_macro_count(browser, report_id)
        print(json.dumps(current_count))
        created = 0

        if current_count < expected_count:
            missing = expected_count - current_count
            await run_create_assets(browser, report_id, missing)
            created = missing
            await asyncio.sleep(2)

        elif current_count > expected_count:
            return {
                "status": "FAILED",
                "error": (
                    f"Remote asset count ({current_count}) "
                    f"exceeds DB asset count ({expected_count})"
                ),
                "created": 0,
            }

        # ----------------------------
        # STEP 2 — ID verification (DB-first)
        # ----------------------------
        needs_regrab = created > 0 or any(
            not isinstance(a.get("id"), str) or not a["id"] for a in asset_data
        )

        if not needs_regrab:
            # DB already has everything we need
            return {
                "status": "SUCCESS",
                "created": created,
                "error": None,
            }

        # ----------------------------
        # Re-grab ALL IDs (atomic reset)
        # ----------------------------
        asset_ids = await get_all_macro_ids_parallel(browser, report_id)

        if not asset_ids:
            return {
                "status": "FAILED",
                "error": "Unable to retrieve complete asset ID set from page",
                "created": created,
            }

        return {
            "status": "RE-GRABBED",
            "created": created,
            "error": None,
        }

    except Exception as e:
        return {
            "status": "FAILED",
            "error": str(e),
            "created": 0,
        }


async def validate_report_simple(browser, report_id: str):
    if not report_id:
        return {"status": "FAILED", "error": "Missing reportId"}

    url = f"https://qima.taqeem.gov.sa/report/{report_id}"
    page = None

    try:
        page = await browser.get(url)
        await asyncio.sleep(2)

        html = await wait_for_report_info_html(page, timeout_seconds=10)

        # --- Hard failure texts ---
        if (
            "ليس لديك صلاحية للتواجد هنا !" in html
            or "هذه الصفحة غير موجودة!" in html
        ):
            return {
                "status": "NOT_FOUND",
                "exists": False,
                "reportId": report_id,
                "url": url,
            }

        # --- Extract report metadata ---
        extracted = extract_report_info_from_html(html)
        report_info = extracted.get("info") or {}
        report_status = extracted.get("reportStatus")
        report_status_label = extracted.get("reportStatusLabel")

        # --- Check macros ---
        macros_table = await wait_for_table_rows(page, timeout=7)

        if macros_table:
            assets_info = await calculate_total_assets(page)

            return {
                "status": "MACROS_EXIST",
                "exists": True,
                "hasMacros": True,
                "reportId": report_id,
                "url": url,
                "reportStatus": report_status,
                "reportStatusLabel": report_status_label,
                "reportInfo": report_info,
                "microsCount": assets_info.get("total_micros"),
                "assetsExact": assets_info.get("assets_exact"),
                "lastPageMicroIds": assets_info.get("last_page_ids") or [],
            }

        # --- Valid report, no macros ---
        return {
            "status": "SUCCESS",
            "exists": True,
            "hasMacros": False,
            "reportId": report_id,
            "url": url,
            "reportStatus": report_status,
            "reportStatusLabel": report_status_label,
            "reportInfo": report_info,
        }

    except Exception as e:
        return {
            "status": "FAILED",
            "reportId": report_id,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
