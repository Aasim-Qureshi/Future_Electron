import asyncio
import base64
import json
import os
import shutil
import sys
import time
import re
import html as html_lib
from urllib.parse import unquote, urljoin

from scripts.core.browser import check_browser_status, get_browser, spawn_new_browser
from scripts.submission.certificate_save_bridge import (
    async_os_hotkey_ctrl_s,
    normalize_evaluate_json_result,
)
from scripts.submission.ElRajhiFiller import open_workflow_page, open_workflow_pages

# CDP sniff for certificate PDF bytes (XHR / document) — serialised with one listener per process.
_REGISTRATION_PDF_CDP_MONITOR = None  # attached dict {"rows": [...], "finished": set()}
_REGISTRATION_PDF_CDP_SNIF_LOCK = asyncio.Lock()

AR_STATUS_LABEL = "حالة التقرير:"
AR_STATUS_LABEL_SHORT = "حالة التقرير"
AR_STATUS_VALUE = "معتمد"
AR_CERTIFICATE_TEXT = "شهادة التسجيل"
AR_CERTIFICATE_TEXT_SHORT = "شهادة"
EN_CERTIFICATE_TEXT = "Registration Certificate"

# Substrings matched in anchor href for certificate endpoints (portal paths vary).
CERTIFICATE_HREF_MARKERS = (
    "/registration",
    "registration",
    "/certificate",
    "certificate",
    "/cert/",
    "registration-certificate",
    "registrationcertificate",
)
AR_REPORT_TITLE_LABEL = "عنوان التقرير"
AR_REPORT_NAME_LABEL = "اسم التقرير"
AR_ASSET_NAME_LABEL = "اسم الأصل"
AR_ASSET_TITLE_LABEL = "عنوان الأصل"
AR_ASSET_NAME_LABEL_ALT = "اسم الاصل"
AR_ASSET_TABLE_HEADER = "اسم/وصف الأصل"

EN_REPORT_TITLE_LABEL = "Report Title"
EN_REPORT_NAME_LABEL = "Report Name"
EN_ASSET_NAME_LABEL = "Asset Name"

INVALID_FILENAME_CHARS = '<>:"/\\\\|?*'
TEMP_DOWNLOAD_SUFFIXES = (".crdownload", ".tmp", ".download")
# رموز غير مرئية قد يضيفها اتجاه النص العربي وتؤثر على مطابقة النصوص وأسماء الملفات.
INVISIBLE_CODEPOINTS = {
    0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
    0x2066, 0x2067, 0x2068, 0x2069,
}
# علامات تظهر عندما يصل النص العربي بترميز خاطئ.
MOJIBAKE_MARKERS = tuple(chr(code) for code in (0x00D8, 0x00D9, 0x00C3, 0x00C2))


def repair_mojibake(value: str) -> str:
    if not value or not isinstance(value, str):
        return value
    if any(ch in value for ch in MOJIBAKE_MARKERS):
        try:
            return value.encode("latin1").decode("utf-8")
        except Exception:
            return value
    return value


def format_error(err) -> str:
    message = str(err or "").strip()
    return message or type(err).__name__


def normalize_download_path(path: str) -> str:
    if not path:
        return ""
    text = repair_mojibake(str(path))
    text = text.strip().strip('"').strip("'")
    text = "".join(ch for ch in text if ord(ch) not in INVISIBLE_CODEPOINTS)
    return os.path.normpath(os.path.abspath(text))


def sanitize_filename(name: str, fallback: str = "certificate") -> str:
    if not name:
        return fallback
    cleaned = repair_mojibake(str(name))
    cleaned = "".join("_" if ch in INVALID_FILENAME_CHARS else ch for ch in cleaned)
    cleaned = "".join(
        ch for ch in cleaned
        if ord(ch) >= 32 and ord(ch) not in INVISIBLE_CODEPOINTS
    )
    cleaned = cleaned.strip().strip(".")
    if not cleaned:
        return fallback
    return cleaned[:180]


def ensure_unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    idx = 1
    while True:
        candidate = f"{base} ({idx}){ext}"     
        if not os.path.exists(candidate):
            return candidate
        idx += 1


def safe_token(value: str, fallback: str = "item") -> str:
    token = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "").strip())
    token = token.strip("._")
    return token[:80] or fallback


def build_certificate_filename(asset_name: str, report_id: str = "") -> str:
    fallback = f"certificate_{safe_token(report_id, 'report')}" if report_id else "certificate"
    base_name = sanitize_filename(asset_name, fallback=fallback)
    if not base_name.lower().endswith(".pdf"):
        base_name = f"{base_name}.pdf"
    return base_name


def is_temp_download_file(path: str) -> bool:
    lowered = path.lower()
    return any(lowered.endswith(suffix) for suffix in TEMP_DOWNLOAD_SUFFIXES)


def make_temp_download_dir(download_path: str, report_id: str) -> str:
    root = os.path.join(download_path, ".valuetech_certificate_downloads")
    os.makedirs(root, exist_ok=True)
    folder_name = f"{int(time.time() * 1000)}_{safe_token(report_id, 'report')}"
    path = os.path.join(root, folder_name)
    os.makedirs(path, exist_ok=True)
    return path


async def wait_for_downloaded_file(
    download_dir: str,
    timeout: int = 90,
    baseline_filenames: set | None = None,
) -> str:
    deadline = time.time() + max(1, timeout)
    last_sizes = {}
    ignore = baseline_filenames or set()

    while time.time() < deadline:
        try:
            names = os.listdir(download_dir)
        except Exception:
            names = []

        paths = [os.path.join(download_dir, name) for name in names]
        files = [path for path in paths if os.path.isfile(path)]
        completed = [
            path
            for path in files
            if not is_temp_download_file(path) and os.path.basename(path) not in ignore
        ]
        temp_files = [path for path in files if is_temp_download_file(path)]

        if completed:
            completed.sort(key=lambda path: os.path.getmtime(path), reverse=True)
            candidate = completed[0]
            try:
                size = os.path.getsize(candidate)
            except Exception:
                size = -1
            previous_size = last_sizes.get(candidate)
            if previous_size == size and size > 0 and not temp_files:
                return candidate
            last_sizes[candidate] = size

        await asyncio.sleep(0.35)

    raise TimeoutError("Timed out waiting for certificate download")


def move_downloaded_certificate(downloaded_path: str, download_path: str, file_name: str) -> str:
    final_name = build_certificate_filename(file_name)
    final_path = ensure_unique_path(os.path.join(download_path, final_name))
    os.makedirs(download_path, exist_ok=True)
    shutil.move(downloaded_path, final_path)
    return final_path


def looks_like_pdf_bytes(data: bytes) -> bool:
    if not data:
        return False
    head = data[:1024]
    return head.lstrip().startswith(b"%PDF") or b"%PDF-" in head


def _looks_like_html_bytes(data: bytes) -> bool:
    if not data or len(data) < 8:
        return False
    s = data.lstrip()[:800].lower()
    return s.startswith(b"<!doctype") or s.startswith(b"<html") or s.startswith(b"<head") or b"<embed" in s


def _extract_pdf_related_urls_from_html(data: bytes, registration_url: str) -> list[str]:
    """Pull candidate URLs from Taqeem certificate HTML (Chrome PDF embed wrapper, links)."""
    try:
        text = data.decode("utf-8", errors="ignore")
    except Exception:
        return []
    out: list[str] = []
    seen: set[str] = set()

    def push_raw(u: str):
        raw = (u or "").strip()
        if not raw or raw in seen:
            return
        seen.add(raw)
        out.append(raw)

    base = (registration_url or "").strip().split("#")[0]

    for pat in (
        r'original-url="([^"]+)"',
        r"original-url='([^']+)'",
        r'src="(https://[^"]*taqeem\.gov\.sa[^"]*)"',
        r"href=\"(https://[^\"]*taqeem\.gov\.sa[^\"]*)\"",
        r'"(https://qima\.taqeem\.gov\.sa/report/[^"\s]+)"',
    ):
        for m in re.finditer(pat, text, flags=re.I):
            push_raw(html_lib.unescape(m.group(1).strip()))

    if base:
        push_raw(base)
        for q in ("download=1", "format=pdf", "pdf=1"):
            sep = "&" if "?" in base else "?"
            push_raw(f"{base}{sep}{q}")

    return out


def save_certificate_pdf_bytes(
    data: bytes,
    download_path: str,
    preferred_name: str,
    report_id: str,
    source: str,
) -> str:
    if not looks_like_pdf_bytes(data):
        raise RuntimeError(f"{source} did not produce PDF bytes")

    file_name = build_certificate_filename(preferred_name, report_id)
    os.makedirs(download_path, exist_ok=True)
    dest = ensure_unique_path(os.path.join(download_path, file_name))
    with open(dest, "wb") as handle:
        handle.write(data)
    print(
        f"[PY] RegistrationCertificateDownloader: saved registration PDF via {source} "
        f"for report {report_id}: {dest}",
        file=sys.stderr,
        flush=True,
    )
    return dest


def chunk_items(items, n):
    n = max(1, n)
    k, m = divmod(len(items), n)
    chunks = []
    start = 0
    for i in range(n):
        size = k + (1 if i < m else 0)
        chunks.append(items[start:start + size])
        start += size
    return chunks


def extract_title_from_html(html_text: str) -> str:
    if not html_text:
        return ""
    match = re.search(r"<title[^>]*>(.*?)</title>", html_text, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    title = html_lib.unescape(match.group(1))
    return title.replace("\u00a0", " ").strip()


async def get_asset_name_from_report_table(page, timeout: int = 8) -> str:
    end = time.time() + max(1, timeout)
    last_value = ""
    header_labels = [
        AR_ASSET_TABLE_HEADER,
        AR_ASSET_NAME_LABEL,
        AR_ASSET_TITLE_LABEL,
        AR_ASSET_NAME_LABEL_ALT,
        EN_ASSET_NAME_LABEL,
        "Asset Name/Description",
        "Asset Name / Description",
        "Asset Description",
    ]
    header_json = json.dumps(header_labels)
    while time.time() < end:
        try:
            value = await page.evaluate(
                f"""
                () => {{
                    const normalize = (value) => (value || '')
                        .replace(/[\\u00a0]/g, ' ')
                        .replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '')
                        .replace(/\\s+/g, ' ')
                        .trim();

                    const targets = {header_json}.map((t) => normalize(t));
                    const isTarget = (text) =>
                        targets.some((t) => text === t || text.includes(t));
                    const tables = [];
                    const push = (node) => {{
                        if (node && !tables.includes(node)) tables.push(node);
                    }};

                    [
                        '#m-table',
                        'table#m-table',
                        '.m-table',
                        'table.m-table',
                        '#mTable',
                        '.mTable'
                    ].forEach((selector) => push(document.querySelector(selector)));

                    if (!tables.length) {{
                        Array.from(document.querySelectorAll('table')).forEach(push);
                    }}

                    const findInTable = (table) => {{
                        if (!table) return '';
                        const rows = Array.from(table.querySelectorAll('tr'));
                        if (!rows.length) return '';

                        const headCells = Array.from(table.querySelectorAll('thead th'));
                        let headerCells = headCells;
                        let startRow = 0;
                        if (!headerCells.length && rows[0]) {{
                            headerCells = Array.from(rows[0].querySelectorAll('th, td'));
                            startRow = 1;
                        }}

                        let targetIndex = -1;
                        for (let i = 0; i < headerCells.length; i += 1) {{
                            const text = normalize(headerCells[i]?.textContent || '');
                            if (!text) continue;
                            if (isTarget(text)) {{
                                targetIndex = i;
                                break;
                            }}
                        }}

                        if (targetIndex !== -1) {{
                            const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
                            const dataRows = bodyRows.length ? bodyRows : rows.slice(startRow);
                            for (const row of dataRows) {{
                                const cells = Array.from(row.querySelectorAll('td, th'));
                                const text = normalize(cells[targetIndex]?.textContent || '');
                                if (text) return text;
                            }}
                        }}

                        for (const row of rows) {{
                            const cells = Array.from(row.querySelectorAll('td, th'));
                            if (cells.length < 2) continue;
                            const label = normalize(cells[0]?.textContent || '');
                            if (!label) continue;
                            if (isTarget(label)) {{
                                const value = normalize(cells[1]?.textContent || '');
                                if (value) return value;
                            }}
                        }}

                        return '';
                    }};

                    for (const table of tables) {{
                        const value = findInTable(table);
                        if (value) return value;
                    }}
                    return '';
                }}
                """
            )
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, str):
                last_value = value.strip()
        except Exception:
            pass
        await page.sleep(0.4)
    return last_value


async def get_asset_name_from_report_details(page, timeout: int = 8) -> str:
    end = time.time() + max(1, timeout)
    last_value = ""
    labels = [
        AR_ASSET_NAME_LABEL,
        AR_ASSET_TITLE_LABEL,
        AR_ASSET_NAME_LABEL_ALT,
        EN_ASSET_NAME_LABEL,
        "Asset Name/Description",
        "Asset Name / Description",
        "Asset Description",
    ]
    labels_json = json.dumps(labels)
    while time.time() < end:
        try:
            value = await page.evaluate(
                f"""
                () => {{
                    const normalize = (value) => (value || '')
                        .replace(/[\\u00a0]/g, ' ')
                        .replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '')
                        .replace(/\\s+/g, ' ')
                        .trim();

                    const labels = {labels_json}.map((t) => normalize(t));
                    const sortedLabels = labels.slice().sort((a, b) => b.length - a.length);
                    const isLabel = (text) => sortedLabels.some((label) => text === label || text.includes(label));

                    const tables = Array.from(document.querySelectorAll('table'));
                    for (const table of tables) {{
                        const rows = Array.from(table.querySelectorAll('tr'));
                        for (const row of rows) {{
                            const cells = Array.from(row.querySelectorAll('th, td'));
                            if (cells.length < 2) continue;
                            const label = normalize(cells[0]?.textContent || '');
                            if (!label || !isLabel(label)) continue;
                            const value = normalize(cells[1]?.textContent || '');
                            if (value && !isLabel(value)) return value;
                        }}
                    }}

                    const labelNodes = Array.from(
                        document.querySelectorAll('label, span, dt, th, td, div, p, li')
                    );
                    for (const node of labelNodes) {{
                        const labelText = normalize(node.textContent || '');
                        if (!labelText || !isLabel(labelText)) continue;

                        let sibling = node.nextElementSibling;
                        while (sibling) {{
                            const value = normalize(sibling.textContent || '');
                            if (value && !isLabel(value)) return value;
                            sibling = sibling.nextElementSibling;
                        }}

                        const parent = node.parentElement;
                        if (parent) {{
                            const siblings = Array.from(parent.children).filter((el) => el !== node);
                            for (const sib of siblings) {{
                                const value = normalize(sib.textContent || '');
                                if (value && !isLabel(value)) return value;
                            }}
                        }}
                    }}

                    const inputSelectors = [
                        'input[name="asset_name"]',
                        'input[name*="asset_name" i]',
                        'input[id*="asset_name" i]',
                        'input[name*="asset name" i]',
                        'input[placeholder*="Asset Name" i]',
                        'textarea[name="asset_name"]',
                        'textarea[name*="asset_name" i]',
                        'textarea[id*="asset_name" i]',
                        'textarea[placeholder*="Asset Name" i]'
                    ];
                    for (const selector of inputSelectors) {{
                        const field = document.querySelector(selector);
                        if (!field) continue;
                        const value = normalize(field.value || field.getAttribute('value') || '');
                        if (value && !isLabel(value)) return value;
                    }}

                    const rawText = document.body?.innerText || '';
                    const lines = rawText
                        .split(/\\n+/)
                        .map((line) => normalize(line))
                        .filter(Boolean);
                    for (let i = 0; i < lines.length; i += 1) {{
                        const line = lines[i];
                        const token = sortedLabels.find((label) => line.includes(label));
                        if (!token) continue;
                        let cleaned = normalize(line.replace(token, '').replace(':', ''));
                        if (cleaned && !isLabel(cleaned)) return cleaned;
                        const nextLine = lines[i + 1];
                        if (nextLine && !isLabel(nextLine)) return nextLine;
                    }}

                    return '';
                }}
                """
            )
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, str):
                last_value = value.strip()
        except Exception:
            pass
        await page.sleep(0.4)
    return last_value


