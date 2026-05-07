import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import nodriver as uc
from dotenv import load_dotenv

from .utils import log

load_dotenv()

browser = None
page = None
refresh_task = None
_cookie_backup_task = None
TAQEEM_APP_PREFIX = "https://qima.taqeem.gov.sa/"
TAQEEM_AUTH_URL_MARKERS = (
    "sso.taqeem.gov.sa/realms/rel_taqeem/login-actions/authenticate",
    "sso.taqeem.gov.sa/realms/rel_taqeem/protocol/openid-connect/auth",
    "/login-actions/authenticate",
    "/protocol/openid-connect/auth",
)
_last_known_taqeem_session = {
    "authenticated": False,
    "url": "",
}


def _remember_taqeem_authenticated(url: str = ""):
    global _last_known_taqeem_session
    _last_known_taqeem_session["authenticated"] = True
    if url:
        _last_known_taqeem_session["url"] = str(url).strip()


def _remember_taqeem_logged_out():
    global _last_known_taqeem_session
    _last_known_taqeem_session["authenticated"] = False
    _last_known_taqeem_session["url"] = ""


def _has_last_known_taqeem_session() -> bool:
    return bool(_last_known_taqeem_session.get("authenticated"))


def _build_preserved_session_result(message: str, checked_urls=None):
    preserved_url = str(_last_known_taqeem_session.get("url") or "").strip()
    result = {
        "status": "SUCCESS",
        "message": message,
        "browserOpen": True,
        "checkedUrls": checked_urls or [],
        "preservedSession": True,
    }
    if preserved_url:
        result["url"] = preserved_url
    return result


def _browser_transport_alive(browser_instance) -> bool:
    if browser_instance is None:
        return False

    try:
        if getattr(browser_instance, "stopped", False):
            return False
    except Exception:
        return False

    try:
        connection = getattr(browser_instance, "connection", None)
        if connection is not None and getattr(connection, "closed", False):
            return False
    except Exception:
        return False

    return True


def get_profile_dir():
    """
    Persistent Chrome user-data directory so Taqeem SSO cookies survive app restarts.
    Override with env VALUE_TECH_TAQEEM_PROFILE_DIR.
    """
    override = os.getenv("VALUE_TECH_TAQEEM_PROFILE_DIR", "").strip()
    if override:
        path = Path(override)
    elif sys.platform.startswith("win"):
        local = os.environ.get("LOCALAPPDATA", "")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        path = base / "ValueTech" / "taqeem_chrome_profile"
    elif sys.platform == "darwin":
        path = (
            Path.home()
            / "Library"
            / "Application Support"
            / "ValueTech"
            / "taqeem_chrome_profile"
        )
    else:
        path = Path.home() / ".local" / "share" / "valuetech" / "taqeem_chrome_profile"

    path.mkdir(parents=True, exist_ok=True)
    print(str(path.resolve()), file=sys.stderr, flush=True)
    return str(path.resolve())


def get_secondary_approval_profile_dir():
    """
    Isolated Chrome user-data-dir for Taqeem *secondary* (approver) login + approvals.
    Never shares cookies with the primary Valuer browser (taqeem_chrome_profile).
    Override with VALUE_TECH_TAQEEM_SECONDARY_APPROVAL_PROFILE_DIR.
    """
    override = os.getenv("VALUE_TECH_TAQEEM_SECONDARY_APPROVAL_PROFILE_DIR", "").strip()
    if override:
        path = Path(override)
    elif sys.platform.startswith("win"):
        local = os.environ.get("LOCALAPPDATA", "")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        path = base / "ValueTech" / "taqeem_secondary_approval_profile"
    elif sys.platform == "darwin":
        path = (
            Path.home()
            / "Library"
            / "Application Support"
            / "ValueTech"
            / "taqeem_secondary_approval_profile"
        )
    else:
        path = Path.home() / ".local" / "share" / "valuetech" / "taqeem_secondary_approval_profile"

    path.mkdir(parents=True, exist_ok=True)
    print(
        f"[PY] secondary approval profile: {path.resolve()}",
        file=sys.stderr,
        flush=True,
    )
    return str(path.resolve())


