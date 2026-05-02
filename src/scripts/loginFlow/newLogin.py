import asyncio
import json
import os
import sys

from scripts.core.browser import (
    closeBrowser,
    get_browser,
    inspect_taqeem_browser_session,
    switch_to_headless,
)
from scripts.loginFlow.taqeem_login_assist import ensure_taqeem_primary_login_assist

TAQEEM_HOME_URL = "https://qima.taqeem.gov.sa/valuer/home"


async def wait_until_logged_in(page, timeout=340, poll=2):
    import time

    start = time.time()

    while time.time() - start < timeout:
        try:
            browser = await get_browser()
            session_state = await inspect_taqeem_browser_session(browser)

            if session_state.get("status") == "SUCCESS":
                return {
                    "status": "SUCCESS",
                    "url": session_state.get("url", ""),
                }

        except Exception as e:
            print(
                json.dumps(
                    {
                        "type": "DEBUG",
                        "message": f"wait_until_logged_in error: {e}",
                    }
                ),
                flush=True,
            )

        await asyncio.sleep(poll)

    return {"status": "FAILED", "error": "User did not complete login in time"}


async def open_taqeem_home_or_login(login_url, force_new=False):
    browser = await get_browser(force_new=force_new, headless_override=False)

    page = await browser.get(TAQEEM_HOME_URL)
    for _ in range(4):
        session_state = await inspect_taqeem_browser_session(browser)
        status = str(session_state.get("status") or "").upper()
        if status == "SUCCESS":
            return browser, page, {
                "status": "SUCCESS",
                "url": session_state.get("url", ""),
                "usedExistingSession": True,
            }
        if status == "NOT_LOGGED_IN":
            break
        await asyncio.sleep(0.25)

    # Keep the browser on the home request. If there is no active session,
    # Taqeem redirects this same tab to SSO, and wait_until_logged_in watches it.
    return browser, page, None


async def public_login_flow(login_url, is_auth=False):
    # Step 1: prefer the primary Taqeem home page. If no valid session exists,
    # Taqeem redirects to SSO and we continue with manual login.
    try:
        browser, page, existing_session = await open_taqeem_home_or_login(login_url)
    except Exception:
        # If the previous automation browser was closed, recreate it and retry once.
        await closeBrowser()
        browser, page, existing_session = await open_taqeem_home_or_login(login_url, force_new=True)

    if existing_session:
        logged_in = existing_session
    else:
        await ensure_taqeem_primary_login_assist(page)
        print("Please log in manually...")
        logged_in = await wait_until_logged_in(page)

    # Step 2: wait for success
    if logged_in["status"] != "SUCCESS":
        return logged_in

    try:
        await page.get(TAQEEM_HOME_URL)
        await asyncio.sleep(1)
        home_state = await inspect_taqeem_browser_session(browser)
        if home_state.get("status") == "SUCCESS":
            logged_in["url"] = home_state.get("url", TAQEEM_HOME_URL)
    except Exception:
        # Login is already verified; a home-navigation failure should not block automation.
        pass

    print(
        "[PY] Taqeem manual login detected in browser; proceeding (headless switch may follow).",
        file=sys.stderr,
        flush=True,
    )

    # For manual browser-based Taqeem login flows we keep the visible browser session as-is.
    # Switching to headless here adds delay and can leave the browser in a half-switched state.
    if not is_auth:
        print(
            json.dumps(
                {
                    "type": "DEBUG",
                    "message": "headless_switch",
                    "result": {
                        "status": "SKIPPED",
                        "message": "Headless switch skipped for manual Taqeem session",
                    },
                }
            ),
            flush=True,
        )
        return {
            "status": "CHECK",
            "user_id": None,
            "headless": False,
            "skippedHeadlessSwitch": True,
        }

    # Step 3: optional switch to headless (can time out on Windows; automation still works without it).
    skip_headless = os.getenv("TAQEEM_SKIP_HEADLESS_SWITCH", "").lower() in (
        "1",
        "true",
        "yes",
    )
    if skip_headless:
        switched = {"status": "SUCCESS", "skipped": True, "message": "Headless switch skipped via env"}
    else:
        try:
            switched = await asyncio.wait_for(switch_to_headless(), timeout=90)
        except asyncio.TimeoutError:
            switched = {
                "status": "FAILED",
                "error": "Timed out while switching the logged-in browser to headless mode",
            }

    print(json.dumps({"type": "DEBUG", "message": "headless_switch", "result": switched}), flush=True)

    if switched["status"] != "SUCCESS":
        fallback_result = {
            "warning": switched.get("error") or "Headless switch failed after successful login",
            "headless": False,
        }
        if not is_auth:
            return {"status": "CHECK", "user_id": None, **fallback_result}
        return {"status": "SUCCESS", **fallback_result}

    return {"status": "SUCCESS", "headless": True}