async def get_report_title(page, timeout: int = 12, report_id: str = "") -> str:
    end = time.time() + max(1, timeout)
    last_title = ""
    report_id_value = repair_mojibake(str(report_id)) if report_id else ""
    report_id_json = json.dumps(report_id_value)
    while time.time() < end:
        try:
            direct_title = await page.evaluate("document.title")
            if isinstance(direct_title, str):
                cleaned = direct_title.replace("\u00a0", " ").strip()
                if cleaned:
                    return cleaned
                last_title = cleaned
        except Exception:
            pass

        try:
            html_text = await page.get_content()
            html_title = extract_title_from_html(html_text)
            if html_title:
                return html_title
        except Exception:
            pass

        try:
            title = await page.evaluate(
                f"""
                () => {{
                    const stripBidi = (value) => (value || '')
                        .replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '');
                    const normalize = (value) => stripBidi(value || '')
                        .replace(/[\\u00a0]/g, ' ')
                        .replace(/\\s+/g, ' ')
                        .trim();

                    const headTitleRaw = document.querySelector('head > title')?.textContent || '';
                    const headTitle = headTitleRaw.replace(/[\\u00a0]/g, ' ').trim();
                    if (headTitle) return headTitle;

                    const reportId = {report_id_json};
                    const arabicDigits = {{
                        '\u0660': '0',
                        '\u0661': '1',
                        '\u0662': '2',
                        '\u0663': '3',
                        '\u0664': '4',
                        '\u0665': '5',
                        '\u0666': '6',
                        '\u0667': '7',
                        '\u0668': '8',
                        '\u0669': '9'
                    }};
                    const normalizeForCompare = (value) =>
                        normalize(value).replace(/[\\u0660-\\u0669]/g, (d) => arabicDigits[d] || d);
                    const normalizedReportId = normalizeForCompare(reportId);

                    const isReportId = (value) => {{
                        if (!normalizedReportId) return false;
                        return normalizeForCompare(value) === normalizedReportId;
                    }};

                    const blacklist = [
                        'Report Status', '{AR_STATUS_LABEL}', '{AR_STATUS_LABEL_SHORT}',
                        'Registration Certificate', '{AR_CERTIFICATE_TEXT}',
                        'Confirmed', '{AR_STATUS_VALUE}'
                    ].map((value) => normalize(value));

                    const labels = [
                        '{EN_REPORT_TITLE_LABEL}', '{EN_REPORT_NAME_LABEL}', '{EN_ASSET_NAME_LABEL}',
                        '{AR_REPORT_TITLE_LABEL}', '{AR_REPORT_NAME_LABEL}', '{AR_ASSET_NAME_LABEL}',
                        '{AR_ASSET_TITLE_LABEL}', '{AR_ASSET_NAME_LABEL_ALT}'
                    ].map((value) => normalize(value));

                    const isValid = (text) => {{
                        const normalized = normalize(text);
                        if (!normalized) return false;
                        if (isReportId(normalized)) return false;
                        return !blacklist.some((b) => normalized.includes(b));
                    }};

                    const stripSiteSuffix = (text) => {{
                        if (!text) return text;
                        const separators = [" - ", " | "];
                        for (const sep of separators) {{
                            if (!text.includes(sep)) continue;
                            const parts = text.split(sep).map((p) => normalize(p)).filter(Boolean);
                            if (parts.length < 2) continue;
                            const tail = parts[parts.length - 1].toLowerCase();
                            if (tail.includes("qima") || tail.includes("taqeem")) {{
                                return parts[0];
                            }}
                        }}
                        return text;
                    }};

                    const headTitleFallback = stripSiteSuffix(
                        normalize(document.querySelector('head > title')?.textContent || '')
                    );
                    if (isValid(headTitleFallback)) return headTitleFallback;

                    const statusBlocks = Array.from(document.querySelectorAll('div.d-flex'));
                    for (const block of statusBlocks) {{
                        const span = block.querySelector('span');
                        if (!span) continue;
                        const label = normalize(span.textContent);
                        if (labels.some((token) => label.includes(token))) {{
                            const candidates = Array.from(block.querySelectorAll('b, strong, span'))
                                .filter((el) => el !== span);
                            for (const candidate of candidates) {{
                                const value = normalize(candidate.textContent);
                                if (isValid(value)) return value;
                            }}
                            const blockText = normalize(block.textContent);
                            const cleaned = normalize(blockText.replace(label, ''));
                            if (isValid(cleaned)) return cleaned;
                        }}
                    }}

                    const labelValues = Array.from(document.querySelectorAll('div, li, tr, p, dd'));
                    for (const row of labelValues) {{
                        const label = normalize(row.querySelector('span, label, th, td, div')?.textContent || '');
                        if (!label) continue;
                        if (labels.some((token) => label.includes(token))) {{
                            const value = normalize(
                                row.querySelector('b, strong, td:nth-child(2), span:nth-child(2), div:nth-child(2)')?.textContent || ''
                            );
                            if (isValid(value)) return value;
                            const rowText = normalize(row.textContent);
                            const cleaned = normalize(rowText.replace(label, ''));
                            if (isValid(cleaned)) return cleaned;
                        }}
                    }}

                    const labelNodes = Array.from(document.querySelectorAll('span, label, th, td, div, p, dt'));
                    for (const node of labelNodes) {{
                        const label = normalize(node.textContent);
                        if (!label || label.length > 80) continue;
                        if (!labels.some((token) => label.includes(token))) continue;

                        let sibling = node.nextElementSibling;
                        while (sibling) {{
                            const value = normalize(sibling.textContent);
                            if (isValid(value)) return value;
                            sibling = sibling.nextElementSibling;
                        }}

                        const parent = node.parentElement;
                        if (parent) {{
                            const candidates = Array.from(parent.children).filter((el) => el !== node);
                            for (const candidate of candidates) {{
                                const value = normalize(candidate.textContent);
                                if (isValid(value)) return value;
                            }}
                        }}
                    }}

                    const rawText = document.body?.innerText || '';
                    const lines = rawText
                        .split(/\\n+/)
                        .map((line) => normalize(line))
                        .filter(Boolean);
                    for (let i = 0; i < lines.length; i++) {{
                        const line = lines[i];
                        const token = labels.find((label) => line.includes(label));
                        if (!token) continue;
                        let cleaned = normalize(line.replace(token, '').replace(':', ''));
                        cleaned = cleaned.replace(/^-+/, '');
                        if (isValid(cleaned)) return cleaned;
                        const nextLine = lines[i + 1];
                        if (isValid(nextLine)) return nextLine;
                    }}

                    const elements = Array.from(
                        document.querySelectorAll('h1, h2, h3, h4, h5, .page-title, .report-title, .report-name, .title, .card-title')
                    );
                    const texts = elements
                        .map((el) => normalize(el.textContent))
                        .filter((text) => isValid(text));
                    if (texts.length) {{
                        texts.sort((a, b) => b.length - a.length);
                        return texts[0];
                    }}

                    const boldTexts = Array.from(document.querySelectorAll('b, strong'))
                        .map((el) => normalize(el.textContent))
                        .filter((text) => isValid(text));
                    if (boldTexts.length) {{
                        boldTexts.sort((a, b) => b.length - a.length);
                        return boldTexts[0];
                    }}

                    const formTitle = normalize(
                        document.querySelector('input[name*="title" i], input[name*="name" i], textarea[name*="title" i], textarea[name*="name" i]')?.value || ''
                    );
                    if (isValid(formTitle)) return formTitle;

                    const metaTitle = normalize(
                        document.querySelector('meta[property="og:title"], meta[name="title"]')?.content || ''
                    );
                    if (isValid(metaTitle)) return metaTitle;

                    const docTitle = stripSiteSuffix(normalize(document.title));
                    return isValid(docTitle) ? docTitle : '';
                }}
                """
            )
            if isinstance(title, str) and title.strip():
                return title.strip()
            if isinstance(title, str):
                last_title = title.strip()
        except Exception:
            pass
        await page.sleep(0.5)
    return last_title


async def has_confirmed_status(page) -> bool:
    try:
        result = await page.evaluate(
            f"""
            () => {{
                const normalize = (value) => (value || '')
                    .replace(/[\\u00a0]/g, ' ')
                    .replace(/\\s+/g, ' ')
                    .trim();

                const blocks = Array.from(document.querySelectorAll('div.d-flex.pt-sm.fs-xs'));
                for (const block of blocks) {{
                    const span = block.querySelector('span');
                    const b = block.querySelector('b');
                    if (!span || !b) continue;
                    const label = normalize(span.textContent);
                    const value = normalize(b.textContent);
                    const hasLabel =
                        label.includes('Report Status') ||
                        label.includes('{AR_STATUS_LABEL}') ||
                        label.includes('{AR_STATUS_LABEL_SHORT}');
                    const hasValue =
                        value.includes('Confirmed') ||
                        value.includes('{AR_STATUS_VALUE}');
                    if (hasLabel && hasValue) {{
                        return true;
                    }}
                }}

                const bodyText = normalize(document.body?.innerText || '');
                if ((bodyText.includes('Report Status') && bodyText.includes('Confirmed')) ||
                    (bodyText.includes('{AR_STATUS_LABEL}') && bodyText.includes('{AR_STATUS_VALUE}')) ||
                    (bodyText.includes('{AR_STATUS_LABEL_SHORT}') && bodyText.includes('{AR_STATUS_VALUE}'))) {{
                    return true;
                }}
                return false;
            }}
            """
        )
        return bool(result)
    except Exception:
        try:
            html = await page.get_content()
        except Exception:
            return False
        return (
            ("Report Status" in html and "Confirmed" in html)
            or (AR_STATUS_LABEL in html and AR_STATUS_VALUE in html)
            or (AR_STATUS_LABEL_SHORT in html and AR_STATUS_VALUE in html)
        )


def href_matches_certificate_markers(url: str) -> bool:
    if not url or not isinstance(url, str):
        return False
    lu = url.lower()
    return any(marker.lower() in lu for marker in CERTIFICATE_HREF_MARKERS)


def _looks_like_navigation_only_href(href: str) -> bool:
    h = (href or "").strip().lower()
    if not h:
        return True
    if h.startswith("javascript:") or h.startswith("mailto:"):
        return True
    return h == "#"


def absolutize_taqeem_href(url: str) -> str:
    if not url or not isinstance(url, str):
        return ""
    resolved = url.strip()
    if not resolved:
        return ""
    try:
        if resolved.startswith("//"):
            return "https:" + resolved
        if resolved.startswith("/"):
            return urljoin("https://qima.taqeem.gov.sa", resolved)
        if resolved.startswith(("http://", "https://")):
            return resolved
        return urljoin("https://qima.taqeem.gov.sa/", resolved)
    except Exception:
        return resolved


def _registration_token_from_url(url: str) -> str:
    if not url:
        return ""
    m = re.search(r"/report/([^/]+)/registration", url, flags=re.IGNORECASE)
    return (m.group(1) or "").strip() if m else ""


def extract_registration_url_from_html(html: str, listing_report_id: str = "") -> str:
    """
    Read the certificate navigation URL from raw page HTML:
    .../report/<certificate_id>/registration (id in source, not necessarily the listing report id).
    """
    if not html or not isinstance(html, str):
        return ""
    text = html_lib.unescape(repair_mojibake(html))

    hits = {}

    for rx in (
        re.compile(
            r"https://qima\.taqeem\.gov\.sa/report/([a-zA-Z0-9_-]{6,160})/registration",
            re.IGNORECASE,
        ),
        re.compile(
            r"https://(?:[\w.-]+\.)?taqeem\.gov\.sa/report/([a-zA-Z0-9_-]{6,160})/registration",
            re.IGNORECASE,
        ),
    ):
        for m in rx.finditer(text):
            full = m.group(0).split("?")[0].split("#")[0].rstrip("/")
            hits[full] = m.group(1)

    for rx in (
        re.compile(
            r"(?:href|routerLink|ng-href)\s*=\s*[\"']([^\"']*?/report/[a-zA-Z0-9_-]{6,160}/registration[^\"']*)[\"']",
            re.IGNORECASE,
        ),
        re.compile(
            r"[\"'](/report/[a-zA-Z0-9_-]{6,160}/registration)[\"']",
            re.IGNORECASE,
        ),
    ):
        for m in rx.finditer(text):
            frag = (m.group(1) or "").strip()
            full = absolutize_taqeem_href(frag.split("?")[0].split("#")[0].rstrip("/"))
            if "/report/" in full and "/registration" in full.lower():
                hits[full] = _registration_token_from_url(full)

    if not hits:
        return ""

    items = list(hits.items())
    rid = str(listing_report_id).strip() if listing_report_id is not None else ""
    for url, tok in items:
        if rid and tok and tok != rid:
            return url
    return items[0][0]


async def poll_registration_url_from_report_html(
    page, listing_report_id, rounds: int = 24, pause: float = 0.18
) -> str:
    last_blob = ""
    for _ in range(max(1, rounds)):
        blob = ""
        try:
            blob = await asyncio.wait_for(
                page.evaluate(
                    "typeof document !== 'undefined' && document.documentElement "
                    "? document.documentElement.outerHTML : ''"
                ),
                timeout=10.0,
            ) or ""
        except Exception:
            blob = ""

        needs_body = (
            not blob.strip()
            or "registration" not in blob.casefold()
        )
        if needs_body:
            try:
                blob = await page.get_content()
            except Exception:
                blob = blob or ""

        if blob:
            last_blob = blob
        found = extract_registration_url_from_html(blob or "", listing_report_id)
        if found:
            return found
        await page.sleep(pause)
    return extract_registration_url_from_html(last_blob or "", listing_report_id)


