"""
Dedicated Chrome (nodriver) for Taqeem *secondary* user: manual login when needed,
then parallel approvals across multiple tabs (tabsNum / recommendedTabs style).

Uses its own user-data-dir (see get_secondary_approval_profile_dir) so it never
touches the primary Valuer automation profile.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import nodriver as uc
from dotenv import load_dotenv

from scripts.core.browser import get_secondary_approval_profile_dir

QIMA_HOME = "https://qima.taqeem.gov.sa/"
# ValueTech-Frontend/.env (same depth as taqeem_primary_credentials.py)
_SECONDARY_ENV_FILE = Path(__file__).resolve().parents[3] / ".env"
DEFAULT_APPROVAL_MAX_TABS = 4
HARD_APPROVAL_MAX_TABS = 8
DEFAULT_APPROVAL_UI_DEADLINE_MS = 45000
APPROVAL_EVALUATE_TIMEOUT_S = 6.0


def chunk_items(items: list[str], n: int) -> list[list[str]]:
    """Split items into n balanced chunks (one nodriver tab per chunk)."""
    n = max(1, n)
    k, m = divmod(len(items), n)
    chunks: list[list[str]] = []
    start = 0
    for i in range(n):
        size = k + (1 if i < m else 0)
        chunks.append(items[start : start + size])
        start += size
    return chunks


def _normalize_report_ids(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if isinstance(item, dict):
            rid = item.get("reportId") or item.get("report_id") or item.get("reportid")
        else:
            rid = item
        s = str(rid or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _qima_app_ready(href: str) -> bool:
    u = (href or "").lower().strip()
    if not u.startswith("https://qima.taqeem.gov.sa/"):
        return False
    if "keycloak" in u:
        return False
    return True


def _should_offer_secondary_login_assist(href: str) -> bool:
    """Same idea as Electron authHandlers.shouldOfferTaqeemLoginAssist (Keycloak / SSO)."""
    u = (href or "").lower().strip()
    if u.startswith("https://qima.taqeem.gov.sa/"):
        return False
    return "sso.taqeem.gov.sa" in u or "openid-connect" in u


def _secondary_login_assist_script(login_id: str, password: str) -> str:
    lid = json.dumps(login_id)
    pwd = json.dumps(password)
    return f"""