async def spawn_new_browser(
    old_browser,
    user_data_dir=None,
    headless=True,
):
    """
    Start a separate Chrome process for automation.

    Never reuse the live login profile directory while the primary browser still
    holds the lock (Windows locks the entire user-data-dir). A second uc.start()
    with the same path hangs or never opens. Use a temp profile and restore
    session via the shared .session.dat cookie jar instead.
    """
    profile_dir = get_profile_dir()
    session_file = str(Path(profile_dir) / ".session.dat")

    user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    )

    temp_profile_to_cleanup = None
    if user_data_dir is not None and str(user_data_dir).strip():
        isolated_user_data = str(Path(user_data_dir).resolve())
    else:
        temp_profile_to_cleanup = tempfile.mkdtemp(prefix="valuetech_nodriver_")
        isolated_user_data = temp_profile_to_cleanup
        print(
            f"[PY] spawn_new_browser: using temp user-data-dir (avoids profile lock): {isolated_user_data}",
            file=sys.stderr,
            flush=True,
        )

    try:
        if old_browser:
            await old_browser.cookies.save(session_file)
    except Exception:
        # If saving cookies from the old browser fails, proceed with whatever is on disk
        pass

    try:
        new_browser = await uc.start(
            user_data_dir=isolated_user_data,
            headless=headless,
            browser_args=[
                f"--user-agent={user_agent}",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no_sandbox",
                "--disable-popup-blocking",
                "--disable-features=VizDisplayCompositor",
                "--lang=en-US",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
    except Exception:
        if temp_profile_to_cleanup:
            shutil.rmtree(temp_profile_to_cleanup, ignore_errors=True)
        raise

    if temp_profile_to_cleanup:
        _orig_stop = new_browser.stop

        def _stop_and_cleanup():
            try:
                return _orig_stop()
            finally:
                shutil.rmtree(temp_profile_to_cleanup, ignore_errors=True)

        new_browser.stop = _stop_and_cleanup

    try:
        await new_browser.cookies.load(session_file)
    except Exception:
        # Continue even if cookies fail to load; caller can handle auth failures
        pass
    return new_browser


async def close_extra_tabs(browser=None):
    if not browser:
        browser = await get_browser()

    for tab in browser.tabs[1:]:
        try:
            await tab.close()
        except Exception as e:
            print(f"Failed to close tab: {e}")


async def switch_to_headless():
    global browser

    if not browser:
        return {"status": "FAILED", "error": "No active browser"}

    old_browser = browser

    try:
        profile_path = get_profile_dir()
        session_file = profile_path + "/.session.dat"
        await old_browser.cookies.save(session_file)

        user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
        )

        headless_browser = await uc.start(
            headless=True,
            user_data_dir=profile_path,
            browser_args=[
                f"--user-agent={user_agent}",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no_sandbox",
                "--disable-popup-blocking",
                "--disable-features=VizDisplayCompositor",
                "--lang=en-US",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        await headless_browser.cookies.load(session_file)
        browser = headless_browser
        old_browser.stop()

        global refresh_task
        if refresh_task is None or refresh_task.done():
            refresh_task = asyncio.create_task(_periodic_refresh(interval_minutes=1))

        return {"status": "SUCCESS"}

    except Exception as e:
        return {"status": "FAILED", "error": str(e)}


async def get_browser(force_new=False, headless_override=None):
    global browser, _cookie_backup_task

    if force_new and browser:
        await closeBrowser()

    if browser is not None:
        try:
            # If the browser was closed externally, this access can throw or return empty tabs.
            tabs = browser.tabs
            if not tabs:
                await closeBrowser()
        except Exception:
            await closeBrowser()

    if browser is None:
        # Default behavior from environment
        env_headless = os.getenv("HEADLESS", "false").lower() in ("true", "1", "yes")

        # Allow callers to explicitly override
        headless = headless_override if headless_override is not None else env_headless

        print(
            json.dumps({"type": "DEBUG", "message": f"Headless mode: {headless}"}),
            flush=True,
        )

        user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
        )

        profile_path = get_profile_dir()

        browser = await uc.start(
            headless=headless,
            user_data_dir=profile_path,
            browser_args=[
                f"--user-agent={user_agent}",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no_sandbox",
                "--disable-popup-blocking",
                "--disable-features=VizDisplayCompositor",
                "--lang=en-US",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            window_size=(1920, 1080),
        )

        if _cookie_backup_task is None or _cookie_backup_task.done():
            _cookie_backup_task = asyncio.create_task(
                _periodic_session_cookie_backup(
                    float(os.getenv("TAQEEM_COOKIE_BACKUP_INTERVAL_MINUTES", "10") or 10)
                )
            )

    return browser


async def get_main_tab():
    b = await get_browser()
    if b.main_tab is None and len(b.tabs) > 0:
        return b.tabs[0]
    return b.main_tab or await b.get("about:blank")


def _collect_browser_tabs(browser_instance):
    candidates = []
    seen = set()

    if browser_instance is None:
        return candidates

    try:
        main_tab = browser_instance.main_tab
    except Exception:
        main_tab = None

    if main_tab is not None:
        tab_id = id(main_tab)
        if tab_id not in seen:
            seen.add(tab_id)
            candidates.append(main_tab)

    try:
        tabs = list(browser_instance.tabs or [])
    except Exception:
        tabs = []

    for candidate in tabs:
        if candidate is None:
            continue
        tab_id = id(candidate)
        if tab_id in seen:
            continue
        seen.add(tab_id)
        candidates.append(candidate)

    return candidates


async def _read_tab_url(tab):
    if tab is None:
        return ""

    try:
        url = await asyncio.wait_for(
            tab.evaluate("window.location.href"),
            timeout=12.0,
        )
    except (asyncio.TimeoutError, Exception):
        return ""

    return str(url or "").strip()


async def inspect_taqeem_browser_session(browser_instance=None):
    active_browser = browser_instance or browser
    if active_browser is None:
        return {
            "status": "FAILED",
            "error": "No browser instance",
            "browserOpen": False,
            "checkedUrls": [],
        }

    if not _browser_transport_alive(active_browser):
        return {
            "status": "FAILED",
            "error": "Browser transport is closed",
            "browserOpen": False,
            "checkedUrls": [],
        }

    try:
        pages = _collect_browser_tabs(active_browser)
    except Exception as e:
        if _has_last_known_taqeem_session():
            return _build_preserved_session_result(
                "Keeping last known Taqeem session while browser targets refresh",
                [],
            )
        return {
            "status": "FAILED",
            "error": str(e),
            "browserOpen": True,
            "checkedUrls": [],
        }

    if not pages:
        if _has_last_known_taqeem_session():
            return _build_preserved_session_result(
                "Keeping last known Taqeem session while browser tabs are reloading",
                [],
            )
        return {
            "status": "FAILED",
            "error": "Browser is open but no page targets are ready yet",
            "browserOpen": True,
            "checkedUrls": [],
        }

    checked_urls = []
    found_auth_page = False
    found_any_page = False

    for candidate in pages:
        url = await _read_tab_url(candidate)
        if not url:
            continue

        found_any_page = True
        checked_urls.append(url)
        current_url = url.lower()

        if current_url.startswith(TAQEEM_APP_PREFIX):
            _remember_taqeem_authenticated(url)
            return {
                "status": "SUCCESS",
                "message": "User is logged in",
                "browserOpen": True,
                "url": url,
                "checkedUrls": checked_urls,
                "page": candidate,
            }

        if any(marker in current_url for marker in TAQEEM_AUTH_URL_MARKERS):
            found_auth_page = True

    if found_auth_page:
        _remember_taqeem_logged_out()
        return {
            "status": "NOT_LOGGED_IN",
            "error": "User not logged in",
            "browserOpen": True,
            "checkedUrls": checked_urls,
        }

    if _has_last_known_taqeem_session():
        return _build_preserved_session_result(
            "Keeping last known Taqeem session while current page is not readable yet",
            checked_urls,
        )

    if found_any_page:
        return {
            "status": "FAILED",
            "error": "Browser is open but no authenticated Taqeem page was detected yet",
            "browserOpen": True,
            "checkedUrls": checked_urls,
        }

    return {
        "status": "FAILED",
        "error": "Browser is open but the current page is still loading",
        "browserOpen": True,
        "checkedUrls": checked_urls,
    }


async def check_browser_status():
    global browser
    if browser is None:
        _remember_taqeem_logged_out()
        return {
            "status": "FAILED",
            "error": "No browser instance",
            "browserOpen": False,
        }

    try:
        if not _browser_transport_alive(browser):
            _remember_taqeem_logged_out()
            await closeBrowser()
            return {
                "status": "FAILED",
                "error": "Browser transport is closed",
                "browserOpen": False,
            }

        result = await inspect_taqeem_browser_session(browser)
        if result.get("status") == "FAILED" and result.get("browserOpen") is False:
            _remember_taqeem_logged_out()
            await closeBrowser()
        elif result.get("status") == "NOT_LOGGED_IN":
            _remember_taqeem_logged_out()
        elif result.get("status") == "SUCCESS":
            _remember_taqeem_authenticated(result.get("url", ""))
        return {key: value for key, value in result.items() if key != "page"}
    except Exception as e:
        if _browser_transport_alive(browser) and _has_last_known_taqeem_session():
            return _build_preserved_session_result(
                f"Keeping last known Taqeem session after transient status error: {e}",
                [],
            )

        # Browser instance exists but is not actually running
        _remember_taqeem_logged_out()
        await closeBrowser()
        return {"status": "FAILED", "error": str(e), "browserOpen": False}


async def new_tab(url):
    global browser
    if browser:
        try:
            new_tab = await browser.get(url, new_tab=True)
            return new_tab
        except Exception as e:
            return {"status": "FAILED", "error": str(e)}


async def new_window(url):
    global browser
    if browser:
        try:
            new_window = await browser.get(url, new_window=True)
            return new_window
        except Exception as e:
            return {"status": "FAILED", "error": str(e)}


async def closeBrowser():
    global browser, page, refresh_task, _cookie_backup_task

    if refresh_task:
        refresh_task.cancel()
        refresh_task = None

    if _cookie_backup_task:
        _cookie_backup_task.cancel()
        try:
            await _cookie_backup_task
        except asyncio.CancelledError:
            pass
        _cookie_backup_task = None

    if browser:
        try:
            browser.stop()
        except Exception:
            pass
    browser, page = None, None
    _remember_taqeem_logged_out()


def set_page(new_page):
    global page
    page = new_page


def get_page():
    global page
    return page


async def navigate(url: str):
    def _sanitize(u: str) -> str:
        return (u or "").strip().strip('"\\' + "'")

    url = _sanitize(url)
    browser = await get_browser()

    if not _is_valid_http_url(url):
        log(f"Invalid URL -> '{url}'", "ERR")
        page = await browser.new_page()
        return page

    # Try once, then restart browser and retry once more if transport fails
    for attempt in range(2):
        try:
            return await browser.get(url)
        except Exception as e:
            log(f"browser.get() failed (try {attempt + 1}/2): {e}", "WARN")
            try:
                page = await browser.new_page()
                await page.evaluate("url => { window.location.href = url; }", url)
                return page
            except Exception as e2:
                log(f"fallback window.location failed: {e2}", "WARN")
                if attempt == 0:
                    # restart browser and retry
                    try:
                        await closeBrowser()
                    except Exception:
                        pass
                    # get_browser() will recreate
                    browser = await get_browser()
                else:
                    # give up with a blank page
                    try:
                        return await browser.new_page()
                    except Exception:
                        raise


def _is_valid_http_url(url: str) -> bool:
    try:
        parts = urlparse(url)
        return parts.scheme in ("http", "https") and bool(parts.netloc)
    except Exception:
        return False


async def _periodic_session_cookie_backup(interval_minutes=10):
    """
    Periodically persist nodriver cookies to .session.dat while the primary Taqeem
    browser is open so a crash or rare profile hiccup loses less state.
    """
    profile_path = get_profile_dir()
    session_file = str(Path(profile_path) / ".session.dat")
    interval_seconds = max(120, int(interval_minutes * 60))

    while True:
        try:
            await asyncio.sleep(interval_seconds)
            b = browser
            if not b:
                continue
            if not _browser_transport_alive(b):
                continue
            await b.cookies.save(session_file)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(
                json.dumps(
                    {
                        "type": "WARN",
                        "message": f"Periodic cookie backup failed: {e}",
                    }
                ),
                flush=True,
            )


async def _periodic_refresh(interval_minutes=1):
    global browser

    interval_seconds = interval_minutes * 60

    while True:
        try:
            await asyncio.sleep(interval_seconds)

            if not browser:
                continue

            page = browser.main_tab
            if not page:
                continue

            current_url = await page.evaluate("window.location.href")
            if not current_url:
                continue

            await page.get(current_url)

            print(
                json.dumps(
                    {
                        "type": "DEBUG",
                        "message": f"Headless session refreshed: {current_url}",
                    }
                ),
                flush=True,
            )

        except asyncio.CancelledError:
            break
        except Exception as e:
            print(
                json.dumps(
                    {"type": "WARN", "message": f"Periodic refresh failed: {e}"}
                ),
                flush=True,
            )