async def wait_for_registration_link_dom(page, timeout: int = 25):
    markers_json = json.dumps(list(CERTIFICATE_HREF_MARKERS))
    cert_full_js = json.dumps(repair_mojibake(AR_CERTIFICATE_TEXT))
    cert_short_js = json.dumps(repair_mojibake(AR_CERTIFICATE_TEXT_SHORT))
    persian_yeh = chr(0x06CC)
    arabic_yeh = chr(0x064A)

    deadline = time.time() + max(3, timeout)
    while time.time() < deadline:
        try:
            found = await page.evaluate(
                f"""
                () => {{
                    const markers = {markers_json}.map((m) => String(m).toLowerCase());
                    const certMatchesHref = (raw) => {{
                        const h = (raw || '').toLowerCase();
                        return markers.some((m) => h.includes(m));
                    }};
                    const normalize = (value) => (value || '')
                        .replace(/[\\u00a0]/g, ' ')
                        .replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '')
                        .replace(new RegExp('[{persian_yeh}]', 'g'), '{arabic_yeh}')
                        .replace(/\\s+/g, ' ')
                        .trim();
                    const certFull = normalize({cert_full_js});
                    const certShort = normalize({cert_short_js});

                    const collectRoots = (node) => {{
                        const out = [];
                        const stack = [node];
                        const seen = new Set();
                        while (stack.length) {{
                            const r = stack.pop();
                            if (!r || seen.has(r)) continue;
                            seen.add(r);
                            out.push(r);
                            try {{
                                if (r.querySelectorAll) {{
                                    Array.from(r.querySelectorAll('iframe')).forEach((ifr) => {{
                                        try {{
                                            const idoc = ifr.contentDocument;
                                            if (idoc && !seen.has(idoc)) stack.push(idoc);
                                        }} catch (_) {{}}
                                    }});
                                }}
                            }} catch (_) {{}}
                            try {{
                                const nodes = r.querySelectorAll ? Array.from(r.querySelectorAll('*')) : [];
                                for (const el of nodes) {{
                                    if (el.shadowRoot) stack.push(el.shadowRoot);
                                }}
                            }} catch (_) {{}}
                        }}
                        return out;
                    }};

                    const roots = collectRoots(document);

                    let bestPick = null;
                    let bestScore = 0;

                    const textMatchesCert = (t) =>
                        !!t &&
                        ((certFull.length > 0 && t.includes(certFull))
                            || (certShort.length > 0 && t.includes(certShort))
                            || t.toLowerCase().includes('registration certificate'));

                    const bumpBest = (entry) => {{
                        if (entry && entry.score > bestScore) {{
                            bestPick = entry;
                            bestScore = entry.score;
                        }}
                    }};

                    const hrefLooksRegistration = (h) => {{
                        if (!h) return false;
                        const s = String(h).toLowerCase();
                        if (!s.includes('registration')) return false;
                        return s.includes('qima.taqeem.gov.sa') || s.includes('taqeem.gov.sa');
                    }};

                    for (const r of roots) {{
                        try {{
                            const regAs = Array.from(
                                r.querySelectorAll?.(
                                    'a[href*="/registration"], a[href*="registration"], a[href*="Registration"]'
                                ) || [],
                            );
                            for (const a of regAs) {{
                                try {{
                                    let absHref = '';
                                    try {{
                                        absHref = a.href ? String(a.href) : '';
                                    }} catch (_) {{
                                        absHref = '';
                                    }}
                                    if (!absHref) {{
                                        absHref =
                                            ((a.getAttribute && a.getAttribute('href')) || '').trim();
                                    }}
                                    if (!hrefLooksRegistration(absHref)) continue;
                                    const rawAttr = (a.getAttribute && a.getAttribute('href')) || '';
                                    const text = normalize(a.innerText || a.textContent || '');
                                    bumpBest({{
                                        merged: absHref,
                                        rawAttr,
                                        absHref: absHref,
                                        score: 240,
                                        textSample: text.slice(0, 140),
                                        tag: 'a-registration-href',
                                    }});
                                }} catch (_) {{}}
                            }}
                        }} catch (_) {{}}

                        try {{
                            const wrapped = Array.from(
                                r.querySelectorAll?.('a[href] .btn-primary, a[href] button.btn-primary')
                                    || [],
                            );
                            for (const el of wrapped) {{
                                try {{
                                    const link = el.closest?.('a[href]');
                                    if (!link) continue;
                                    let ah = '';
                                    try {{
                                        ah = link.href ? String(link.href) : '';
                                    }} catch (_) {{
                                        ah = '';
                                    }}
                                    if (!ah) {{
                                        ah = ((link.getAttribute && link.getAttribute('href')) || '').trim();
                                    }}
                                    if (!hrefLooksRegistration(ah)) continue;
                                    const tx = normalize(el.innerText || el.textContent || '');
                                    const ltx = normalize(link.innerText || link.textContent || '');
                                    if (!textMatchesCert(tx) && !textMatchesCert(ltx)) continue;
                                    bumpBest({{
                                        merged: ah,
                                        rawAttr: (link.getAttribute && link.getAttribute('href')) || '',
                                        absHref: ah,
                                        score: 235,
                                        textSample: tx.slice(0, 140),
                                        tag: 'btn-inside-registration-a',
                                    }});
                                }} catch (_) {{}}
                            }}
                        }} catch (_) {{}}

                        try {{
                            const primaries = Array.from(
                                r.querySelectorAll?.('button.btn-primary, a.btn.btn-primary') || [],
                            );
                            for (const el of primaries) {{
                                try {{
                                    const link = el.closest?.('a[href]');
                                    if (!link) continue;
                                    let ah = '';
                                    try {{
                                        ah = link.href ? String(link.href) : '';
                                    }} catch (_) {{
                                        ah = '';
                                    }}
                                    if (!ah) {{
                                        ah = ((link.getAttribute && link.getAttribute('href')) || '').trim();
                                    }}
                                    if (!hrefLooksRegistration(ah)) continue;
                                    const tx = normalize(el.innerText || el.textContent || '');
                                    if (!textMatchesCert(tx)) continue;
                                    bumpBest({{
                                        merged: ah,
                                        rawAttr: (link.getAttribute && link.getAttribute('href')) || '',
                                        absHref: ah,
                                        score: 230,
                                        textSample: tx.slice(0, 140),
                                        tag: 'btn-primary-with-a',
                                    }});
                                }} catch (_) {{}}
                            }}
                        }} catch (_) {{}}
                    }}

                    const anchors = [];
                    for (const r of roots) {{
                        try {{
                            anchors.push(...Array.from(r.querySelectorAll?.('a[href]') || []));
                        }} catch (_) {{}}
                    }}

                    for (const a of anchors) {{
                        try {{
                            const rawAttr = (a.getAttribute && a.getAttribute('href')) || '';
                            let absHref = '';
                            try {{ absHref = a.href ? String(a.href) : ''; }} catch (_) {{}}
                            const mergedCell = absHref || rawAttr;
                            const text = normalize(a.innerText || a.textContent || '');
                            const title = normalize(a.getAttribute('title') || a.getAttribute('aria-label') || '');
                            const scoreByHref = certMatchesHref(mergedCell)
                                ? 100
                                : certMatchesHref(rawAttr)
                                    ? 95
                                    : 0;
                            let pickScore = scoreByHref;
                            if (textMatchesCert(text) || textMatchesCert(title)) {{
                                pickScore = Math.max(pickScore, 55);
                            }}
                            if (!pickScore) continue;

                            const entry = {{
                                merged: mergedCell,
                                rawAttr,
                                absHref,
                                score: pickScore,
                                textSample: text.slice(0, 120),
                                tag: 'a',
                            }};
                            if (pickScore > bestScore) {{
                                bestPick = entry;
                                bestScore = pickScore;
                            }}
                        }} catch (_) {{}}
                    }}

                    for (const r of roots) {{
                        let clickablesAll = [];
                        try {{
                            clickablesAll = Array.from(
                                r.querySelectorAll?.(
                                    'button.btn-primary, button[class*="btn-primary"], button, [role="button"]',
                                ) || [],
                            );
                        }} catch (_) {{}}
                        for (const button of clickablesAll) {{
                            try {{
                                const text = normalize(button.innerText || button.textContent || '');
                                const nested = button.closest?.('a[href]');
                                let nestedHref = '';
                                try {{
                                    nestedHref = nested
                                        ? nested.href || nested.getAttribute('href') || ''
                                        : '';
                                }} catch (_) {{
                                    nestedHref = '';
                                }}
                                if (!textMatchesCert(text) && !hrefLooksRegistration(nestedHref)) {{
                                    continue;
                                }}
                                const hrefFromNested = nestedHref;
                                const mergedHint = hrefFromNested || '';
                                let pickScore = hrefFromNested ? 85 : 50;
                                if (button.matches?.('button.btn-primary, button[class*="btn-primary"]')) {{
                                    pickScore += 5;
                                }}
                                const entry = {{
                                    merged: mergedHint,
                                    rawAttr: hrefFromNested || '',
                                    absHref: mergedHint,
                                    score: pickScore,
                                    textSample: text.slice(0, 120),
                                    tag: 'button',
                                }};
                                if (pickScore > bestScore) {{
                                    bestPick = entry;
                                    bestScore = pickScore;
                                }}
                            }} catch (_) {{}}
                        }}
                    }}

                    if (bestPick && bestScore > 0) return bestPick;

                    return null;
                }}
                """
            )

            if isinstance(found, dict) and int(found.get("score") or 0) > 0:
                return found
        except Exception as ex:
            print(
                "[PY] RegistrationCertificateDownloader: certificate DOM scan evaluate failed: "
                f"{type(ex).__name__}: {format_error(ex)}",
                file=sys.stderr,
                flush=True,
            )
        await page.sleep(0.45)
    return None


async def find_registration_certificate_target(page, timeout: int = 25):
    return await wait_for_registration_link_dom(page, timeout=timeout)


