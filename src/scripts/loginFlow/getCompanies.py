import asyncio
import sys

from scripts.core.browser import navigate
from scripts.core.company_context import build_report_create_url, parse_company_url
from scripts.core.utils import wait_for_element


def repair_mojibake(value: str) -> str:
    if not value or not isinstance(value, str):
        return value
    if any(ch in value for ch in ("\u00d8", "\u00d9", "\u00c3", "\u00c2")):
        try:
            return value.encode("latin1").decode("utf-8")
        except Exception:
            return value
    return value


def _normalize_valuers(items):
    cleaned = []
    seen = set()

    for item in (items or []):
        valuer_id = repair_mojibake((item or {}).get("valuerId") or "")
        valuer_name = repair_mojibake((item or {}).get("valuerName") or "")

        valuer_id = str(valuer_id or "").strip()
        valuer_name = str(valuer_name or "").strip()
        lower_name = valuer_name.lower()

        if not valuer_id or valuer_id in ("0", "-1"):
            continue
        if lower_name in ("", "select", "choose"):
            continue
        if valuer_name == "تحديد":
            continue
        if valuer_id in seen:
            continue

        seen.add(valuer_id)
        cleaned.append(
            {
                "valuerId": valuer_id,
                "valuerName": valuer_name,
            }
        )

    return cleaned


async def _extract_valuers_from_page(page):
    selector_script = """
        () => {
            const selectors = [
                '.addNewValuer select.valuer_id[name="valuer[0][id]"]',
                '.addNewValuer select[data-type="id"][name="valuer[0][id]"]',
                '.addNewValuer select[name="valuer[0][id]"]',
                '.addNewValuer select.valuer_id[data-type="id"]',
                '.addNewValuer select.valuer_id',
                '.addNewValuer select[data-type="id"]',
                '.addNewValuer select[name^="valuer"][name$="[id]"]',
                'select.valuer_id[name="valuer[0][id]"]',
                'select[data-type="id"][name="valuer[0][id]"]',
                'select[name="valuer[0][id]"]',
                'select.valuer_id[data-type="id"]',
                'select.valuer_id',
                'select[data-type="id"]',
                'select[name^="valuer"][name$="[id]"]',
            ];

            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (!style) return false;
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                return !!(el.offsetParent || el.getClientRects().length);
            };

            const parseOptions = (select) => {
                if (!select) return [];
                const parsed = [];
                const options = Array.from(select.querySelectorAll('option'));
                for (const opt of options) {
                    const val = (opt.getAttribute('value') || '').trim();
                    const text = (opt.textContent || '').trim();
                    if (!val || val === '0' || val === '-1') continue;
                    if (!text) continue;
                    const lowerText = text.toLowerCase();
                    if (lowerText === 'select' || lowerText === 'choose') continue;
                    parsed.push({ valuerId: val, valuerName: text });
                }
                return parsed;
            };

            // First pass: visible selects only, strict selector priority.
            for (const sel of selectors) {
                const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                for (const node of nodes) {
                    const parsed = parseOptions(node);
                    if (parsed.length > 0) return parsed;
                }
            }

            // Second pass: include hidden/template controls as fallback.
            for (const sel of selectors) {
                const nodes = Array.from(document.querySelectorAll(sel));
                for (const node of nodes) {
                    const parsed = parseOptions(node);
                    if (parsed.length > 0) return parsed;
                }
            }

            return [];
        }
    """

    try:
        raw = await page.evaluate(selector_script)
    except Exception:
        raw = []

    return _normalize_valuers(raw)


async def _extract_valuers_from_html(page):
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return []

    try:
        html_content = await page.get_content()
        soup = BeautifulSoup(html_content, "html.parser")
    except Exception:
        return []

    selectors = [
        ".addNewValuer select.valuer_id[name='valuer[0][id]']",
        ".addNewValuer select[data-type='id'][name='valuer[0][id]']",
        ".addNewValuer select[name='valuer[0][id]']",
        ".addNewValuer select.valuer_id[data-type='id']",
        ".addNewValuer select.valuer_id",
        ".addNewValuer select[data-type='id']",
        ".addNewValuer select[name^='valuer'][name$='[id]']",
        "select.valuer_id[name='valuer[0][id]']",
        "select[data-type='id'][name='valuer[0][id]']",
        "select[name='valuer[0][id]']",
        "select.valuer_id[data-type='id']",
        "select.valuer_id",
        "select[data-type='id']",
        "select[name^='valuer'][name$='[id]']",
    ]

    for sel in selectors:
        for select in soup.select(sel):
            rows = []
            for opt in select.find_all("option"):
                val = (opt.get("value") or "").strip()
                text = (opt.get_text() or "").strip()
                rows.append({"valuerId": val, "valuerName": text})
            normalized_rows = _normalize_valuers(rows)
            if normalized_rows:
                return normalized_rows

    return []


