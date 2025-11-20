import asyncio, sys, traceback

from scripts.core.browser import get_browser, check_browser_status
from scripts.core.utils import wait_for_table_rows


async def validate_report(cmd):
    report_id = cmd.get("reportId")
    if not report_id:
        return {
            "status": "FAILED",
            "error": "Missing reportId in command"
        }
    
    browser_status = await check_browser_status()
    print(f"[VALIDATION] Browser status: {browser_status}", file=sys.stderr)
    
    if not browser_status.get("browserOpen", False):
        return {
            "status": "FAILED",
            "error": "Browser is not open",
            "reportId": report_id  # Maintain original structure
        }
    
    if browser_status.get("status") != "SUCCESS":
        return {
            "status": "FAILED", 
            "error": "User not logged in", 
            "reportId": report_id  # Maintain original structure
        }

    url = f"https://qima.taqeem.sa/report/{report_id}"
    print(f"[VALIDATION] Checking report existence for {report_id}", file=sys.stderr)

    try:
        browser = await get_browser()
        page = browser.main_tab

        # Navigate to the report URL
        await page.get(url)
        await asyncio.sleep(3)  # wait for page content to load

        html = await page.get_content()

        # Check for different error scenarios
        error_text_1 = "ليس لديك صلاحية للتواجد هنا !"  # "You do not have permission to be here!"
        error_text_2 = "هذه الصفحة غير موجودة!"         # "This page does not exist! Did you reach it by mistake?"

        if error_text_1 in html or error_text_2 in html:
            result = {
                "status": "NOT_FOUND",
                "message": "Report not accessible or does not exist",
                "reportId": report_id,
                "exists": False,
                "url": url,
            }
        else:
            # Report exists - now check for macros table
            macros_table = await wait_for_table_rows(page, timeout=5)
            print(f"macros_table: {macros_table}", file=sys.stderr)

            if macros_table:
                # Determine total by: (last page number - 1) * 15 + count(ids on last page)
                total_micros = None
                assets_exact = None
                last_page_num = None
                last_page_ids = []

                try:
                    # 1) Go to last enabled numeric page and get its number
                    last_page_num = await page.evaluate("""
                        (() => {
                            const isDisabled = (li) => {
                                if (!li) return true;
                                if (li.classList.contains('disabled')) return true;
                                if (li.getAttribute('aria-disabled') === 'true') return true;
                                const a = li.querySelector('a,button');
                                if (a && (a.getAttribute('aria-disabled') === 'true' || a.classList.contains('disabled'))) return true;
                                return false;
                            };

                            const selectors = ['nav ul', '.dataTables_paginate ul', 'ul.pagination'];
                            let ul = null;
                            for (const sel of selectors) {
                                const el = document.querySelector(sel);
                                if (el && el.querySelectorAll('li').length > 0) { ul = el; break; }
                            }
                            if (!ul) return null;

                            const lis = Array.from(ul.querySelectorAll('li'));
                            const numericLis = lis.filter(li => {
                                const txt = li.textContent.trim();
                                return /^\\d+$/.test(txt) && !isDisabled(li);
                            });
                            if (numericLis.length === 0) return null;

                            const lastLi = numericLis[numericLis.length - 1];
                            const pageNum = parseInt(lastLi.textContent.trim(), 10);

                            const clickable = lastLi.querySelector('a,button') || lastLi;
                            try { clickable.click(); } catch (_) {}

                            return pageNum;
                        })()
                    """)

                    if isinstance(last_page_num, (int, float)) and last_page_num >= 1:
                        # 2) Wait for last page rows to render
                        await asyncio.sleep(1)
                        try:
                            await wait_for_table_rows(page, timeout=3)
                        except Exception:
                            pass

                        # 3) Collect IDs from #m-table on the (last) page
                        last_page_ids = await page.evaluate("""
                            (() => {
                                const rows = Array.from(document.querySelectorAll('#m-table tbody tr'));
                                const ids = [];
                                for (const tr of rows) {
                                    // First column anchor with href containing /report/macro/{id}/
                                    const a = tr.querySelector('td:nth-child(1) a[href*="/report/macro/"]');
                                    if (!a) continue;
                                    const href = a.getAttribute('href') || '';
                                    const m = href.match(/\\/macro\\/(\\d+)\\//);
                                    if (m) ids.push(parseInt(m[1], 10));
                                    else {
                                        // fallback: use anchor text if it's numeric
                                        const txt = (a.textContent || '').trim();
                                        if (/^\\d+$/.test(txt)) ids.push(parseInt(txt, 10));
                                    }
                                }
                                return ids;
                            })()
                        """)

                        # 4) Optionally try clicking NEXT and check if it's disabled (should be disabled on last page)
                        try:
                            next_state = await page.evaluate("""
                                (() => {
                                    const next = document.querySelector('#m-table_next, a.paginate_button.next[aria-controls="m-table"]');
                                    if (!next) return { exists: false, disabled: null };
                                    const disabled = next.classList.contains('disabled') || next.getAttribute('aria-disabled') === 'true';
                                    if (!disabled) { try { next.click(); } catch(_) {} }
                                    return { exists: true, disabled };
                                })()
                            """)
                            print(f"[VALIDATION] Next button state: {next_state}", file=sys.stderr)
                        except Exception:
                            pass

                        # 5) Compute exact assets
                        # old: page_num * 15
                        # new: (page_num * 15) - (15 - count_on_last) == (page_num - 1) * 15 + count_on_last
                        count_on_last = len(last_page_ids) if isinstance(last_page_ids, list) else 0
                        assets_exact = int((int(last_page_num) - 1) * 15 + count_on_last)
                        total_micros = int(last_page_num) * 15  # keep if you still want to report the old heuristic

                        print(
                            f"[VALIDATION] page={int(last_page_num)}, ids_on_last={count_on_last}, exact_assets={assets_exact}",
                            file=sys.stderr
                        )
                    else:
                        print(f"[VALIDATION] Could not find last page number: {last_page_num}", file=sys.stderr)

                except Exception as e:
                    print(f"[VALIDATION] Error computing exact assets: {e}", file=sys.stderr)

                result = {
                    "status": "MACROS_EXIST",
                    "message": (
                        "Only works with empty reports — "
                        f"last page #{int(last_page_num) if last_page_num else 'unknown'}, "
                        f"ids on last page: {len(last_page_ids) if isinstance(last_page_ids, list) else 'unknown'}, "
                        f"exact assets: {assets_exact if assets_exact is not None else 'unknown'}"
                    ),
                    "reportId": report_id,
                    "exists": True,
                    "url": url,
                    "hasMacros": True,
                    "microsCount": total_micros,          # legacy (page_num * 15)
                    "assetsExact": assets_exact,          # new exact count
                    "lastPageMicroIds": last_page_ids     # list of IDs scraped from the last page
                }
            else:
                result = {
                    "status": "SUCCESS",
                    "message": "Report appears to exist and is accessible",
                    "reportId": report_id,
                    "exists": True,
                    "url": url,
                    "hasMacros": False
                }

        print(f"[VALIDATION] Completed check for {report_id}", file=sys.stderr)
        return result

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[VALIDATION] Error checking report {report_id}: {e}", file=sys.stderr)
        return {
            "status": "FAILED",
            "reportId": report_id,
            "error": str(e),
            "traceback": tb,
        }