async def _after_click_resolve_location(page, before_url: str, timeout: float = 36.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            current = await page.evaluate("window.location.href")
            if isinstance(current, str) and current.strip() and current.strip() != before_url.strip():
                if href_matches_certificate_markers(current) or current.lower().endswith(".pdf"):
                    return current.strip()
                if "/report/" not in current or "registration" in current.lower() or "certificate" in current.lower():
                    return current.strip()
        except Exception:
            pass
        await page.sleep(0.35)
    try:
        return (await page.evaluate("window.location.href") or "").strip()
    except Exception:
        return ""


async def resolve_registration_url(page, target):
    """Resolve absolute certificate URL; click router-only certificate controls when needed."""
    if not isinstance(target, dict):
        return ""

    merged_raw = (
        (target.get("absHref") or target.get("merged") or target.get("href") or "").strip()
        or (target.get("rawAttr") or "").strip()
    )

    href = ""
    if merged_raw:
        candidate = absolutize_taqeem_href(merged_raw)
        if candidate and not _looks_like_navigation_only_href(candidate):
            href = candidate

    if href:
        return href

    if target.get("element"):
        try:
            parent = target["element"].parent
            if parent and parent.tag_name == "a":
                ph = (parent.attrs.get("href") or "").strip()
                ph_abs = absolutize_taqeem_href(ph)
                if ph_abs and not _looks_like_navigation_only_href(ph_abs):
                    href = ph_abs
        except Exception:
            pass

    if href:
        return href

    markers_json = json.dumps(list(CERTIFICATE_HREF_MARKERS))
    cert_full_js = json.dumps(repair_mojibake(AR_CERTIFICATE_TEXT))
    cert_short_js = json.dumps(repair_mojibake(AR_CERTIFICATE_TEXT_SHORT))
    persian_yeh = chr(0x06CC)
    arabic_yeh = chr(0x064A)

    merged_abs = ""
    for attempt in range(6):
        try:
            before = await page.evaluate("window.location.href || ''")
        except Exception:
            before = ""

        clicked = False
        try:
            clicked = await page.evaluate(
                f"""
                () => {{
                    const markers = {markers_json}.map((m) => String(m).toLowerCase());
                    const certMatchesHref = (raw) => {{
                        const h = (raw || '').toLowerCase();
                        return markers.some((m) => h.includes(m));
                    }};
                    const normalize = (value) => (value || '')
                        .replace(/[\\u00a0]/g, ' ')
                        .replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '')
                        .replace(new RegExp('[{persian_yeh}]', 'g'), '{arabic_yeh}')
                        .replace(/\\s+/g, ' ')
                        .trim();
                    const certFull = normalize({cert_full_js});
                    const certShort = normalize({cert_short_js});

                    const textMatchesCert = (t) =>
                        !!t &&
                        ((certFull.length > 0 && t.includes(certFull))
                            || (certShort.length > 0 && t.includes(certShort))
                            || t.toLowerCase().includes('registration certificate'));

                    const collectRoots = (doc) => {{
                        const roots = [];
                        const stack = [doc];
                        const seen = new Set();
                        while (stack.length) {{
                            const root = stack.pop();
                            if (!root || seen.has(root)) continue;
                            seen.add(root);
                            roots.push(root);
                            try {{
                                if (root.querySelectorAll) {{
                                    Array.from(root.querySelectorAll('iframe')).forEach((ifr) => {{
                                        try {{
                                            const idoc = ifr.contentDocument;
                                            if (idoc && !seen.has(idoc)) stack.push(idoc);
                                        }} catch (_) {{}}
                                    }});
                                }}
                            }} catch (_) {{}}
                            try {{
                                const els = Array.from(root.querySelectorAll('*'));
                                for (const el of els) {{
                                    if (el.shadowRoot) stack.push(el.shadowRoot);
                                }}
                            }} catch (_) {{}}
                        }}
                        return roots;
                    }};

                    const roots = collectRoots(document);
                    const anchors = [];
                    for (const r of roots) {{
                        try {{
                            anchors.push(...Array.from(r.querySelectorAll?.('a[href]') || []));
                        }} catch (_) {{}}
                    }}

                    let best = null;

                    const considerAnchor = (a) => {{
                        try {{
                            const rawAttr = (a.getAttribute && a.getAttribute('href')) || '';
                            let absHref = '';
                            try {{ absHref = a.href ? String(a.href) : ''; }} catch (_) {{}}
                            const mergedLocal = absHref || rawAttr;
                            const text = normalize(a.innerText || a.textContent || '');
                            let score =
                                certMatchesHref(mergedLocal) ? 100 : certMatchesHref(rawAttr) ? 90 : 0;
                            if (textMatchesCert(text)) {{
                                score = Math.max(score, 55);
                            }}
                            if (score <= 0) return;
                            if (!best || score > best.score) {{
                                best = {{ el: a, score }};
                            }}
                        }} catch (_) {{}}
                    }};

                    for (const a of anchors) {{
                        considerAnchor(a);
                    }}

                    for (const r of roots) {{
                        let buttons = [];
                        try {{
                            buttons = Array.from(
                                r.querySelectorAll?.(
                                    'button.btn-primary, button[class*="btn-primary"], button, [role="button"]',
                                ) || [],
                            );
                        }} catch (_) {{}}
                        for (const button of buttons) {{
                            const text = normalize(button.innerText || button.textContent || '');
                            if (!textMatchesCert(text)) continue;
                            let bs = 44;
                            if (button.matches?.('button.btn-primary, button[class*="btn-primary"]'))
                                bs = 48;
                            if (!best || best.score < bs) {{
                                best = {{ el: button, score: bs }};
                            }}
                        }}
                    }}

                    const tryClick = (el) => {{
                        if (!el) return false;
                        try {{
                            el.scrollIntoView?.({{ block: 'center', inline: 'center' }});
                        }} catch (_) {{}}
                        try {{
                            el.focus?.();
                        }} catch (_) {{}}
                        const mkMouse = (type) => {{
                            try {{
                                el.dispatchEvent?.(
                                    new MouseEvent(type, {{
                                        bubbles: true,
                                        composed: true,
                                        cancelable: true,
                                        view: window,
                                    }}),
                                );
                            }} catch (_) {{}}
                        }};
                        mkMouse('mousedown');
                        mkMouse('mouseup');
                        mkMouse('click');
                        ['keydown', 'keypress', 'keyup'].forEach((type) => {{
                            try {{
                                el.dispatchEvent?.(
                                    new KeyboardEvent(type, {{
                                        key: 'Enter',
                                        code: 'Enter',
                                        keyCode: 13,
                                        bubbles: true,
                                        composed: true,
                                        cancelable: true,
                                        view: window,
                                    }}),
                                );
                            }} catch (_) {{}}
                        }});
                        try {{
                            if (typeof el.click === 'function') el.click();
                        }} catch (_) {{}}
                        return true;
                    }};

                    if (best?.el && tryClick(best.el))
                        return true;
                    return false;
                }}
                """
            )
        except Exception:
            clicked = False

        await page.sleep(0.5 + attempt * 0.12)
        resolved_after = ""
        if clicked:
            resolved_after = await _after_click_resolve_location(page, before, timeout=30.0)

        candidate = absolutize_taqeem_href(resolved_after or "")
        before_s = (before or "").strip()
        after_s = candidate.strip() if candidate else ""
        if candidate and not _looks_like_navigation_only_href(candidate):
            if after_s and after_s != before_s:
                merged_abs = candidate
                break
            if '/registration' in after_s.lower():
                merged_abs = candidate
                break

    if not merged_abs and target.get("element"):
        try:
            try:
                before = await page.evaluate("window.location.href || ''")
            except Exception:
                before = ""
            await target["element"].click()
            await page.sleep(1.0)
            resolved_after = await _after_click_resolve_location(page, before, timeout=24.0)
            candidate = absolutize_taqeem_href(resolved_after or "")
            if candidate and not _looks_like_navigation_only_href(candidate):
                merged_abs = candidate
        except Exception:
            pass

    if not merged_abs:
        try:
            merged_abs = absolutize_taqeem_href(
                (await page.evaluate("window.location.href || ''") or "").strip()
            )
        except Exception:
            merged_abs = ""

    if merged_abs and _looks_like_navigation_only_href(merged_abs):
        merged_abs = ""
    return merged_abs


async def configure_download_path(page, download_path: str):
    os.makedirs(download_path, exist_ok=True)
    if hasattr(page, "set_download_path"):
        await page.set_download_path(download_path)
        return

    import nodriver as uc

    await page.send(
        uc.cdp.browser.set_download_behavior(
            behavior="allow",
            download_path=os.path.abspath(download_path),
            events_enabled=True,
        )
    )


async def _wait_for_chrome_pdf_embed_ready(page, timeout: float = 14.0) -> bool:
    deadline = time.time() + max(1.0, timeout)
    while time.time() < deadline:
        try:
            ok = await asyncio.wait_for(
                page.evaluate(
                    r"""
                    () => {
                        const path = String(window.location.pathname || '').toLowerCase();
                        if (path.includes('/registration')) return true;
                        const e = document.querySelector('embed');
                        if (e && (e.getBoundingClientRect().width || 0) > 4) return true;
                        const html = document.documentElement && document.documentElement.innerHTML
                            ? document.documentElement.innerHTML
                            : '';
                        return html.includes('google-chrome-pdf') || html.includes('original-url=');
                    }
                    """
                ),
                timeout=6.0,
            )
            if ok:
                return True
        except Exception:
            pass
        await page.sleep(0.25)
    return False


async def _cdp_focus_pdf_viewport_click(page) -> None:
    import nodriver as uc

    inp = uc.cdp.input_
    try:
        btn = inp.MouseButton("left")
    except Exception:
        return

    try:
        pos = await asyncio.wait_for(
            page.evaluate(
                r"""
                () => {
                    const e = document.querySelector('embed');
                    if (e) {
                        try {
                            e.focus();
                        } catch (_) {}
                        try {
                            e.scrollIntoView({ block: 'center', inline: 'center' });
                        } catch (_) {}
                        const r = e.getBoundingClientRect();
                        if (r.width > 2 && r.height > 2) {
                            return {
                                ok: true,
                                cx: r.left + r.width / 2,
                                cy: r.top + r.height / 2,
                                dpr: window.devicePixelRatio || 1,
                            };
                        }
                    }
                    return {
                        ok: true,
                        cx: (window.innerWidth || 800) / 2,
                        cy: (window.innerHeight || 600) / 2,
                        dpr: window.devicePixelRatio || 1,
                    };
                }
                """
            ),
            timeout=10.0,
        )
    except Exception:
        return

    if not isinstance(pos, dict) or not pos.get("ok"):
        return

    cx, cy = float(pos["cx"]), float(pos["cy"])
    dpr = max(float(pos.get("dpr") or 1.0), 0.75)

    for x_v, y_v in ((cx, cy), (cx / dpr, cy / dpr)):
        try:
            await page.send(
                inp.dispatch_mouse_event(
                    type_="mouseMoved",
                    x=x_v,
                    y=y_v,
                    button=None,
                    buttons=0,
                ),
            )
            await page.sleep(0.05)
            await page.send(
                inp.dispatch_mouse_event(
                    type_="mousePressed",
                    x=x_v,
                    y=y_v,
                    button=btn,
                    buttons=1,
                    click_count=1,
                ),
            )
            await page.sleep(0.04)
            await page.send(
                inp.dispatch_mouse_event(
                    type_="mouseReleased",
                    x=x_v,
                    y=y_v,
                    button=btn,
                    buttons=0,
                    click_count=1,
                ),
            )
            return
        except Exception:
            continue


async def _cdp_send_ctrl_s_raw(page) -> None:
    import nodriver as uc

    inp = uc.cdp.input_
    ctrl = 2
    await page.send(
        inp.dispatch_key_event(
            type_="rawKeyDown",
            modifiers=ctrl,
            key="Control",
            code="ControlLeft",
            windows_virtual_key_code=17,
        ),
    )
    await page.sleep(0.05)
    await page.send(
        inp.dispatch_key_event(
            type_="rawKeyDown",
            modifiers=ctrl,
            key="s",
            code="KeyS",
            windows_virtual_key_code=83,
        ),
    )
    await page.sleep(0.05)
    await page.send(
        inp.dispatch_key_event(
            type_="keyUp",
            modifiers=ctrl,
            key="s",
            code="KeyS",
            windows_virtual_key_code=83,
        ),
    )
    await page.send(
        inp.dispatch_key_event(
            type_="keyUp",
            modifiers=0,
            key="Control",
            code="ControlLeft",
            windows_virtual_key_code=17,
        ),
    )


async def _cdp_send_ctrl_s_keydown(page) -> None:
    import nodriver as uc

    inp = uc.cdp.input_
    await page.send(
        inp.dispatch_key_event(
            type_="keyDown",
            modifiers=0,
            key="Control",
            code="ControlLeft",
            windows_virtual_key_code=17,
        ),
    )
    await page.sleep(0.05)
    await page.send(
        inp.dispatch_key_event(
            type_="keyDown",
            modifiers=2,
            key="s",
            code="KeyS",
            windows_virtual_key_code=83,
        ),
    )
    await page.sleep(0.05)
    await page.send(
        inp.dispatch_key_event(
            type_="keyUp",
            modifiers=2,
            key="s",
            code="KeyS",
            windows_virtual_key_code=83,
        ),
    )
    await page.send(
        inp.dispatch_key_event(
            type_="keyUp",
            modifiers=0,
            key="Control",
            code="ControlLeft",
            windows_virtual_key_code=17,
        ),
    )


async def _win_os_ctrl_s_sequence(page) -> None:
    """Send real Ctrl+S to the foreground window (Windows) — matches manual save."""
    try:
        await page.bring_to_front()
    except Exception:
        pass
    await page.sleep(0.35)
    ok = await async_os_hotkey_ctrl_s()
    if not ok:
        raise RuntimeError("os_hotkey_ctrl_s_unsupported")


async def try_download_certificate_via_viewer_ctrl_s(
    page,
    download_dir: str,
    report_id: str,
    wait_seconds: float = 55.0,
) -> str | None:
    """
    Same as manual Ctrl+S on Chrome PDF viewer: saves real PDF bytes when
    Browser.setDownloadBehavior targets download_dir.
    """
    try:
        await page.bring_to_front()
    except Exception:
        pass
    await page.sleep(0.12)

    try:
        baseline = set(os.listdir(download_dir))
    except Exception:
        baseline = set()

    await _wait_for_chrome_pdf_embed_ready(page, timeout=16.0)

    sequences = [_cdp_send_ctrl_s_raw, _cdp_send_ctrl_s_keydown]
    if sys.platform.startswith("win"):
        sequences.append(_win_os_ctrl_s_sequence)

    nseq = max(1, len(sequences))
    time_per = max(18.0, float(wait_seconds) / nseq)

    for idx, seq in enumerate(sequences):
        rest = max(12.0, float(wait_seconds) - idx * time_per)
        timeout_this = time_per if idx < nseq - 1 else rest

        try:
            await _cdp_focus_pdf_viewport_click(page)
            await page.sleep(0.14)
            await page.evaluate("window.focus && window.focus()")
            await page.sleep(0.06)
        except Exception:
            pass

        try:
            await seq(page)
        except Exception as err:
            print(
                "[PY] RegistrationCertificateDownloader: Ctrl+S sequence "
                f"{getattr(seq, '__name__', seq)} failed for report {report_id}: "
                f"{type(err).__name__}: {format_error(err)}",
                file=sys.stderr,
                flush=True,
            )
            continue

        print(
            "[PY] RegistrationCertificateDownloader: dispatched "
            f"{getattr(seq, '__name__', 'ctrl_s')} for report {report_id}; "
            f"waiting up to {int(timeout_this)}s",
            file=sys.stderr,
            flush=True,
        )
        try:
            saved = await wait_for_downloaded_file(
                download_dir,
                timeout=int(timeout_this),
                baseline_filenames=baseline,
            )
            if saved and os.path.isfile(saved):
                return saved
        except TimeoutError:
            continue
        except Exception:
            continue

    return None


async def save_registration_pdf_via_chrome_viewer_ctrl_s(
    page,
    registration_url: str,
    download_path: str,
    preferred_name: str,
    report_id: str,
) -> str | None:
    """
    Open the registration certificate tab if needed, then Ctrl+S (Chrome PDF viewer)
    into a fresh temp folder and move the file to download_path.
    """
    target = (registration_url or "").strip()
    if not target:
        return None

    try:
        cur = (await page.evaluate("window.location.href || ''") or "").strip()
    except Exception:
        cur = ""

    same = (
        cur.split("#")[0].rstrip("/").casefold()
        == target.split("#")[0].rstrip("/").casefold()
    )
    if not same:
        await navigate_with_timeout(
            page,
            target,
            f"ctrl+s registration certificate {report_id}",
            timeout=42.0,
        )
    await page.sleep(0.85)

    work_dir = make_temp_download_dir(download_path, report_id)
    try:
        for attempt in range(1, 4):
            await configure_download_path(page, work_dir)
            await page.sleep(0.12)
            print(
                "[PY] RegistrationCertificateDownloader: Ctrl+S certificate attempt "
                f"{attempt}/3 for report {report_id}",
                file=sys.stderr,
                flush=True,
            )
            saved = await try_download_certificate_via_viewer_ctrl_s(
                page,
                work_dir,
                str(report_id),
                wait_seconds=95.0,
            )
            if saved:
                return move_downloaded_certificate(
                    saved,
                    download_path,
                    build_certificate_filename(preferred_name, report_id),
                )
            await page.sleep(0.55)
    finally:
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception:
            pass

    return None


async def wait_for_pdf_download_button(page, timeout: int = 20) -> bool:
    deadline = time.time() + max(1, timeout)
    while time.time() < deadline:
        try:
            ready = await page.evaluate(
                """
                () => {
                    const stack = [document];
                    for (let i = 0; i < stack.length; i += 1) {
                        const root = stack[i];
                        if (!root) continue;
                        const selectors = [
                            'cr-icon-button#download',
                            'cr-icon-button[slot="downloads"]',
                            'cr-icon-button.toolbar-button',
                            'cr-icon-button[downloads]',
                            'cr-icon-button[aria-label*="ownload" i]',
                            'cr-toolbar cr-icon-button',
                            'viewer-toolbar cr-icon-button',
                            '#downloads',
                            '#download',
                            '#download-button',
                            '#downloadButton',
                            '#toolbar-save',
                            '#save',
                            '#save-button',
                            '[id="download"]',
                            '[id="downloads"]',
                            'button[class*="download" i]',
                            '[aria-label*="Download" i]',
                            '[title*="Download" i]',
                            '[aria-label*="تنزيل"]',
                            '[title*="تنزيل"]',
                            '[title*="حميل" i]',
                            'pdf-toolbar cr-icon-button',
                            'toolbar cr-icon-button',
                            '#maskedImage',
                            'svg#baseSvg',
                            'path[d^="M480-336"]',
                            'div#icon',
                            '#icon'
                        ];
                        for (const selector of selectors) {
                            try {
                                if (root.querySelector?.(selector)) return true;
                            } catch (_) {}
                        }
                        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
                        for (const node of nodes) {
                            if (node.shadowRoot) stack.push(node.shadowRoot);
                            try {
                                const tn = node.tagName;
                                if (
                                    (tn === 'IFRAME'
                                        || tn === 'FRAME'
                                        || tn === 'OBJECT')
                                    && node.contentDocument
                                ) {
                                    stack.push(node.contentDocument);
                                }
                            } catch (_) {}
                        }
                    }
                    return false;
                }
                """
            )
            if ready:
                return True
        except Exception:
            pass
        await page.sleep(0.22)
    return False


async def click_pdf_viewer_download(page, timeout: int = 25, report_id: str = ""):
    deadline = time.time() + max(1, timeout)
    while time.time() < deadline:
        try:
            result = await page.evaluate(
                r"""
                () => {
                    const CLICK_EVT = [
                        'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click',
                    ];

                    const firePointerClick = (el, win) => {
                        if (!el) return false;
                        const w = win || window;
                        let cx = null;
                        let cy = null;
                        try {
                            const r = el.getBoundingClientRect();
                            if (r.width > 2 && r.height > 2) {
                                cx = Math.round(r.left + r.width / 2);
                                cy = Math.round(r.top + r.height / 2);
                            }
                        } catch (_) {}
                        try {
                            el.scrollIntoView({ block: 'center', inline: 'center' });
                        } catch (_) {}
                        try {
                            el.focus();
                        } catch (_) {}
                        try {
                            el.click();
                            return true;
                        } catch (_) {}
                        if (cx !== null && cy !== null) {
                            for (const type of CLICK_EVT) {
                                try {
                                    el.dispatchEvent(new MouseEvent(type, {
                                        bubbles: true,
                                        cancelable: true,
                                        composed: true,
                                        view: w,
                                        clientX: cx,
                                        clientY: cy,
                                        button: 0,
                                        buttons:
                                            type === 'mousedown'
                                            || type === 'pointerdown'
                                                ? 1
                                                : 0,
                                    }));
                                } catch (_) {}
                            }
                            return true;
                        }
                        return false;
                    };

                    const unwrapDownloadTarget = (element, host) => {
                        if (!element) return null;

                        const toolbarIconWrap = (
                            typeof element.closest === 'function'
                            && (
                                element.closest('div#icon')
                                || element.closest('[id="icon"]')
                            )
                        );
                        if (toolbarIconWrap) return toolbarIconWrap;

                        const tag = String(element.tagName || '').toUpperCase();
                        if (tag === 'PATH' || tag === 'SVG' || element.id === 'baseSvg') {
                            try {
                                const rn = typeof element.getRootNode === 'function'
                                    ? element.getRootNode()
                                    : null;
                                const svgHost = rn && rn.host;
                                if (
                                    svgHost
                                    && svgHost.parentElement
                                    && svgHost.parentElement.id === 'icon'
                                ) {
                                    return svgHost.parentElement;
                                }
                            } catch (_) {}
                            const toolbar = (
                                typeof element.closest === 'function'
                                && element.closest(
                                    'cr-toolbar, viewer-toolbar, pdf-toolbar, embed-toolbar',
                                )
                            );
                            if (toolbar && typeof toolbar.querySelector === 'function') {
                                const btn =
                                    toolbar.querySelector(
                                        '[id="icon"], div#icon, cr-icon-button#download',
                                    );
                                if (btn) return btn;
                            }
                        }

                        let anchor = (
                            typeof element.closest === 'function'
                            && element.closest(
                                'cr-icon-button, button, [role="button"], a, [id="download"]',
                            )
                        );
                        if (!anchor && host && typeof host.closest === 'function') {
                            anchor = host.closest(
                                'cr-icon-button, button, [role="button"], a, [id="download"]',
                            );
                        }
                        if (anchor) return anchor;

                        if (
                            host
                            && typeof host.matches === 'function'
                            && host.matches(
                                'cr-icon-button, button, [role="button"], a, [id="download"]',
                            )
                        ) {
                            return host;
                        }
                        return element;
                    };

                    const pickToolbarIconDiv = (root) => {
                        if (!root || typeof root.querySelector !== 'function') return null;

                        let icon = root.querySelector('div#icon');
                        if (!icon && typeof root.getElementById === 'function') {
                            const byId = root.getElementById('icon');
                            if (byId && typeof byId.matches === 'function' && byId.matches('div')) {
                                icon = byId;
                            }
                        }
                        if (!icon && typeof root.getElementById === 'function') {
                            const masked = root.getElementById('maskedImage');
                            if (masked) {
                                icon = (
                                    (typeof masked.closest === 'function' && masked.closest('#icon'))
                                    || (
                                        masked.parentElement
                                        && masked.parentElement.id === 'icon'
                                            ? masked.parentElement
                                            : null
                                    )
                                );
                            }
                        }
                        return icon || null;
                    };

                    const pairSeen = new WeakSet();
                    const pairs = [];

                    const pushPair = (root, win) => {
                        if (!root || pairSeen.has(root)) return;
                        pairSeen.add(root);
                        pairs.push({ root, win: win || window });
                    };

                    pushPair(document, window);

                    for (let pi = 0; pi < pairs.length; pi += 1) {
                        const pr = pairs[pi];
                        const { root, win } = pr;
                        if (!root) continue;

                        const iconDiv = pickToolbarIconDiv(root);
                        if (iconDiv && firePointerClick(iconDiv, win)) {
                            return {
                                clicked: true,
                                via: 'pdf-toolbar-div-icon',
                                tag: iconDiv.tagName || '',
                                id: iconDiv.id || '',
                            };
                        }

                        const nl = root.querySelectorAll('*');
                        const nodes = Array.from(nl);
                        for (const node of nodes) {
                            if (node.shadowRoot) pushPair(node.shadowRoot, win);
                            try {
                                const name = node.tagName;
                                if (
                                    name === 'IFRAME'
                                    || name === 'FRAME'
                                    || name === 'OBJECT'
                                ) {
                                    const doc = node.contentDocument;
                                    const w = node.contentWindow;
                                    if (doc && w) pushPair(doc, w);
                                }
                            } catch (_) {}
                        }
                    }

                    const selectors = [
                        'cr-icon-button#download',
                        'cr-icon-button[slot="downloads"]',
                        'cr-icon-button.toolbar-button',
                        'cr-icon-button[downloads]',
                        'cr-icon-button[aria-label*="ownload" i]',
                        'cr-toolbar cr-icon-button',
                        'viewer-toolbar cr-icon-button',
                        'pdf-toolbar cr-icon-button',
                        'toolbar cr-icon-button',
                        '#downloads',
                        '#download',
                        '#download-button',
                        '#downloadButton',
                        '#toolbar-save',
                        '#save',
                        '#save-button',
                        '[id="download"]',
                        '[id="downloads"]',
                        'button[class*="download" i]',
                        '[aria-label*="Download" i]',
                        '[title*="Download" i]',
                        '[aria-label*="تنزيل"]',
                        '[title*="تنزيل"]',
                        '[title*="حميل" i]',
                        'path[d^="M480-336"]',
                        'path[d*="M480-336"]',
                        'svg#baseSvg',
                        'div#icon',
                        '#icon',
                        '#maskedImage',
                        'cr-icon',
                    ];

                    const stack = [{ root: document, host: null, win: window }];
                    const seenRoots = new Set();

                    const pushRootLegacy = (r, host, win) => {
                        if (!r || seenRoots.has(r)) return;
                        seenRoots.add(r);
                        stack.push({ root: r, host, win: win || window });
                    };

                    for (let i = 0; i < stack.length; i += 1) {
                        const slot = stack[i];
                        const { root, host, win } = slot;
                        if (!root) continue;

                        for (const selector of selectors) {
                            let matches = [];
                            try {
                                matches = Array.from(root.querySelectorAll(selector));
                            } catch (_) {
                                matches = [];
                            }
                            for (const match of matches) {
                                const target = unwrapDownloadTarget(match, host);
                                if (firePointerClick(target, win)) {
                                    return {
                                        clicked: true,
                                        selector,
                                        tag: target ? target.tagName : match.tagName,
                                        id: target ? target.id : match.id,
                                    };
                                }
                            }
                        }

                        let nodesLegacy = [];
                        try {
                            nodesLegacy = Array.from(root.querySelectorAll('*'));
                        } catch (_) {
                            nodesLegacy = [];
                        }

                        for (const node of nodesLegacy) {
                            if (node.shadowRoot) pushRootLegacy(node.shadowRoot, node, win);
                            try {
                                const tn = node.tagName;
                                if (
                                    tn === 'IFRAME'
                                    || tn === 'FRAME'
                                    || tn === 'OBJECT'
                                ) {
                                    const doc = node.contentDocument;
                                    const w = node.contentWindow;
                                    if (doc && w) pushRootLegacy(doc, node, w);
                                }
                            } catch (_) {}
                        }
                    }

                    const iconRetry = [{ root: document, host: null, win: window }];
                    const retrySeen = new WeakSet();

                    for (let r = 0; r < iconRetry.length; r += 1) {
                        const rr = iconRetry[r];
                        const root = rr.root;
                        const win = rr.win || window;

                        if (!root || retrySeen.has(root)) continue;
                        retrySeen.add(root);

                        let ctrls = [];
                        try {
                            ctrls = Array.from(
                                root.querySelectorAll(
                                    'cr-icon-button, button.toolbox-button, [id="icon"]',
                                ),
                            );
                        } catch (_) {
                            ctrls = [];
                        }

                        for (const btn of ctrls) {
                            const lab = (
                                `${btn.title || ''} ${btn.id || ''} ${btn.slot || ''} `
                                + `${btn.localName} ${btn.getAttribute('aria-label') || ''}`
                            ).toLowerCase();
                            const hit =
                                lab.includes('download')
                                || lab.includes('save')
                                || lab.includes('تنزيل')
                                || lab.includes('حميل')
                                || btn.id === 'icon';
                            if (hit && firePointerClick(btn, win)) {
                                return {
                                    clicked: true,
                                    selector: 'cr-icon-scan',
                                    tag: btn.tagName,
                                    id: btn.id,
                                };
                            }
                        }

                        let kids = [];
                        try {
                            kids = Array.from(root.querySelectorAll('*'));
                        } catch (_) {
                            kids = [];
                        }

                        for (const node of kids) {
                            if (node.shadowRoot)
                                iconRetry.push({
                                    root: node.shadowRoot,
                                    host: node,
                                    win,
                                });

                            try {
                                const tg = node.tagName;
                                if (
                                    tg === 'IFRAME'
                                    || tg === 'FRAME'
                                    || tg === 'OBJECT'
                                ) {
                                    const doc = node.contentDocument;
                                    const w = node.contentWindow;
                                    if (doc && w)
                                        iconRetry.push({ root: doc, host: node, win: w });
                                }
                            } catch (_) {}
                        }
                    }

                    return { clicked: false };
                }
                """
            )
            if isinstance(result, dict) and result.get("clicked"):
                return result
        except Exception:
            pass

        await page.sleep(0.35)

    cdp = await click_pdf_download_via_viewport_cdp(page, report_id=report_id)
    if cdp.get("clicked"):
        return cdp

    return {"clicked": False, "error": "PDF download button not found"}


async def click_pdf_download_via_viewport_cdp(page, report_id: str = "") -> dict:
    """
    Fallback: locate div#icon (certificate PDF toolbar) in any same-origin subtree
    and send mouse events via CDP (Chrome PDF UI may ignore pure JS clicks).
    """
    import nodriver as uc

    inp = getattr(uc.cdp, "input_", None)
    if inp is None or not hasattr(page, "send"):
        return {"clicked": False}

    try:
        pos = await asyncio.wait_for(
            page.evaluate(
                r"""
                () => {
                    const pickToolbarIcon = (root) => {
                        if (!root || typeof root.querySelector !== 'function') return null;

                        let icon = root.querySelector('div#icon');
                        if (!icon && typeof root.getElementById === 'function') {
                            const masked = root.getElementById('maskedImage');
                            if (masked) {
                                icon =
                                    (typeof masked.closest === 'function'
                                        && masked.closest('#icon'))
                                    || (
                                        masked.parentElement
                                        && masked.parentElement.id === 'icon'
                                            ? masked.parentElement
                                            : null
                                    );
                            }
                            if (!icon) {
                                const bid = root.getElementById('icon');
                                if (
                                    bid
                                    && typeof bid.matches === 'function'
                                    && bid.matches('div')
                                )
                                    icon = bid;
                            }
                        }
                        return icon || null;
                    };

                    const seen = new WeakSet();
                    const frontier = [{ root: document, win: window }];

                    for (let fi = 0; fi < frontier.length; fi += 1) {
                        const slot = frontier[fi];
                        const root = slot.root;
                        const win = slot.win || window;
                        if (!root || seen.has(root)) continue;
                        seen.add(root);

                        let el = pickToolbarIcon(root);
                        try {
                            if (!el && root.querySelector) {
                                const alt = root.querySelector(
                                    'cr-icon-button#download, cr-icon-button[slot="downloads"]',
                                );
                                if (alt && typeof alt.getBoundingClientRect === 'function') el = alt;
                            }
                        } catch (_) {}

                        if (el && typeof el.getBoundingClientRect === 'function') {
                            try {
                                el.scrollIntoView({ block: 'center', inline: 'center' });
                            } catch (_) {}
                            const r = el.getBoundingClientRect();
                            const dpr = win.devicePixelRatio || 1;
                            if (r.width > 2 && r.height > 2) {
                                return {
                                    ok: true,
                                    cx: r.left + r.width / 2,
                                    cy: r.top + r.height / 2,
                                    dpr,
                                };
                            }
                        }

                        let kids = [];
                        try {
                            kids = Array.from(root.querySelectorAll('*'));
                        } catch (_) {
                            kids = [];
                        }

                        for (const node of kids) {
                            if (node.shadowRoot)
                                frontier.push({ root: node.shadowRoot, win });
                            try {
                                const tg = node.tagName;
                                if (
                                    tg === 'IFRAME'
                                    || tg === 'FRAME'
                                    || tg === 'OBJECT'
                                ) {
                                    const doc = node.contentDocument;
                                    const w = node.contentWindow;
                                    if (doc && w) frontier.push({ root: doc, win: w });
                                }
                            } catch (_) {}
                        }
                    }
                    return { ok: false, cx: 0, cy: 0, dpr: 1 };
                }
                """
            ),
            timeout=12.0,
        )
    except Exception:
        return {"clicked": False}

    if not isinstance(pos, dict) or not pos.get("ok"):
        return {"clicked": False}

    dpr = max(float(pos.get("dpr") or 1.0), 0.75)

    scaled_variants = [
        (float(pos["cx"]), float(pos["cy"])),
        (float(pos["cx"]) / dpr, float(pos["cy"]) / dpr),
    ]

    label = str(report_id or "").strip()

    try:
        btn = inp.MouseButton("left")
    except Exception:
        return {"clicked": False}

    try:
        for attempt, (x_v, y_v) in enumerate(scaled_variants, start=1):
            try:
                await asyncio.wait_for(
                    page.send(
                        inp.dispatch_mouse_event(
                            type_="mouseMoved",
                            x=x_v,
                            y=y_v,
                            button=None,
                            buttons=0,
                            modifiers=0,
                        ),
                    ),
                    timeout=6.0,
                )
                await page.sleep(0.06)
                await asyncio.wait_for(
                    page.send(
                        inp.dispatch_mouse_event(
                            type_="mousePressed",
                            x=x_v,
                            y=y_v,
                            button=btn,
                            buttons=1,
                            modifiers=0,
                            click_count=1,
                        ),
                    ),
                    timeout=6.0,
                )
                await page.sleep(0.05)
                await asyncio.wait_for(
                    page.send(
                        inp.dispatch_mouse_event(
                            type_="mouseReleased",
                            x=x_v,
                            y=y_v,
                            button=btn,
                            buttons=0,
                            modifiers=0,
                            click_count=1,
                        ),
                    ),
                    timeout=6.0,
                )
            except Exception:
                continue

            print(
                f"[PY] RegistrationCertificateDownloader: PDF download CDP viewport click ({attempt}) "
                f"for report {label or '(unknown)'}",
                file=sys.stderr,
                flush=True,
            )
            await page.sleep(0.12)

            return {
                "clicked": True,
                "via": "cdp-mouse",
                "x": x_v,
                "y": y_v,
                "dpr_attempt": attempt,
            }
    except Exception:
        return {"clicked": False}

    return {"clicked": False}


def _cdp_resource_type_label(event) -> str:
    rt = getattr(event, "type_", None)
    return getattr(rt, "name", "") or str(rt or "").split(".")[-1]


def _registration_cdp_row_might_yield_pdf(row: dict) -> bool:
    status = int(row.get("status") or 0)
    if status >= 400:
        return False

    mime = (row.get("mime") or "").lower()
    url = (row.get("url") or "").split("?", 1)[0].lower()
    rtype = (row.get("rtype") or "").upper()

    if "application/pdf" in mime or mime.strip().startswith("pdf"):
        return True
    if ".pdf" in url or url.endswith("/pdf") or "/pdf/" in url:
        return True
    if "octet-stream" in mime:
        return True

    taqeem = "taqeem.gov.sa" in url
    if taqeem and rtype in ("XHR", "FETCH"):
        if mime and any(
            hint in mime
            for hint in (
                "json",
                "html",
                "javascript",
                "jpeg",
                "png",
                "svg",
                "webp",
                "font",
                "wasm",
            )
        ):
            return False

        return True

    registrationish = "/registration" in url
    if registrationish:
        return rtype.endswith("DOCUMENT") or rtype == "DOCUMENT"

    return False


def _registration_cdp_row_relaxed_pdf_body_candidate(row: dict) -> bool:
    """Re-fetch bodies for Taqeem /registration URLs; MIME is often wrong when PDF is handled by the viewer."""
    status = int(row.get("status") or 0)
    if status not in (200, 206):
        return False
    url = (row.get("url") or "").lower()
    if "taqeem.gov.sa" not in url or "/registration" not in url:
        return False
    rtype = (row.get("rtype") or "").upper()
    if rtype in (
        "STYLESHEET",
        "SCRIPT",
        "IMAGE",
        "FONT",
        "MEDIA",
        "WEBSOCKET",
        "EVENTSOURCE",
        "MANIFEST",
    ):
        return False
    mime = (row.get("mime") or "").lower()
    if mime and any(
        h in mime
        for h in (
            "image/",
            "text/css",
            "javascript",
            "font",
            "video/",
            "audio/",
        )
    ):
        return False
    return True


def _decode_cdp_response_body(payload) -> bytes:
    if isinstance(payload, (list, tuple)) and len(payload) >= 2:
        body_raw, encoded = payload[0], payload[1]
    else:
        return b""
    if not isinstance(body_raw, str):
        body_raw = str(body_raw or "")
    if encoded:
        return base64.b64decode(body_raw)

    try:
        return body_raw.encode("latin-1")
    except Exception:
        return body_raw.encode("utf-8", errors="replace")


async def _ensure_registration_pdf_cdp_sniffer(page) -> None:
    if getattr(page, "_vt_registration_pdf_cdp_sniffer", False):
        return

    from nodriver import cdp

    async def _on_resp(ev):
        mon = globals()["_REGISTRATION_PDF_CDP_MONITOR"]
        if not mon:
            return
        try:
            rsp = getattr(ev, "response", None)
            if rsp is None:
                return
            mime = getattr(rsp, "mime_type", "") or ""
            rows = mon.setdefault("rows", [])
            rows.append(
                {
                    "request_id": ev.request_id,
                    "url": getattr(rsp, "url", "") or "",
                    "mime": mime or "",
                    "status": int(getattr(rsp, "status", 0) or 0),
                    "rtype": _cdp_resource_type_label(ev),
                    "ts": time.time(),
                }
            )
            if len(rows) > 500:
                del rows[:-400]
        except Exception:
            return

    async def _on_load(ev):
        mon = globals()["_REGISTRATION_PDF_CDP_MONITOR"]
        if not mon:
            return
        try:
            mon.setdefault("finished", set()).add(ev.request_id)
        except Exception:
            return

    if hasattr(page, "add_handler"):
        page.add_handler(cdp.network.ResponseReceived, _on_resp)
        page.add_handler(cdp.network.LoadingFinished, _on_load)

    setattr(page, "_vt_registration_pdf_cdp_sniffer", True)


async def _registration_pdf_cdp_arm_monitor() -> dict:
    st = {"rows": [], "finished": set()}

    globals()["_REGISTRATION_PDF_CDP_MONITOR"] = st

    return st


def _registration_pdf_cdp_disarm_monitor():

    globals()["_REGISTRATION_PDF_CDP_MONITOR"] = None


async def _poll_registration_pdf_via_cdp(page, deadline_monotonic: float, attempted_rids) -> bytes | None:
    from nodriver import cdp

    ordered = []

    while time.monotonic() < deadline_monotonic:

        mon = globals()["_REGISTRATION_PDF_CDP_MONITOR"]

        if mon is None:
            break

        finished_set = mon.get("finished") or set()
        rows = list(mon.get("rows") or [])

        ordered = sorted(rows, key=lambda r: float(r.get("ts") or 0.0), reverse=True)

        for row in ordered:
            rid = row.get("request_id")

            if rid is None:
                continue
            if rid not in finished_set:
                continue

            rk = getattr(rid, "to_json", None)
            rk = rk() if callable(rk) else str(rid)
            if rk in attempted_rids:
                continue
            if not (
                _registration_cdp_row_might_yield_pdf(row)
                or _registration_cdp_row_relaxed_pdf_body_candidate(row)
            ):
                continue

            attempted_rids.add(rk)

            try:
                tup = await asyncio.wait_for(
                    page.send(cdp.network.get_response_body(request_id=rid)),
                    timeout=22.0,
                )
                raw = _decode_cdp_response_body(tup)
            except Exception:
                continue

            head = raw[:16].lstrip()
            if head.startswith(b"%PDF"):
                print(
                    f"[PY] RegistrationCertificateDownloader: CDP intercepted PDF ({len(raw)} bytes) "
                    f"status={row.get('status')} mime={row.get('mime')} rtype={row.get('rtype')}",
                    file=sys.stderr,
                    flush=True,
                )
                return raw

        await asyncio.sleep(0.22)

    return None


async def capture_registration_pdf_via_network_cdp(
    page,
    registration_url: str,
    download_path: str,
    preferred_name: str,
    report_id: str,
    sniff_seconds: float = 52.0,
    nav_timeout: float = 45.0,
) -> str | None:
    """Intercept PDF bytes from Taqeem XHR/nav responses via Chrome DevTools Network (no UI click)."""

    target = (registration_url or "").strip()
    if not target:
        return None

    if not getattr(page, "send", None) or not hasattr(page, "add_handler"):
        return None

    import nodriver as uc

    async with _REGISTRATION_PDF_CDP_SNIF_LOCK:
        attempted = set()

        await _ensure_registration_pdf_cdp_sniffer(page)

        try:
            await page.send(uc.cdp.network.enable())
        except Exception:
            pass

        await _registration_pdf_cdp_arm_monitor()

        out_path = None

        try:
            await navigate_with_timeout(page, target, "registration certificate (CDP sniff)", timeout=nav_timeout)

            sniff_deadline = time.monotonic() + max(12.0, float(sniff_seconds))

            blob = await _poll_registration_pdf_via_cdp(page, sniff_deadline, attempted)

            if blob is None:
                await asyncio.sleep(1.4)
                sniff_deadline = time.monotonic() + max(8.0, float(sniff_seconds) * 0.42)
                blob = await _poll_registration_pdf_via_cdp(page, sniff_deadline, attempted)

            if not blob:

                return None

            file_name = build_certificate_filename(preferred_name, report_id)

            os.makedirs(download_path, exist_ok=True)

            dest = ensure_unique_path(os.path.join(download_path, file_name))

            with open(dest, "wb") as fh:
                fh.write(blob)

            print(
                "[PY] RegistrationCertificateDownloader: saved registration PDF "
                f"via CDP network sniff for report {report_id}: {dest}",
                file=sys.stderr,

                flush=True,
            )

            out_path = dest

        finally:
            _registration_pdf_cdp_disarm_monitor()

        return out_path


NON_PDF_RESOURCE_SUFFIXES = (
    ".css",
    ".js",
    ".mjs",
    ".map",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
)


def _strip_fragment(url: str) -> str:
    return (url or "").strip().split("#", 1)[0]


def _decode_data_pdf_url(value: str) -> bytes | None:
    raw = (value or "").strip()
    if not raw.lower().startswith("data:application/pdf") or "," not in raw:
        return None
    header, payload = raw.split(",", 1)
    if ";base64" in header.lower():
        return base64.b64decode(payload)
    return unquote(payload).encode("latin-1", errors="replace")


def _extract_url_parameter_candidates(value: str) -> list[str]:
    raw = html_lib.unescape(str(value or "").strip())
    if not raw:
        return []

    out = []
    decoded = unquote(raw)
    if decoded != raw:
        out.append(decoded)

    for key in ("src", "url", "file", "href"):
        pattern = rf"(?:[?&#]|&amp;){key}=([^&#\"'<>]+)"
        for match in re.finditer(pattern, raw, flags=re.IGNORECASE):
            candidate = unquote(html_lib.unescape(match.group(1))).strip()
            if candidate:
                out.append(candidate)
    return out


def _normalize_pdf_candidate_url(value: str) -> str:
    raw = html_lib.unescape(str(value or "").strip().strip("\"'"))
    if not raw:
        return ""

    lowered = raw.lower()
    if lowered.startswith("data:application/pdf") or lowered.startswith("blob:"):
        return raw
    if lowered.startswith("chrome-extension://"):
        return ""

    if raw.startswith(("http://", "https://", "/", "./", "../")) or ":" not in raw[:12]:
        resolved = absolutize_taqeem_href(raw)
    else:
        return ""

    resolved = _strip_fragment(resolved)
    if not resolved:
        return ""

    lowered = resolved.lower()
    if not lowered.startswith(("http://", "https://")):
        return ""
    if "taqeem.gov.sa" not in lowered:
        return ""
    return resolved


def _pdf_candidate_score(url: str, registration_url: str) -> int:
    lowered = (url or "").lower()
    if not lowered:
        return -10000

    if lowered.startswith("data:application/pdf"):
        return 1000
    if lowered.startswith("blob:"):
        return 950

    clean_path = lowered.split("?", 1)[0]
    if clean_path.endswith(NON_PDF_RESOURCE_SUFFIXES) and not clean_path.endswith(".pdf"):
        return -10000

    score = 0
    if ".pdf" in clean_path or clean_path.endswith("/pdf") or "/pdf/" in clean_path:
        score += 240
    if "download" in lowered:
        score += 220
    if "export" in lowered:
        score += 140
    if "print" in lowered:
        score += 90
    if "registration" in lowered:
        score += 70
    if "certificate" in lowered:
        score += 70
    if "/report/" in lowered:
        score += 40
    if _strip_fragment(lowered).rstrip("/") == _strip_fragment(registration_url.lower()).rstrip("/"):
        score -= 35
    return score


def _add_pdf_candidate(out: list[str], seen: set[str], value: str) -> None:
    raw_values = [value]
    raw_values.extend(_extract_url_parameter_candidates(value))

    for raw in raw_values:
        normalized = _normalize_pdf_candidate_url(raw)
        if not normalized:
            continue
        key = normalized if normalized.lower().startswith(("blob:", "data:")) else normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(normalized)


def _build_registration_pdf_endpoint_guesses(registration_url: str) -> list[str]:
    target = _normalize_pdf_candidate_url(registration_url)
    if not target:
        return []

    base = _strip_fragment(target).rstrip("/")
    path = base.split("?", 1)[0].rstrip("/")
    out = []
    seen = set()

    def add(value: str):
        _add_pdf_candidate(out, seen, value)

    add(base)

    for query in (
        "download=1",
        "download=true",
        "format=pdf",
        "pdf=1",
        "print=1",
        "export=pdf",
    ):
        sep = "&" if "?" in base else "?"
        add(f"{base}{sep}{query}")

    if path.lower().endswith("/registration"):
        report_root = path[: -len("/registration")]
        for suffix in (
            "/download",
            "/pdf",
            "/print",
            "/export",
            "/download/pdf",
        ):
            add(f"{path}{suffix}")
        for suffix in (
            "/registration/download",
            "/registration/pdf",
            "/registration/print",
            "/certificate",
            "/certificate/pdf",
            "/pdf",
        ):
            add(f"{report_root}{suffix}")

    return out


async def collect_certificate_page_candidate_urls(page) -> list[str]:
    try:
        result = await asyncio.wait_for(
            page.evaluate(
                r"""
                () => {
                    const out = new Set();
                    const hintRe = /(pdf|download|registration|certificate|\/report\/)/i;
                    const urlRe = /(https?:\/\/[^\s"'<>\\)]+|\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+)/g;

                    const clean = (value) =>
                        String(value || '')
                            .replace(/&amp;/g, '&')
                            .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
                            .trim();

                    const add = (value) => {
                        const text = clean(value);
                        if (!text) return;
                        if (hintRe.test(text)) out.add(text);
                        let match;
                        urlRe.lastIndex = 0;
                        while ((match = urlRe.exec(text))) {
                            const item = clean(match[1]);
                            if (item && hintRe.test(item)) out.add(item);
                        }
                    };

                    add(window.location.href || '');
                    add(document.title || '');

                    const roots = [];
                    const seen = new Set();
                    const pushRoot = (root) => {
                        if (!root || seen.has(root)) return;
                        seen.add(root);
                        roots.push(root);
                    };

                    pushRoot(document);
                    for (let i = 0; i < roots.length; i += 1) {
                        const root = roots[i];
                        let nodes = [];
                        try {
                            nodes = Array.from(root.querySelectorAll('*'));
                        } catch (_) {
                            nodes = [];
                        }

                        for (const node of nodes) {
                            try {
                                if (node.shadowRoot) pushRoot(node.shadowRoot);
                            } catch (_) {}
                            try {
                                if (
                                    (node.tagName === 'IFRAME'
                                        || node.tagName === 'FRAME'
                                        || node.tagName === 'OBJECT')
                                    && node.contentDocument
                                ) {
                                    pushRoot(node.contentDocument);
                                }
                            } catch (_) {}

                            try {
                                for (const attrName of node.getAttributeNames()) {
                                    const lower = attrName.toLowerCase();
                                    if (
                                        lower.includes('href')
                                        || lower.includes('src')
                                        || lower.includes('url')
                                        || lower.includes('pdf')
                                        || lower.includes('download')
                                        || lower.includes('action')
                                        || lower.includes('router')
                                        || lower === 'onclick'
                                        || lower === 'data'
                                    ) {
                                        add(node.getAttribute(attrName));
                                    }
                                }
                            } catch (_) {}

                            try {
                                const ds = node.dataset || {};
                                for (const key of Object.keys(ds)) add(ds[key]);
                            } catch (_) {}
                        }

                        try {
                            const html = root.documentElement
                                ? root.documentElement.outerHTML
                                : root.innerHTML || '';
                            add(String(html).slice(0, 450000));
                        } catch (_) {}
                    }

                    try {
                        const entries = performance.getEntriesByType('resource') || [];
                        for (const entry of entries) add(entry.name || '');
                    } catch (_) {}

                    return Array.from(out).slice(0, 700);
                }
                """
            ),
            timeout=14.0,
        )
    except Exception:
        return []

    if not isinstance(result, list):
        return []
    return [str(item) for item in result if item]


async def try_download_pdf_candidates_from_open_certificate_page(
    page,
    registration_url: str,
    download_path: str,
    preferred_name: str,
    report_id: str,
) -> str | None:
    candidates = []
    seen = set()

    for item in _build_registration_pdf_endpoint_guesses(registration_url):
        _add_pdf_candidate(candidates, seen, item)

    for item in await collect_certificate_page_candidate_urls(page):
        _add_pdf_candidate(candidates, seen, item)

    ranked = [
        (_pdf_candidate_score(candidate, registration_url), idx, candidate)
        for idx, candidate in enumerate(candidates)
    ]
    ranked = [item for item in ranked if item[0] > -10000]
    ranked.sort(key=lambda item: (-item[0], item[1]))

    last_error = ""
    for _, _, candidate in ranked[:10]:
        try:
            data_pdf = _decode_data_pdf_url(candidate)
            if data_pdf:
                return save_certificate_pdf_bytes(
                    data_pdf,
                    download_path,
                    preferred_name,
                    report_id,
                    "certificate-page data URL",
                )

            target_path = await download_pdf_via_page_fetch(
                page,
                candidate,
                download_path,
                preferred_name,
                report_id,
                timeout=8.0,
            )
            print(
                "[PY] RegistrationCertificateDownloader: certificate-page candidate "
                f"PDF URL succeeded for report {report_id}: {candidate}",
                file=sys.stderr,
                flush=True,
            )
            return target_path
        except Exception as err:
            last_error = format_error(err)

    if ranked:
        print(
            "[PY] RegistrationCertificateDownloader: certificate-page PDF URL candidates "
            f"did not yield a PDF for report {report_id}"
            + (f"; last error: {last_error}" if last_error else ""),
            file=sys.stderr,
            flush=True,
        )

    return None


async def inspect_open_certificate_page(page) -> dict:
    cert_terms = [
        repair_mojibake(AR_CERTIFICATE_TEXT),
        repair_mojibake(AR_CERTIFICATE_TEXT_SHORT),
        EN_CERTIFICATE_TEXT,
        "certificate",
        "registration",
        "taqeem",
        "qima",
    ]
    login_terms = [
        "login",
        "sign in",
        "username",
        "password",
        "تسجيل الدخول",
        "اسم المستخدم",
        "كلمة المرور",
    ]
    cert_terms_json = json.dumps(cert_terms)
    login_terms_json = json.dumps(login_terms)

    try:
        result = await asyncio.wait_for(
            page.evaluate(
                f"""
                () => {{
                    const certTerms = {cert_terms_json}.map((v) => String(v || '').toLowerCase());
                    const loginTerms = {login_terms_json}.map((v) => String(v || '').toLowerCase());
                    const normalize = (value) => String(value || '')
                        .replace(/[\\u00a0]/g, ' ')
                        .replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '')
                        .replace(/\\s+/g, ' ')
                        .trim();
                    const text = normalize(document.body?.innerText || '');
                    const lowerText = text.toLowerCase();
                    const url = String(window.location.href || '');
                    const title = normalize(document.title || '');
                    const haystack = `${{lowerText}} ${{url.toLowerCase()}} ${{title.toLowerCase()}}`;

                    let pdfish = false;
                    let mediaCount = 0;
                    const pathLower = String(window.location.pathname || '').toLowerCase();
                    if (pathLower.includes('/registration')) {{
                        pdfish = true;
                    }}
                    try {{
                        const html0 =
                            document.documentElement && document.documentElement.innerHTML
                                ? String(document.documentElement.innerHTML)
                                : '';
                        if (
                            html0.includes('google-chrome-pdf')
                            || html0.includes('original-url=')
                            || html0.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai')
                        ) {{
                            pdfish = true;
                        }}
                    }} catch (_) {{}}
                    const roots = [document];
                    const seen = new Set();
                    for (let i = 0; i < roots.length; i += 1) {{
                        const root = roots[i];
                        if (!root || seen.has(root)) continue;
                        seen.add(root);
                        try {{
                            if (
                                root.querySelector(
                                    'embed, embed[type*="pdf" i], embed[type*="chrome-pdf" i], '
                                    + 'embed[type*="google-chrome-pdf" i], '
                                    + 'object[type*="pdf" i], iframe[src*=".pdf" i], '
                                    + 'pdf-viewer, viewer-toolbar, cr-icon-button#download, '
                                    + 'canvas, svg, img'
                                )
                            ) {{
                                pdfish = true;
                            }}
                        }} catch (_) {{}}
                        let nodes = [];
                        try {{
                            nodes = Array.from(root.querySelectorAll('*'));
                        }} catch (_) {{
                            nodes = [];
                        }}
                        for (const node of nodes) {{
                            try {{
                                const tag = String(node.tagName || '').toLowerCase();
                                if (['canvas', 'svg', 'img', 'embed', 'object', 'iframe'].includes(tag)) {{
                                    mediaCount += 1;
                                }}
                                if (node.shadowRoot) roots.push(node.shadowRoot);
                            }} catch (_) {{}}
                            try {{
                                if (
                                    (node.tagName === 'IFRAME'
                                        || node.tagName === 'FRAME'
                                        || node.tagName === 'OBJECT')
                                    && node.contentDocument
                                ) {{
                                    roots.push(node.contentDocument);
                                }}
                            }} catch (_) {{}}
                        }}
                    }}

                    const certish = certTerms.some((term) => term && haystack.includes(term));
                    const loginish = loginTerms.some((term) => term && haystack.includes(term));
                    return {{
                        readyState: document.readyState || '',
                        url,
                        title,
                        textLength: text.length,
                        certish,
                        loginish,
                        pdfish,
                        mediaCount,
                    }};
                }}
                """
            ),
            timeout=10.0,
        )
    except Exception as err:
        return {"error": format_error(err)}

    return result if isinstance(result, dict) else {}


async def wait_for_open_certificate_page_render(page, timeout: float = 16.0) -> dict:
    deadline = time.time() + max(2.0, timeout)
    last = {}
    while time.time() < deadline:
        last = await inspect_open_certificate_page(page)
        if last.get("loginish") and not last.get("certish"):
            raise RuntimeError("Certificate page is showing login/authentication content")
        if (
            last.get("readyState") in ("interactive", "complete")
            and (
                last.get("certish")
                or last.get("pdfish")
                or int(last.get("mediaCount") or 0) > 0
                or int(last.get("textLength") or 0) > 120
            )
        ):
            return last
        await page.sleep(0.35)
    return last


async def prepare_open_certificate_page_for_print(page) -> None:
    try:
        await asyncio.wait_for(
            page.evaluate(
                r"""
                () => {
                    const styleId = 'valuetech-certificate-print-style';
                    let style = document.getElementById(styleId);
                    if (!style) {
                        style = document.createElement('style');
                        style.id = styleId;
                        (document.head || document.documentElement).appendChild(style);
                    }
                    style.textContent = `
                        @page { margin: 0; }
                        @media print {
                            html, body {
                                background: #fff !important;
                                -webkit-print-color-adjust: exact !important;
                                print-color-adjust: exact !important;
                            }
                            nav, header, footer, aside,
                            .navbar, .sidebar, .breadcrumb, .toolbar,
                            viewer-toolbar, cr-toolbar, pdf-toolbar,
                            #toolbar, #toolbarContainer, #secondaryToolbar,
                            #sidebarContainer, #download, #downloads,
                            #print, #print-button,
                            button, [role="button"] {
                                display: none !important;
                            }
                            canvas, img, svg, embed, object, iframe {
                                break-inside: avoid;
                            }
                        }
                    `;

                    try {
                        window.scrollTo(0, document.body?.scrollHeight || 0);
                    } catch (_) {}
                    try {
                        const nodes = Array.from(document.querySelectorAll('*'));
                        for (const node of nodes) {
                            if (
                                node.scrollHeight
                                && node.clientHeight
                                && node.scrollHeight > node.clientHeight + 20
                            ) {
                                node.scrollTop = node.scrollHeight;
                            }
                        }
                    } catch (_) {}
                    return true;
                }
                """
            ),
            timeout=8.0,
        )
    except Exception:
        pass

    await page.sleep(0.35)

    try:
        await asyncio.wait_for(
            page.evaluate(
                """
                () => {
                    try { window.scrollTo(0, 0); } catch (_) {}
                    try {
                        const nodes = Array.from(document.querySelectorAll('*'));
                        for (const node of nodes) {
                            if (node.scrollTop) node.scrollTop = 0;
                        }
                    } catch (_) {}
                    return true;
                }
                """
            ),
            timeout=6.0,
        )
    except Exception:
        pass

    await page.sleep(0.2)


async def _read_cdp_stream_bytes(page, stream_handle) -> bytes:
    import nodriver as uc

    if isinstance(stream_handle, str):
        stream_handle = uc.cdp.io.StreamHandle(stream_handle)

    chunks = []
    try:
        while True:
            encoded, data, eof = await asyncio.wait_for(
                page.send(uc.cdp.io.read(handle=stream_handle, size=1024 * 512)),
                timeout=18.0,
            )
            if data:
                if encoded:
                    chunks.append(base64.b64decode(data))
                else:
                    chunks.append(str(data).encode("latin-1", errors="replace"))
            if eof:
                break
    finally:
        try:
            await asyncio.wait_for(
                page.send(uc.cdp.io.close(handle=stream_handle)),
                timeout=8.0,
            )
        except Exception:
            pass

    return b"".join(chunks)


async def _decode_print_to_pdf_payload(page, payload) -> bytes:
    data = ""
    stream = None
    if isinstance(payload, dict):
        data = payload.get("data") or ""
        stream = payload.get("stream")
    elif isinstance(payload, (list, tuple)):
        data = payload[0] if len(payload) > 0 else ""
        stream = payload[1] if len(payload) > 1 else None
    elif isinstance(payload, str):
        data = payload

    if data:
        return base64.b64decode(str(data))
    if stream:
        return await _read_cdp_stream_bytes(page, stream)
    return b""


async def print_open_certificate_page_to_pdf(
    page,
    download_path: str,
    preferred_name: str,
    report_id: str,
) -> str:
    if not getattr(page, "send", None):
        raise RuntimeError("Chrome DevTools print API is not available on this page")

    import nodriver as uc

    diag = await wait_for_open_certificate_page_render(page, timeout=18.0)
    if diag.get("loginish") and not diag.get("certish"):
        raise RuntimeError("Certificate page is not authenticated")
    if not (
        diag.get("certish")
        or diag.get("pdfish")
        or int(diag.get("mediaCount") or 0) > 0
        or int(diag.get("textLength") or 0) > 120
    ):
        raise RuntimeError("Certificate page did not render printable content")

    await prepare_open_certificate_page_for_print(page)

    try:
        await page.send(uc.cdp.emulation.set_emulated_media(media="print"))
    except Exception:
        pass

    common_args = {
        "landscape": False,
        "display_header_footer": False,
        "print_background": True,
        "scale": 1.0,
        "paper_width": 8.27,
        "paper_height": 11.69,
        "margin_top": 0,
        "margin_bottom": 0,
        "margin_left": 0,
        "margin_right": 0,
        "prefer_css_page_size": True,
    }

    last_error = ""
    for transfer_mode in ("ReturnAsStream", None):
        try:
            args = dict(common_args)
            if transfer_mode:
                args["transfer_mode"] = transfer_mode
            payload = await asyncio.wait_for(
                page.send(uc.cdp.page.print_to_pdf(**args)),
                timeout=60.0,
            )
            data = await _decode_print_to_pdf_payload(page, payload)
            return save_certificate_pdf_bytes(
                data,
                download_path,
                preferred_name,
                report_id,
                "browser print-to-PDF",
            )
        except Exception as err:
            last_error = format_error(err)

    raise RuntimeError(f"Browser print-to-PDF failed: {last_error}")


async def print_certificate_page_with_headless_browser(
    browser,
    registration_url: str,
    download_path: str,
    preferred_name: str,
    report_id: str,
) -> str:
    if not browser:
        raise RuntimeError("No browser session is available for headless print fallback")
    if not registration_url:
        raise RuntimeError("Missing registration URL for headless print fallback")

    headless_browser = None
    try:
        print(
            "[PY] RegistrationCertificateDownloader: opening headless print fallback "
            f"for report {report_id}",
            file=sys.stderr,
            flush=True,
        )
        headless_browser = await asyncio.wait_for(
            spawn_new_browser(browser, headless=True),
            timeout=45.0,
        )
        headless_page = await asyncio.wait_for(
            headless_browser.get("about:blank"),
            timeout=25.0,
        )
        await navigate_with_timeout(
            headless_page,
            registration_url,
            f"registration certificate headless print {report_id}",
            timeout=50.0,
        )
        await page_sleep_safely(headless_page, 0.8)

        return await print_open_certificate_page_to_pdf(
            headless_page,
            download_path,
            preferred_name,
            report_id,
        )
    finally:
        if headless_browser:
            try:
                headless_browser.stop()
            except Exception:
                pass


async def page_sleep_safely(page, seconds: float) -> None:
    try:
        await page.sleep(seconds)
    except Exception:
        await asyncio.sleep(seconds)


async def save_open_certificate_page_without_download_click(
    page,
    registration_url: str,
    download_path: str,
    preferred_name: str,
    report_id: str,
    browser=None,
) -> str:
    candidate_path = None
    try:
        candidate_path = await try_download_pdf_candidates_from_open_certificate_page(
            page,
            registration_url,
            download_path,
            preferred_name,
            report_id,
        )
    except Exception as err:
        print(
            "[PY] RegistrationCertificateDownloader: certificate-page PDF candidate scan "
            f"failed for report {report_id}: {format_error(err)}",
            file=sys.stderr,
            flush=True,
        )

    if candidate_path:
        return candidate_path

    print(
        "[PY] RegistrationCertificateDownloader: saving open certificate page "
        f"with browser print-to-PDF for report {report_id}",
        file=sys.stderr,
        flush=True,
    )
    try:
        return await print_open_certificate_page_to_pdf(
            page,
            download_path,
            preferred_name,
            report_id,
        )
    except Exception as print_error:
        if not browser:
            raise
        try:
            print(
                "[PY] RegistrationCertificateDownloader: visible-browser print-to-PDF "
                f"failed for report {report_id}: {format_error(print_error)}; "
                "trying headless print fallback.",
                file=sys.stderr,
                flush=True,
            )
            return await print_certificate_page_with_headless_browser(
                browser,
                registration_url,
                download_path,
                preferred_name,
                report_id,
            )
        except Exception as headless_error:
            raise RuntimeError(
                f"visible print: {format_error(print_error)}; "
                f"headless print: {format_error(headless_error)}"
            ) from headless_error


async def download_pdf_through_viewer(
    page,
    registration_url: str,
    download_path: str,
    preferred_name: str,
    report_id: str,
    browser=None,
) -> str:
    temp_dir = make_temp_download_dir(download_path, report_id)

    sniffed_pdf_path = None
    navigated_inside_sniffer = False
    sniffer_ran = False

    try:
        await configure_download_path(page, temp_dir)

        nav_target = (registration_url or "").strip()
        need_nav = True

        if nav_target:
            try:
                cur = (await page.evaluate("window.location.href || ''") or "").strip()
                c0 = cur.split("#")[0].rstrip("/")
                r0 = nav_target.split("#")[0].rstrip("/")
                need_nav = c0.casefold() != r0.casefold()
            except Exception:
                need_nav = True

        else:
            need_nav = False

        if getattr(page, "send", None) and hasattr(page, "add_handler"):
            import nodriver as uc

            sniffer_ran = True

            async with _REGISTRATION_PDF_CDP_SNIF_LOCK:
                attempted = set()

                await _ensure_registration_pdf_cdp_sniffer(page)

                try:
                    await page.send(uc.cdp.network.enable())
                except Exception:
                    pass

                await _registration_pdf_cdp_arm_monitor()

                try:
                    if need_nav and nav_target:
                        await navigate_with_timeout(
                            page,
                            nav_target,
                            f"registration certificate {report_id}",
                            timeout=45.0,
                        )

                        navigated_inside_sniffer = True

                    else:
                        await page.sleep(0.35)

                    await page.sleep(0.85)

                    try:
                        quick_ctrl = await try_download_certificate_via_viewer_ctrl_s(
                            page,
                            temp_dir,
                            str(report_id),
                            wait_seconds=95.0,
                        )
                        if quick_ctrl:
                            return move_downloaded_certificate(
                                quick_ctrl,
                                download_path,
                                build_certificate_filename(preferred_name, report_id),
                            )
                    except Exception:
                        pass

                    sniff_deadline = time.monotonic() + 30.0

                    blob = await _poll_registration_pdf_via_cdp(page, sniff_deadline, attempted)

                    if blob is None:
                        await asyncio.sleep(1.25)
                        sniff_deadline = time.monotonic() + 14.0
                        blob = await _poll_registration_pdf_via_cdp(page, sniff_deadline, attempted)

                    if blob:
                        file_name = build_certificate_filename(preferred_name, report_id)
                        os.makedirs(download_path, exist_ok=True)
                        sniffed_pdf_path = ensure_unique_path(os.path.join(download_path, file_name))

                        with open(sniffed_pdf_path, "wb") as fh:
                            fh.write(blob)

                        print(
                            "[PY] RegistrationCertificateDownloader: viewer path saved PDF via CDP network "
                            f"for report {report_id}: {sniffed_pdf_path}",
                            file=sys.stderr,
                            flush=True,
                        )

                finally:
                    _registration_pdf_cdp_disarm_monitor()

        if sniffed_pdf_path:
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass

            return sniffed_pdf_path

        if not sniffer_ran:
            if need_nav and nav_target:
                await navigate_with_timeout(
                    page,

                    nav_target,

                    f"registration certificate {report_id}",
                    timeout=45.0,
                )

                navigated_inside_sniffer = True

            await page.sleep(1.0)
            await page.sleep(0.85)

        else:
            if need_nav and (not navigated_inside_sniffer) and nav_target:
                await navigate_with_timeout(
                    page,
                    nav_target,
                    f"registration certificate {report_id}",
                    timeout=45.0,
                )
                navigated_inside_sniffer = True
                await page.sleep(0.85)

            elif not sniffed_pdf_path:

                await page.sleep(0.45)

        auto_download = None

        try:
            auto_download = await wait_for_downloaded_file(temp_dir, timeout=2)

        except Exception:
            auto_download = None

        if not auto_download:
            try:
                await page.sleep(0.35)
                ctrl_path = await try_download_certificate_via_viewer_ctrl_s(
                    page,
                    temp_dir,
                    str(report_id),
                    wait_seconds=52.0,
                )
                if ctrl_path:
                    return move_downloaded_certificate(
                        ctrl_path,
                        download_path,
                        build_certificate_filename(preferred_name, report_id),
                    )
            except Exception as ctrl_err:
                print(
                    "[PY] RegistrationCertificateDownloader: Ctrl+S viewer save "
                    f"failed for report {report_id}: {format_error(ctrl_err)}; "
                    "trying print-to-PDF / toolbar.",
                    file=sys.stderr,
                    flush=True,
                )

            try:
                non_click_path = await save_open_certificate_page_without_download_click(
                    page,
                    registration_url,
                    download_path,
                    preferred_name,
                    report_id,
                    browser=browser,
                )
                if non_click_path:
                    return non_click_path
            except Exception as non_click_error:
                print(
                    "[PY] RegistrationCertificateDownloader: non-click certificate save "
                    f"failed for report {report_id}: {format_error(non_click_error)}; "
                    "trying PDF viewer button.",
                    file=sys.stderr,
                    flush=True,
                )

            await wait_for_pdf_download_button(page, timeout=22)

            click_result = await click_pdf_viewer_download(page, timeout=45, report_id=str(report_id))

            if not click_result.get("clicked"):
                raise RuntimeError(click_result.get("error") or "PDF download button not found")

            print(
                f"[PY] RegistrationCertificateDownloader: clicked PDF viewer download for report {report_id}: {click_result}",
                file=sys.stderr,
                flush=True,
            )

            auto_download = await wait_for_downloaded_file(temp_dir, timeout=60)

        return move_downloaded_certificate(
            auto_download,

            download_path,

            build_certificate_filename(preferred_name, report_id),
        )

    finally:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)

        except Exception:

            pass