async def _wait_for_valuers(page, timeout_seconds=35):
    loops = max(1, int(timeout_seconds / 0.6))
    for _ in range(loops):
        rows = await _extract_valuers_from_page(page)
        if rows:
            return rows
        await asyncio.sleep(0.6)

    return await _extract_valuers_from_html(page)


async def _resolve_active_office_id(page):
    script = """
        () => {
            const onlyDigits = (v) => String(v || '').trim().replace(/\\D+/g, '');
            const fromUrl = () => {
                try {
                    const href = window.location.href || '';
                    const url = new URL(href);
                    const qpOffice = onlyDigits(url.searchParams.get('office'));
                    if (qpOffice) return qpOffice;

                    const path = (url.pathname || '').trim();
                    const reportMatch = path.match(/\\/report\\/create\\/\\d+\\/(\\d+)/);
                    if (reportMatch && reportMatch[1]) return onlyDigits(reportMatch[1]);
                    const orgMatch = path.match(/\\/organization\\/show\\/\\d+\\/(\\d+)/);
                    if (orgMatch && orgMatch[1]) return onlyDigits(orgMatch[1]);
                } catch (_) {}
                return '';
            };

            const fromDom = () => {
                const selectors = [
                    'input[name="office"]',
                    'input[name="office_id"]',
                    'input[name*="[office]"]',
                    'input[name*="[office_id]"]',
                    'select[name="office"]',
                    'select[name="office_id"]',
                    'select[name*="[office]"]',
                    'select[name*="[office_id]"]',
                    '#office',
                    '#office_id',
                ];
                for (const sel of selectors) {
                    const nodes = Array.from(document.querySelectorAll(sel));
                    for (const node of nodes) {
                        let val = '';
                        if (node.tagName === 'SELECT') {
                            val = node.value || '';
                        } else {
                            val = node.getAttribute('value') || node.value || '';
                        }
                        const digits = onlyDigits(val);
                        if (digits) return digits;
                    }
                }

                const activeLink = document.querySelector('ul#sidebarItem_5 a.active[href*="organization/show/"]');
                if (activeLink) {
                    const href = activeLink.getAttribute('href') || '';
                    const m = href.match(/\\/organization\\/show\\/\\d+\\/(\\d+)/);
                    if (m && m[1]) return onlyDigits(m[1]);
                }
                return '';
            };

            return fromUrl() || fromDom() || '';
        }
    """

    try:
        raw = await page.evaluate(script)
    except Exception:
        raw = ""

    active_office = str(raw or "").strip()
    if not active_office:
        return None
    return active_office


async def fetch_company_valuers(page, office_id, sector_id="4"):
    if not office_id:
        return []

    office_id = str(office_id or "").strip()
    sector_id = str(sector_id or "4").strip() or "4"
    target_url = build_report_create_url(sector_id, office_id)

    try:
        await page.get(target_url)
    except Exception as nav_error:
        print(
            f"[WARN] Failed opening report-create URL {target_url}: {nav_error}",
            file=sys.stderr,
        )
        return []

    await asyncio.sleep(1.6)

    # Ensure this page is for the expected office before scraping.
    is_expected_office = False
    for _ in range(25):
        try:
            current_url = await page.evaluate("window.location.href")
            parsed_current = parse_company_url(current_url or "")
            url_office = str(parsed_current.get("office_id") or "").strip()
            dom_office = await _resolve_active_office_id(page)
            dom_office = str(dom_office or "").strip()

            # URL and DOM can differ temporarily while page is still initializing.
            if (url_office and url_office == office_id) or (dom_office and dom_office == office_id):
                is_expected_office = True
                break
        except Exception:
            pass
        await asyncio.sleep(0.35)

    if not is_expected_office:
        try:
            current_url = await page.evaluate("window.location.href")
        except Exception:
            current_url = target_url
        print(
            f"[WARN] Office mismatch after navigation. expected={office_id} url={current_url}",
            file=sys.stderr,
        )
        return []

    try:
        await wait_for_element(
            page,
            ".addNewValuer select.valuer_id, .addNewValuer select[data-type='id'], select.valuer_id, select[data-type='id']",
            timeout=25,
        )
    except Exception:
        pass

    valuers = await _wait_for_valuers(page, timeout_seconds=35)
    if not valuers:
        # Some report pages need adding a valuer row before the select becomes visible.
        try:
            await page.evaluate(
                """
                () => {
                    const btn = document.querySelector('#duplicateValuer, [id*="duplicateValuer"], .duplicateValuer');
                    if (btn) {
                        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    }
                }
                """
            )
            await asyncio.sleep(1.2)
        except Exception:
            pass
        valuers = await _wait_for_valuers(page, timeout_seconds=12)

    if valuers:
        # Final guard: do not accept data if office context drifted.
        final_office = await _resolve_active_office_id(page)
        final_office = str(final_office or "").strip()
        if final_office and final_office != office_id:
            print(
                f"[WARN] Ignoring valuers due to office drift. expected={office_id} got={final_office} url={target_url}",
                file=sys.stderr,
            )
            return []
        print(
            f"[INFO] Loaded {len(valuers)} valuers for office {office_id} via {target_url}",
            file=sys.stderr,
        )
        return valuers

    try:
        current_url = await page.evaluate("window.location.href")
    except Exception:
        current_url = "unknown"

    print(
        f"[WARN] No valuers found for office {office_id} (sector={sector_id}) url={current_url}",
        file=sys.stderr,
    )
    return []