(() => {{
  const LOGIN_ID = {lid};
  const PASSWORD = {pwd};
  if (!LOGIN_ID || !PASSWORD) return {{ "ok": false, "reason": "no_credentials" }};

  window.__vtSecAssist = window.__vtSecAssist || {{ lastClick: 0 }};
  const now = Date.now();
  if (now - window.__vtSecAssist.lastClick < 4500) {{
    return {{ "ok": true, "skipped": true, "reason": "click_throttle" }};
  }}

  function pickUser() {{
    return document.querySelector(
      'input#username, input[name="username"], input[name="login"], input[type="text"][autocomplete="username"]'
    );
  }}
  function pickPass() {{
    return document.querySelector(
      'input#password, input[name="password"], input[type="password"]'
    );
  }}
  const userEl = pickUser();
  const passEl = pickPass();
  if (!userEl || !passEl) return {{ "ok": false, "reason": "no_fields" }};

  userEl.focus();
  userEl.value = LOGIN_ID;
  userEl.dispatchEvent(new Event("input", {{ bubbles: true }}));
  userEl.dispatchEvent(new Event("change", {{ bubbles: true }}));
  passEl.value = PASSWORD;
  passEl.dispatchEvent(new Event("input", {{ bubbles: true }}));
  passEl.dispatchEvent(new Event("change", {{ bubbles: true }}));

  const btn = document.querySelector(
    '#kc-login, input[type="submit"][name="login"], button[name="login"], input[name="login"][type="submit"]'
  );
  let clicked = false;
  if (btn && typeof btn.click === "function") {{
    btn.click();
    clicked = true;
    window.__vtSecAssist.lastClick = Date.now();
  }}
  try {{
    const scrollEl = userEl;
    if (scrollEl && scrollEl.scrollIntoView) {{
      scrollEl.scrollIntoView({{ block: "center", inline: "nearest", behavior: "auto" }});
    }}
  }} catch (e) {{}}
  return {{ "ok": true, "filled": true, "clicked": clicked }};
}})()
"""


async def _apply_secondary_login_credentials(page, login_id: str, password: str) -> dict[str, Any]:
    script = _secondary_login_assist_script(login_id, password)
    raw = await asyncio.wait_for(page.evaluate(script), timeout=25.0)
    return raw if isinstance(raw, dict) else {"ok": False, "reason": "bad_eval_result"}


async def _read_href(page) -> str:
    try:
        return str(await asyncio.wait_for(page.evaluate("window.location.href || ''"), timeout=20.0))
    except Exception:
        return ""


_APPROVE_POLL_JS = r"""
(async () => {
  const normalize = (value) => String(value || '')
    .replace(/[\u00a0]/g, ' ')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = (value) => normalize(value).toLowerCase();
  const textOf = (el) => normalize(
    el?.innerText || el?.textContent || el?.value || el?.getAttribute?.('aria-label') || ''
  );
  const attrText = (el) => lower([
    el?.id,
    el?.name,
    el?.value,
    el?.className,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('title'),
  ].filter(Boolean).join(' '));
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isDisabled = (el) =>
    !el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList?.contains('disabled');
  const queryAll = (selector) => {
    try { return Array.from(document.querySelectorAll(selector)); }
    catch (e) { return []; }
  };
  const firstVisible = (selector) => queryAll(selector).find(isVisible) || null;
  const firstMatch = (selector, allowHidden = false) => {
    const matches = queryAll(selector);
    return matches.find(isVisible) || (allowHidden ? matches[0] || null : null);
  };

  const href = String(window.location.href || '');
  if (!document.body) return 'wait:no_body';
  if (href.includes('sso.taqeem.gov.sa') || href.includes('openid-connect')) {
    return 'login:' + href.slice(0, 160);
  }

  const bodyText = normalize(document.body.innerText || '');
  const bodyLower = bodyText.toLowerCase();
  const alreadyApproved =
    bodyText.includes('\u0645\u0639\u062a\u0645\u062f') ||
    bodyLower.includes('approved') ||
    bodyLower.includes('confirmed');

  const checkboxSelectors = [
    ['input#agree', true],
    ['input[name="policy"]', true],
    ['input[type="checkbox"][name*="agree" i]', true],
    ['input[type="checkbox"][id*="agree" i]', true],
    ['input[type="checkbox"][name*="policy" i]', true],
    ['input[type="checkbox"][id*="policy" i]', true],
    ['input[type="checkbox"]', false],
  ];
  let checkbox = null;
  for (const [selector, allowHidden] of checkboxSelectors) {
    checkbox = firstMatch(selector, allowHidden);
    if (checkbox) break;
  }
  if (!checkbox) checkbox = queryAll('input[type="checkbox"]')[0] || null;

  const scoreButton = (el) => {
    if (!el || !isVisible(el)) return -1000;
    const text = lower(textOf(el));
    const data = `${attrText(el)} ${text}`;
    let score = 0;
    if (data.includes('\u0627\u0639\u062a\u0645\u0627\u062f')) score += 8;
    if (data.includes('\u062a\u0623\u0643\u064a\u062f')) score += 5;
    if (/\b(confirm|approve|approval)\b/.test(data)) score += 7;
    if (/\bsend\b/.test(data) || data.includes('\u0625\u0631\u0633\u0627\u0644')) score += 2;
    if (el.matches?.('#confirm, [name="confirm"], #approve, [name="approve"], #send, [name="send"]')) score += 5;
    if (el.matches?.('button.btn-primary, input.btn-primary, a.btn-primary, button[type="submit"], input[type="submit"]')) score += 2;
    if (isDisabled(el)) score -= 1;
    return score;
  };

  const buttonSelectors = [
    'input#confirm',
    'button#confirm',
    'a#confirm',
    'input[name="confirm"]',
    'button[name="confirm"]',
    'input#approve',
    'button#approve',
    'input[name="approve"]',
    'button[name="approve"]',
    'input#send',
    'button#send',
    'input[name="send"]',
    'button[name="send"]',
    'button.btn-primary',
    'input.btn-primary',
    'a.btn-primary',
    'button[type="submit"]',
    'input[type="submit"]',
    '[role="button"]',
  ];
  const buttonSet = new Set();
  for (const selector of buttonSelectors) {
    for (const el of queryAll(selector)) buttonSet.add(el);
  }
  const buttonCandidates = Array.from(buttonSet)
    .map((el) => ({ el, score: scoreButton(el) }))
    .sort((a, b) => b.score - a.score);
  const confirmBtn = buttonCandidates.length && buttonCandidates[0].score > 0
    ? buttonCandidates[0].el
    : null;

  if (!checkbox || !confirmBtn) {
    if (alreadyApproved) return 'already';
    return `wait:${!checkbox ? 'no_checkbox' : 'no_button'}`;
  }

  const fire = (el, type) => {
    const opts = { bubbles: true, cancelable: true, view: window };
    if (type.startsWith('pointer')) el.dispatchEvent(new PointerEvent(type, opts));
    else if (type.startsWith('mouse') || type === 'click') el.dispatchEvent(new MouseEvent(type, opts));
    else el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  };
  const nativeSetChecked = (el, value) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.checked = value;
  };
  const clickLikeUser = (el) => {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    try { el.focus?.({ preventScroll: true }); } catch (e) {}
    for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { fire(el, eventName); } catch (e) {}
    }
    try { el.click?.(); } catch (e) {}
  };

  try {
    clickLikeUser(checkbox);
    if (!checkbox.checked) nativeSetChecked(checkbox, true);
    fire(checkbox, 'input');
    fire(checkbox, 'change');
    fire(checkbox, 'blur');

    await new Promise((resolve) => setTimeout(resolve, 80));

    confirmBtn.disabled = false;
    confirmBtn.removeAttribute('disabled');
    confirmBtn.removeAttribute('aria-disabled');
    clickLikeUser(confirmBtn);
    return 'ok';
  } catch (e) {
    return 'err:' + (e?.message || String(e));
  }
})()
"""


async def _poll_click_approve(page, ui_deadline_s: float, poll_s: float) -> dict:
    deadline = time.monotonic() + max(5.0, ui_deadline_s)
    last_state = ""
    while time.monotonic() < deadline:
        try:
            raw = await asyncio.wait_for(
                page.evaluate(
                    _APPROVE_POLL_JS,
                    await_promise=True,
                    return_by_value=True,
                ),
                timeout=APPROVAL_EVALUATE_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            raw = "wait:evaluate_timeout"
        except Exception as err:
            raw = "err:" + str(err)
        if raw == "ok":
            await asyncio.sleep(0.75)
            return {"ok": True}
        if raw == "already":
            return {"ok": True, "already": True}
        if isinstance(raw, str) and raw.startswith("err:"):
            return {"ok": False, "error": raw[4:]}
        if isinstance(raw, str) and raw.startswith("login:"):
            return {"ok": False, "error": "Approval page redirected to login; complete secondary login and retry"}
        last_state = str(raw or "")
        await asyncio.sleep(poll_s)
    detail = f" (last state: {last_state})" if last_state else ""
    return {"ok": False, "error": f"Timeout waiting for approve controls{detail}"}


async def run_secondary_approval_batch(cmd: dict) -> dict:
    """
    cmd keys:
      reportIds: list[str|dict]
      loginUrl (optional)
      waitForLogin (bool, default True)
      loginTimeoutMs (int, default 300000)
      tabsNum: parallel tabs (same idea as batch status check / recommendedTabs)
      approvalLoadTimeoutMs, approvalUiDeadlineMs, approvalPollMs (optional)

    When waiting for login, fills Keycloak fields from ValueTech-Frontend/.env:
    TAQEEM_SECONDARY_LOGIN_ID, TAQEEM_SECONDARY_PASSWORD (same keys as Electron assist),
    then clicks #kc-login once per throttle window; complete OTP / 2FA manually if prompted.
    """
    report_ids = _normalize_report_ids(cmd.get("reportIds") or [])
    if not report_ids:
        return {"status": "FAILED", "error": "No reportIds for secondary approval", "batch": None}

    wait_for_login = cmd.get("waitForLogin", True) is not False
    login_timeout_ms = int(cmd.get("loginTimeoutMs") or 300000)
    load_timeout_s = max(15.0, float(cmd.get("approvalLoadTimeoutMs") or 120000) / 1000.0)
    ui_deadline_s = max(
        10.0,
        float(cmd.get("approvalUiDeadlineMs") or DEFAULT_APPROVAL_UI_DEADLINE_MS) / 1000.0,
    )
    poll_s = max(0.2, float(cmd.get("approvalPollMs") or 550) / 1000.0)

    try:
        tabs_cap = int(os.getenv("TAQEEM_SECONDARY_APPROVAL_MAX_TABS", str(DEFAULT_APPROVAL_MAX_TABS)))
    except ValueError:
        tabs_cap = DEFAULT_APPROVAL_MAX_TABS
    tabs_cap = max(1, min(HARD_APPROVAL_MAX_TABS, tabs_cap))
    requested = max(1, int(cmd.get("tabsNum") or cmd.get("tabs_num") or DEFAULT_APPROVAL_MAX_TABS))
    stagger_sec = float(os.getenv("TAQEEM_SECONDARY_APPROVAL_STAGGER_SEC", "0.45") or 0.45)

    profile = get_secondary_approval_profile_dir()
    user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    )

    browser = None
    try:
        print(
            json.dumps(
                {
                    "event": "taqeem-secondary-approval",
                    "phase": "starting_chrome",
                    "reports": len(report_ids),
                    "tabsRequested": requested,
                }
            ),
            flush=True,
        )
        browser = await uc.start(
            user_data_dir=profile,
            headless=False,
            browser_args=[
                f"--user-agent={user_agent}",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no_sandbox",
                "--disable-popup-blocking",
                "--disable-features=VizDisplayCompositor",
                "--lang=ar-SA,en-US",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            window_size=(1400, 920),
        )
        page = browser.main_tab
        if page is None:
            page = await browser.get("about:blank")

        await asyncio.wait_for(page.get(QIMA_HOME), timeout=load_timeout_s)

        if wait_for_login:
            load_dotenv(_SECONDARY_ENV_FILE)
            login_id = (os.getenv("TAQEEM_SECONDARY_LOGIN_ID") or "").strip()
            password = (os.getenv("TAQEEM_SECONDARY_PASSWORD") or "").strip()
            cred_missing_logged = False
            assist_applied_logged = False
            login_deadline = time.monotonic() + login_timeout_ms / 1000.0
            while time.monotonic() < login_deadline:
                href = await _read_href(page)
                if _qima_app_ready(href):
                    break
                if login_id and password:
                    if _should_offer_secondary_login_assist(href):
                        try:
                            res = await _apply_secondary_login_credentials(
                                page, login_id, password
                            )
                            if (
                                res.get("ok")
                                and res.get("filled")
                                and not assist_applied_logged
                            ):
                                assist_applied_logged = True
                                print(
                                    json.dumps(
                                        {
                                            "event": "taqeem-secondary-approval",
                                            "phase": "login_fields_filled",
                                            "clicked": bool(res.get("clicked")),
                                        }
                                    ),
                                    flush=True,
                                )
                        except Exception as err:
                            print(
                                json.dumps(
                                    {
                                        "event": "taqeem-secondary-approval",
                                        "phase": "login_assist_error",
                                        "error": str(err),
                                    }
                                ),
                                flush=True,
                            )
                elif (
                    _should_offer_secondary_login_assist(href)
                    and not cred_missing_logged
                ):
                    cred_missing_logged = True
                    print(
                        json.dumps(
                            {
                                "event": "taqeem-secondary-approval",
                                "phase": "login_credentials_missing",
                                "hint": "Set TAQEEM_SECONDARY_LOGIN_ID and TAQEEM_SECONDARY_PASSWORD in .env",
                            }
                        ),
                        flush=True,
                    )
                await asyncio.sleep(0.75)
            else:
                return {
                    "status": "FAILED",
                    "error": "Timed out waiting for Taqeem login in secondary Chrome. "
                    "Complete login in the opened window and run approval again.",
                    "batch": {
                        "total": len(report_ids),
                        "succeeded": 0,
                        "failed": len(report_ids),
                        "results": [
                            {
                                "reportId": rid,
                                "status": "FAILED",
                                "error": "Not logged in (timeout)",
                            }
                            for rid in report_ids
                        ],
                    },
                }

        effective_tabs = min(len(report_ids), requested, tabs_cap)
        print(
            json.dumps(
                {
                    "event": "taqeem-secondary-approval",
                    "phase": "parallel_tabs",
                    "effectiveTabs": effective_tabs,
                    "tabsCap": tabs_cap,
                }
            ),
            flush=True,
        )

        pages = [page]
        for _ in range(max(0, effective_tabs - 1)):
            try:
                extra = await asyncio.wait_for(
                    browser.get("about:blank", new_tab=True),
                    timeout=30.0,
                )
                if extra is not None:
                    pages.append(extra)
            except Exception:
                break

        chunks = chunk_items(report_ids, len(pages))

        async def approve_one(tab, rid: str) -> dict:
            url = f"https://qima.taqeem.gov.sa/report/{rid}"
            try:
                await asyncio.wait_for(tab.get(url), timeout=load_timeout_s)
                await asyncio.sleep(0.28)
                ap = await _poll_click_approve(tab, ui_deadline_s, poll_s)
                if ap.get("ok"):
                    return {"reportId": rid, "status": "SUCCESS"}
                return {
                    "reportId": rid,
                    "status": "FAILED",
                    "error": ap.get("error") or "Approve click failed",
                }
            except Exception as err:
                return {
                    "reportId": rid,
                    "status": "FAILED",
                    "error": str(err) or type(err).__name__,
                }

        async def process_chunk(tab, chunk: list[str], worker_index: int) -> list[dict]:
            await asyncio.sleep(max(0.0, stagger_sec) * worker_index)
            out: list[dict] = []
            for rid in chunk:
                out.append(await approve_one(tab, rid))
                await asyncio.sleep(0.08)
            return out

        parts = await asyncio.gather(
            *(process_chunk(p, c, i) for i, (p, c) in enumerate(zip(pages, chunks)))
        )
        merged: dict[str, dict] = {}
        for part in parts:
            for row in part:
                merged[str(row["reportId"])] = row
        results = [merged[rid] for rid in report_ids if rid in merged]

        succeeded = sum(1 for r in results if r.get("status") == "SUCCESS")
        failed = len(results) - succeeded
        batch = {
            "total": len(results),
            "succeeded": succeeded,
            "failed": failed,
            "results": results,
        }
        return {
            "status": "SUCCESS",
            "message": f"Secondary Chrome approvals finished: {succeeded}/{len(results)} OK",
            "batch": batch,
        }
    finally:
        if browser is not None:
            try:
                browser.stop()
            except Exception as err:
                print(
                    json.dumps(
                        {
                            "event": "taqeem-secondary-approval",
                            "phase": "browser_stop_warn",
                            "error": str(err),
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                )