def _cookie_value(cookie, attr):
    if hasattr(cookie, attr):
        return getattr(cookie, attr)
    if isinstance(cookie, dict):
        return cookie.get(attr)
    return None


def build_cookie_header(cookies):
    pairs = []
    for cookie in cookies:
        name = _cookie_value(cookie, "name")
        value = _cookie_value(cookie, "value")
        domain = _cookie_value(cookie, "domain") or ""
        if not name:
            continue
        if domain and "taqeem.gov.sa" not in domain:
            continue
        pairs.append(f"{name}={value}")
    return "; ".join(pairs)


async def get_taqeem_cookie_header(browser, page, report_id):
    import nodriver as uc

    url_candidates = [
        "https://qima.taqeem.gov.sa/",
        "https://qima.taqeem.gov.sa",
        "https://sso.taqeem.gov.sa/",
        "https://sso.taqeem.gov.sa",
    ]
    try:
        cur = await asyncio.wait_for(
            page.evaluate("window.location.href || ''"),
            timeout=4.0,
        )
        if isinstance(cur, str) and cur.strip().startswith("http"):
            cand = cur.strip().split("#")[0]
            if cand not in url_candidates:
                url_candidates.insert(0, cand)
    except Exception:
        pass

    dedup_urls = list(dict.fromkeys(url_candidates))

    if getattr(page, "send", None):
        try:
            cdp_cookies = await asyncio.wait_for(
                page.send(uc.cdp.network.get_cookies(urls=dedup_urls)),
                timeout=18.0,
            )
            pairs = []
            for c in cdp_cookies or []:
                dom = (getattr(c, "domain", None) or "").lower()
                if dom and "taqeem.gov.sa" not in dom:
                    continue
                name = getattr(c, "name", None) or ""
                value = getattr(c, "value", None) or ""
                if name:
                    pairs.append(f"{name}={value}")
            if pairs:
                print(
                    f"[PY] RegistrationCertificateDownloader: using CDP Network.getCookies "
                    f"for report {report_id} ({len(pairs)} cookie(s))",
                    file=sys.stderr,
                    flush=True,
                )
                return "; ".join(pairs)
        except Exception as err:
            print(
                "[PY] RegistrationCertificateDownloader: CDP cookie lookup failed "
                f"for report {report_id}: {type(err).__name__}: {format_error(err)}",
                file=sys.stderr,
                flush=True,
            )

    for attempt, secs in enumerate((6.5, 5.0), start=1):
        try:
            cookies = await asyncio.wait_for(browser.cookies.get_all(), timeout=secs)
            cookie_header = build_cookie_header(cookies)
            if cookie_header:
                return cookie_header
            print(
                f"[PY] RegistrationCertificateDownloader: browser cookie jar returned no Taqeem cookies "
                f"for report {report_id}",
                file=sys.stderr,
                flush=True,
            )
            break
        except Exception as err:
            note = ""
            if attempt < 2 and type(err).__name__ in ("TimeoutError", "CancelledError"):
                note = "; retrying with shorter stall"
                print(
                    "[PY] RegistrationCertificateDownloader: browser cookie lookup attempt "
                    f"{attempt} failed for report {report_id}: "
                    f"{type(err).__name__}: {format_error(err)}{note}",
                    file=sys.stderr,
                    flush=True,
                )
                await asyncio.sleep(0.15)
                continue
            print(
                "[PY] RegistrationCertificateDownloader: browser cookie lookup failed "
                f"for report {report_id}: {type(err).__name__}: {format_error(err)}",
                file=sys.stderr,
                flush=True,
            )
            break

    try:
        document_cookie = await asyncio.wait_for(
            page.evaluate("document.cookie || ''"),
            timeout=5.0,
        )
        if document_cookie:
            print(
                f"[PY] RegistrationCertificateDownloader: using document.cookie fallback for report {report_id}",
                file=sys.stderr,
                flush=True,
            )
            return str(document_cookie)
    except Exception as err:
        print(
            "[PY] RegistrationCertificateDownloader: document.cookie fallback failed "
            f"for report {report_id}: {type(err).__name__}: {format_error(err)}",
            file=sys.stderr,
            flush=True,
        )

    return ""