async def get_companies():
    try:
        start_url = "https://qima.taqeem.gov.sa/"
        final_home_url = "https://qima.taqeem.gov.sa/valuer/home"

        page = await navigate(start_url)
        await asyncio.sleep(3)

        companies = []
        companies_data = None

        try:
            companies_data = await page.evaluate(
                """
                () => {
                    const section = document.querySelector('ul#sidebarItem_5');
                    if (!section) return [];
                    const links = Array.from(section.querySelectorAll('a[href]'));
                    let started = false;
                    const out = [];

                    for (const link of links) {
                        const href = link.getAttribute('href') || '';
                        const text = (link.textContent || '').trim();
                        if (!href || !text) continue;
                        if (href.includes('membership/reports/sector/4')) {
                            started = true;
                            continue;
                        }
                        if (href.includes('organization/joinPartner/sector/4')) {
                            break;
                        }
                        if (!started) continue;
                        if (href.includes('organization/show/')) {
                            out.push({ name: text, href });
                        }
                    }
                    return out;
                }
                """
            )
        except Exception:
            companies_data = None

        if isinstance(companies_data, list):
            for item in companies_data:
                href = (item or {}).get("href")
                text = repair_mojibake((item or {}).get("name") or "")
                if not href or not text:
                    continue
                parsed = parse_company_url(href)
                companies.append(
                    {
                        "name": text,
                        "url": parsed.get("url") or href,
                        "officeId": parsed.get("office_id"),
                        "sectorId": parsed.get("sector_id"),
                    }
                )

        try:
            from bs4 import BeautifulSoup

            html_content = await page.get_content()
            soup = BeautifulSoup(html_content, "html.parser")
            machinery_section = soup.find("ul", {"id": "sidebarItem_5"})
            if machinery_section:
                links = machinery_section.find_all("a", href=True)
                reports_link_found = False
                join_partner_found = False

                for link in links:
                    href = link.get("href")
                    text = repair_mojibake(link.get_text(strip=True))

                    if not href or not text:
                        continue

                    if "membership/reports/sector/4" in href:
                        reports_link_found = True
                        continue

                    if "organization/joinPartner/sector/4" in href:
                        join_partner_found = True
                        break

                    if reports_link_found and not join_partner_found:
                        if "organization/show/" in href and text:
                            parsed = parse_company_url(href)
                            companies.append(
                                {
                                    "name": text,
                                    "url": parsed.get("url") or href,
                                    "officeId": parsed.get("office_id"),
                                    "sectorId": parsed.get("sector_id"),
                                }
                            )
        except Exception:
            pass

        deduped = []
        seen = set()
        for company in companies:
            key = (
                company.get("officeId")
                or company.get("office_id")
                or company.get("url")
                or company.get("name")
            )
            if not key:
                continue
            key = str(key).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            deduped.append(company)
        companies = deduped

        print(f"[INFO] Total companies found: {len(companies)}", file=sys.stderr)

        # Companies only — no Taqeem valuer scraping (valuers come from Excel when needed).
        for company in companies:
            office_id = str(
                company.get("officeId")
                or company.get("office_id")
                or ""
            ).strip()
            sector_id = str(
                company.get("sectorId")
                or company.get("sector_id")
                or "4"
            ).strip() or "4"
            if office_id:
                company["officeId"] = office_id
            company["sectorId"] = sector_id
            company["valuers"] = []

        try:
            await page.get(final_home_url)
            await asyncio.sleep(0.8)
        except Exception:
            pass

        print(f"[INFO] Total companies (no valuer fetch): {len(companies)}", file=sys.stderr)
        return {"status": "SUCCESS", "data": companies}
    except Exception as e:
        print(f"[ERROR] Error getting companies: {e}", file=sys.stderr)
        return {"status": "FAILED", "error": str(e)}