def _parse_content_disposition_filename(value: str) -> str:
    if not value:
        return ""
    parts = [part.strip() for part in value.split(";") if part.strip()]
    filename_star = ""
    filename = ""
    for part in parts:
        lowered = part.lower()
        if lowered.startswith("filename*="):
            filename_star = part.split("=", 1)[1].strip()
        elif lowered.startswith("filename="):
            filename = part.split("=", 1)[1].strip()
    if filename_star:
        cleaned = filename_star.strip("\"'")
        if "''" in cleaned:
            _, cleaned = cleaned.split("''", 1)
        return unquote(cleaned)
    if filename:
        return filename.strip("\"'")
    return ""


def download_pdf_with_cookies(url, dest_dir, preferred_name, cookie_header, headers=None, timeout=60):
    import urllib.request

    request_headers = headers.copy() if headers else {}
    if cookie_header:
        request_headers["Cookie"] = cookie_header

    req = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        status = getattr(resp, "status", None) or resp.getcode()
        if status and status >= 400:
            raise RuntimeError(f"Download failed with status {status}")
        content_type = (resp.headers.get("Content-Type", "") or "").lower()
        disposition = resp.headers.get("Content-Disposition", "")
        base_name = sanitize_filename(preferred_name, fallback="")
        if not base_name:
            suggested_name = _parse_content_disposition_filename(disposition)
            base_name = sanitize_filename(suggested_name, fallback="certificate")
        if not base_name.lower().endswith(".pdf"):
            base_name = f"{base_name}.pdf"

        first_chunk = resp.read(1024 * 64)
        first_chunk_preview = first_chunk[:512].lstrip().lower()
        if (
            not first_chunk_preview.startswith(b"%pdf")
            and ("text/html" in content_type or first_chunk_preview.startswith(b"<!doctype") or first_chunk_preview.startswith(b"<html"))
        ):
            raise RuntimeError("Registration URL returned HTML instead of a PDF")

        target_path = ensure_unique_path(os.path.join(dest_dir, base_name))
        with open(target_path, "wb") as handle:
            if first_chunk:
                handle.write(first_chunk)
            while True:
                chunk = resp.read(1024 * 64)
                if not chunk:
                    break
                handle.write(chunk)
        return target_path


async def navigate_with_timeout(page, url: str, label: str, timeout: float = 35.0):
    print(
        f"[PY] RegistrationCertificateDownloader: opening {label}: {url}",
        file=sys.stderr,
        flush=True,
    )
    try:
        await asyncio.wait_for(page.get(url), timeout=timeout)
        return
    except asyncio.TimeoutError:
        print(
            f"[PY] RegistrationCertificateDownloader: timed out opening {label}; continuing with current page state.",
            file=sys.stderr,
            flush=True,
        )
    except Exception as err:
        raise RuntimeError(f"Failed to open {label}: {err}") from err


async def direct_download_certificate(
    registration_url: str,
    download_path: str,
    preferred_name: str,
    cookie_header: str,
    headers=None,
):
    return await asyncio.to_thread(
        download_pdf_with_cookies,
        registration_url,
        download_path,
        preferred_name,
        cookie_header,
        headers,
        60,
    )


async def _page_eval_fetch_url_once(
    page,
    url: str,
    header_json: str,
    timeout: float,
) -> dict:
    """fetch() in page context with credentials; requires await_promise + return_by_value."""
    url_lit = json.dumps(url)
    expr = f"""
    (async () => {{
        const url = {url_lit};
        const hdrs = {header_json};
        try {{
            const r = await fetch(url, {{ credentials: 'include', headers: hdrs }});
            const status = r.status || 0;
            const ct = r.headers.get('content-type') || '';
            const disp = r.headers.get('content-disposition') || '';
            const ab = await r.arrayBuffer();
            const bytes = new Uint8Array(ab);
            let binary = '';
            const cs = 0x8000;
            for (let i = 0; i < bytes.length; i += cs) {{
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + cs));
            }}
            return JSON.stringify({{
                ok: Boolean(status && status < 400 && binary.length > 0),
                status,
                base64: btoa(binary),
                contentType: ct,
                disposition: disp,
                error: '',
            }});
        }} catch (e) {{
            return JSON.stringify({{
                ok: false,
                status: 0,
                base64: '',
                contentType: '',
                disposition: '',
                error: String(e || 'fetch_failed'),
            }});
        }}
    }})()
    """
    raw = await asyncio.wait_for(
        page.evaluate(expr, await_promise=True, return_by_value=True),
        timeout=max(10.0, float(timeout or 75.0)),
    )

    result = normalize_evaluate_json_result(raw)
    if not isinstance(result, dict):
        raise RuntimeError(
            "Page fetch returned an invalid response "
            f"({type(raw).__name__}); nodriver did not return JSON — check console/CSP"
        )
    return result


async def download_pdf_via_page_fetch(
    page,
    registration_url: str,
    download_path: str,
    preferred_name: str,
    report_id: str,
    timeout: float = 75.0,
) -> str:
    header_sets = [
        {"Accept": "application/pdf"},
        {"Accept": "application/pdf,*/*;q=0.9"},
        {},
        {"Accept": "application/octet-stream"},
    ]

    seen_urls: set[str] = set()
    queue: list[str] = [(registration_url or "").strip()]
    hops = 0

    while queue:
        url = queue.pop(0).strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        hops += 1
        if hops > 12:
            break

        for hdr in header_sets:
            result = await _page_eval_fetch_url_once(
                page,
                url,
                json.dumps(hdr),
                timeout,
            )
            if str(result.get("error") or "").strip() and not result.get("ok"):
                continue
            if not result.get("ok"):
                continue
            data = base64.b64decode(result.get("base64") or "")
            if looks_like_pdf_bytes(data):
                file_name = build_certificate_filename(preferred_name, report_id)
                target_path = ensure_unique_path(os.path.join(download_path, file_name))
                os.makedirs(download_path, exist_ok=True)
                with open(target_path, "wb") as handle:
                    handle.write(data)
                print(
                    "[PY] RegistrationCertificateDownloader: page fetch got PDF bytes "
                    f"for report {report_id} (url tried: {url[:120]})",
                    file=sys.stderr,
                    flush=True,
                )
                return target_path
            if _looks_like_html_bytes(data):
                for extra in _extract_pdf_related_urls_from_html(data, registration_url):
                    if extra not in seen_urls:
                        queue.append(extra)

    raise RuntimeError("Page fetch did not yield PDF bytes for registration URL (HTML wrapper or auth)")


async def download_single_certificate(page, browser, report_id, asset_name, download_path, download_lock=None):
    try:
        report_url = f"https://qima.taqeem.gov.sa/report/{report_id}"
        await navigate_with_timeout(page, report_url, f"report {report_id}", timeout=40.0)
        for _ in range(10):
            if await has_confirmed_status(page):
                break
            await page.sleep(0.28)

        asset_name_page = repair_mojibake((await get_asset_name_from_report_table(page)).strip())
        if not asset_name_page:
            asset_name_page = repair_mojibake((await get_asset_name_from_report_details(page)).strip())

        await page.sleep(0.45)

        registration_url = await poll_registration_url_from_report_html(page, report_id)
        if not registration_url:
            target = await find_registration_certificate_target(page, timeout=18)
            registration_url = await resolve_registration_url(page, target) if target else ""

        if not registration_url:
            print(
                f"[PY] RegistrationCertificateDownloader: registration certificate link not found for report {report_id}",
                file=sys.stderr,
                flush=True,
            )
            return {
                "reportId": report_id,
                "status": "NOT_CONFIRMED",
                "error": "Registration certificate link not found on report page",
            }
        print(
            f"[PY] RegistrationCertificateDownloader: report {report_id} registration URL: {registration_url}",
            file=sys.stderr,
            flush=True,
        )

        try:
            user_agent = await asyncio.wait_for(
                page.evaluate("navigator.userAgent"),
                timeout=5.0,
            )
        except Exception as err:
            print(
                "[PY] RegistrationCertificateDownloader: could not read user agent "
                f"for report {report_id}: {type(err).__name__}: {format_error(err)}",
                file=sys.stderr,
                flush=True,
            )
            user_agent = ""

        headers = {
            "Accept": "application/pdf",
            "Referer": f"https://qima.taqeem.gov.sa/report/{report_id}",
        }
        if user_agent:
            headers["User-Agent"] = user_agent

        fallback_name = asset_name or asset_name_page or f"certificate_{safe_token(report_id, 'report')}"
        target_path = None

        try:
            print(
                f"[PY] RegistrationCertificateDownloader: page fetch PDF download start for report {report_id}",
                file=sys.stderr,
                flush=True,
            )
            target_path = await download_pdf_via_page_fetch(
                page,
                registration_url,
                download_path,
                fallback_name,
                report_id,
            )
            print(
                f"[PY] RegistrationCertificateDownloader: page fetch PDF download succeeded for report {report_id}: {target_path}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as fetch_error:
            print(
                f"[PY] RegistrationCertificateDownloader: page fetch PDF download failed for report {report_id}: {format_error(fetch_error)}; trying Chrome PDF viewer Ctrl+S, then refetch/CDP.",
                file=sys.stderr,
                flush=True,
            )
            try:
                ctrl_saved = await save_registration_pdf_via_chrome_viewer_ctrl_s(
                    page,
                    registration_url,
                    download_path,
                    fallback_name,
                    report_id,
                )
                if ctrl_saved:
                    return {
                        "reportId": report_id,
                        "status": "DOWNLOADED",
                        "filePath": ctrl_saved,
                        "fileName": os.path.basename(ctrl_saved),
                    }
            except Exception as ctrl_bundle_err:
                print(
                    "[PY] RegistrationCertificateDownloader: primary Ctrl+S certificate flow failed "
                    f"for report {report_id}: {format_error(ctrl_bundle_err)}",
                    file=sys.stderr,
                    flush=True,
                )

            try:
                await navigate_with_timeout(
                    page,
                    registration_url,
                    f"registration certificate page {report_id}",
                    timeout=42.0,
                )
                await page.sleep(1.15)
                target_path = await download_pdf_via_page_fetch(
                    page,
                    registration_url,
                    download_path,
                    fallback_name,
                    report_id,
                )
                print(
                    f"[PY] RegistrationCertificateDownloader: page fetch PDF succeeded after navigation for report {report_id}: {target_path}",
                    file=sys.stderr,
                    flush=True,
                )
                return {
                    "reportId": report_id,
                    "status": "DOWNLOADED",
                    "filePath": target_path,
                    "fileName": os.path.basename(target_path),
                }
            except Exception as refetch_error:
                print(
                    f"[PY] RegistrationCertificateDownloader: page fetch after navigation failed for report {report_id}: {format_error(refetch_error)}",
                    file=sys.stderr,
                    flush=True,
                )

            cdp_path = None
            try:
                if download_lock:
                    async with download_lock:
                        cdp_path = await capture_registration_pdf_via_network_cdp(
                            page,
                            registration_url,
                            download_path,
                            fallback_name,
                            report_id,
                        )
                else:
                    cdp_path = await capture_registration_pdf_via_network_cdp(
                        page,
                        registration_url,
                        download_path,
                        fallback_name,
                        report_id,
                    )
            except Exception as cdp_err:
                print(
                    f"[PY] RegistrationCertificateDownloader: CDP sniff error for report {report_id}: "
                    f"{format_error(cdp_err)}",
                    file=sys.stderr,
                    flush=True,
                )
            if cdp_path:
                return {
                    "reportId": report_id,
                    "status": "DOWNLOADED",
                    "filePath": cdp_path,
                    "fileName": os.path.basename(cdp_path),
                }
            print(
                f"[PY] RegistrationCertificateDownloader: CDP sniff found no PDF body for report {report_id}; "
                "trying Ctrl+S again, then print fallback.",
                file=sys.stderr,
                flush=True,
            )
            try:
                ctrl_retry = await save_registration_pdf_via_chrome_viewer_ctrl_s(
                    page,
                    registration_url,
                    download_path,
                    fallback_name,
                    report_id,
                )
                if ctrl_retry:
                    return {
                        "reportId": report_id,
                        "status": "DOWNLOADED",
                        "filePath": ctrl_retry,
                        "fileName": os.path.basename(ctrl_retry),
                    }
            except Exception as ctrl_retry_err:
                print(
                    "[PY] RegistrationCertificateDownloader: secondary Ctrl+S failed "
                    f"for report {report_id}: {format_error(ctrl_retry_err)}",
                    file=sys.stderr,
                    flush=True,
                )
            try:
                non_click_path = await save_open_certificate_page_without_download_click(
                    page,
                    registration_url,
                    download_path,
                    fallback_name,
                    report_id,
                    browser=browser,
                )
                if non_click_path:
                    return {
                        "reportId": report_id,
                        "status": "DOWNLOADED",
                        "filePath": non_click_path,
                        "fileName": os.path.basename(non_click_path),
                    }
            except Exception as non_click_error:
                print(
                    "[PY] RegistrationCertificateDownloader: open-page non-click save "
                    f"failed for report {report_id}: {format_error(non_click_error)}; "
                    "trying direct urllib and viewer.",
                    file=sys.stderr,
                    flush=True,
                )
            cookie_header = await get_taqeem_cookie_header(browser, page, report_id)
            if cookie_header:
                try:
                    print(
                        f"[PY] RegistrationCertificateDownloader: direct PDF download start for report {report_id}",
                        file=sys.stderr,
                        flush=True,
                    )
                    target_path = await asyncio.wait_for(
                        direct_download_certificate(
                            registration_url,
                            download_path,
                            fallback_name,
                            cookie_header,
                            headers=headers,
                        ),
                        timeout=75.0,
                    )
                    print(
                        f"[PY] RegistrationCertificateDownloader: direct PDF download succeeded for report {report_id}: {target_path}",
                        file=sys.stderr,
                        flush=True,
                    )
                except Exception as direct_error:
                    print(
                        f"[PY] RegistrationCertificateDownloader: direct PDF download failed for report {report_id}: {format_error(direct_error)}; trying browser viewer.",
                        file=sys.stderr,
                        flush=True,
                    )
                    try:
                        if download_lock:
                            async with download_lock:
                                target_path = await download_pdf_through_viewer(
                                    page,
                                    registration_url,
                                    download_path,
                                    fallback_name,
                                    report_id,
                                    browser=browser,
                                )
                        else:
                            target_path = await download_pdf_through_viewer(
                                page,
                                registration_url,
                                download_path,
                                fallback_name,
                                report_id,
                                browser=browser,
                            )
                    except Exception as viewer_error:
                        return {
                            "reportId": report_id,
                            "status": "FAILED",
                            "error": (
                                f"page-fetch: {format_error(fetch_error)}; "
                                f"direct: {format_error(direct_error)}; "
                                f"viewer: {format_error(viewer_error)}"
                            ),
                        }
            else:
                print(
                    f"[PY] RegistrationCertificateDownloader: no Taqeem cookies for report {report_id}; skipping urllib and using viewer.",
                    file=sys.stderr,
                    flush=True,
                )
                try:
                    if download_lock:
                        async with download_lock:
                            target_path = await download_pdf_through_viewer(
                                page,
                                registration_url,
                                download_path,
                                fallback_name,
                                report_id,
                                browser=browser,
                            )
                    else:
                        target_path = await download_pdf_through_viewer(
                            page,
                            registration_url,
                            download_path,
                            fallback_name,
                            report_id,
                            browser=browser,
                        )
                except Exception as viewer_error:
                    return {
                        "reportId": report_id,
                        "status": "FAILED",
                        "error": (
                            f"page-fetch: {format_error(fetch_error)}; "
                            f"viewer: {format_error(viewer_error)}"
                        ),
                    }

        if not target_path:
            return {
                "reportId": report_id,
                "status": "FAILED",
                "error": "PDF download produced no file",
            }

        return {
            "reportId": report_id,
            "status": "DOWNLOADED",
            "filePath": target_path,
            "fileName": os.path.basename(target_path),
        }
    except Exception as e:
        return {"reportId": report_id, "status": "FAILED", "error": format_error(e)}


async def download_registration_certificates(cmd):
    download_path = cmd.get("downloadPath") or cmd.get("download_path") or cmd.get("path")
    reports = cmd.get("reports") or []
    print(
        f"[PY] RegistrationCertificateDownloader: starting download for {len(reports)} report(s)",
        file=sys.stderr,
        flush=True,
    )

    if not download_path:
        return {"status": "FAILED", "error": "Missing downloadPath"}

    if not reports:
        return {"status": "FAILED", "error": "No reports provided"}

    browser_status = await check_browser_status()
    if not browser_status.get("browserOpen", False):
        return {"status": "FAILED", "error": "Browser is not open"}
    if browser_status.get("status") != "SUCCESS":
        return {"status": "NOT_LOGGED_IN", "error": "User not logged in"}

    download_path = normalize_download_path(download_path)
    if not download_path:
        return {"status": "FAILED", "error": "Missing downloadPath"}
    os.makedirs(download_path, exist_ok=True)

    base_browser = await get_browser()

    tabs_raw = cmd.get("tabsNum") or cmd.get("tabs_num") or cmd.get("tabs") or 1
    try:
        tabs = int(tabs_raw)
    except Exception:
        tabs = 1
    tabs = max(1, tabs)
    if reports:
        tabs = min(tabs, len(reports))

    working_browser = None
    action_page = None
    spawned_browser = None
    try:
        working_browser, action_page, spawned_browser = await open_workflow_page(
            base_browser,
            force_spawn=True,
            headless=False,
        )
    except Exception as e:
        return {
            "status": "FAILED",
            "error": f"Failed to open Taqeem action browser: {e}",
        }

    pages = []
    if working_browser and action_page:
        try:
            pages = await open_workflow_pages(
                working_browser,
                action_page,
                tabs,
                timeout=30.0,
            )
        except Exception as e:
            print(
                f"[PY] RegistrationCertificateDownloader: failed to open action tabs: {e}",
                file=sys.stderr,
                flush=True,
            )
            pages = []

    if not pages:
        try:
            if spawned_browser:
                spawned_browser.stop()
            elif action_page:
                await action_page.close()
        except Exception:
            pass
        return {"status": "FAILED", "error": "Failed to open action browser tabs"}

    print(
        f"[PY] RegistrationCertificateDownloader: action browser ready with {len(pages)} tab(s)",
        file=sys.stderr,
        flush=True,
    )

    results = []
    normalized_reports = []

    for rep in reports:
        report_id = None
        asset_name = None
        if isinstance(rep, str):
            report_id = rep.strip()
        elif isinstance(rep, dict):
            report_id = rep.get("reportId") or rep.get("report_id") or rep.get("reportid")
            asset_name = rep.get("assetName") or rep.get("asset_name") or rep.get("asset")

        report_id = str(report_id).strip() if report_id else ""
        asset_name = repair_mojibake(str(asset_name)) if asset_name else None
        if not report_id:
            results.append({"reportId": None, "status": "SKIPPED", "reason": "missing_report_id"})
            continue
        normalized_reports.append({"reportId": report_id, "assetName": asset_name})

    download_lock = asyncio.Lock()

    async def process_chunk(page, chunk):
        out = []
        for rep in chunk:
            report_id = rep.get("reportId")
            try:
                res = await asyncio.wait_for(
                    download_single_certificate(
                        page,
                        working_browser,
                        report_id,
                        rep.get("assetName"),
                        download_path,
                        download_lock,
                    ),
                    timeout=720.0,
                )
            except asyncio.TimeoutError:
                res = {
                    "reportId": report_id,
                    "status": "FAILED",
                    "error": "Certificate download timed out",
                }
            except Exception as err:
                res = {
                    "reportId": report_id,
                    "status": "FAILED",
                    "error": format_error(err),
                }
            out.append(res)
        return out

    try:
        if normalized_reports:
            chunks = chunk_items(normalized_reports, len(pages))
            chunk_results = await asyncio.gather(
                *(process_chunk(p, c) for p, c in zip(pages, chunks))
            )
            for chunk in chunk_results:
                results.extend(chunk)
    finally:
        if spawned_browser:
            try:
                spawned_browser.stop()
            except Exception:
                pass
        else:
            for page in pages:
                try:
                    await page.close()
                except Exception:
                    pass

    downloaded = sum(1 for r in results if r.get("status") == "DOWNLOADED")
    failed = sum(1 for r in results if r.get("status") == "FAILED")
    skipped = sum(1 for r in results if r.get("status") in ("SKIPPED", "NOT_CONFIRMED"))

    return {
        "status": "SUCCESS",
        "results": results,
        "summary": {
            "downloaded": downloaded,
            "skipped": skipped,
            "failed": failed,
            "total": len(reports),
        },
    }
