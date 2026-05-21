"""Prefill Keycloak username/password and show a hint banner in the main Taqeem browser (nodriver)."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from scripts.loginFlow.taqeem_primary_credentials import (
    TAQEEM_PRIMARY_LOGIN_ID,
    TAQEEM_PRIMARY_PASSWORD,
)

TAQEEM_PRIMARY_AUTOFILL = os.getenv("TAQEEM_PRIMARY_AUTOFILL", "").lower() in (
    "1",
    "true",
    "yes",
)


def should_offer_taqeem_login_assist(url: str) -> bool:
    u = (url or "").lower()
    if u.startswith("https://qima.taqeem.gov.sa/"):
        return False
    return "sso.taqeem.gov.sa" in u or "openid-connect" in u


def primary_login_assist_js(login_id: str, password: str) -> str:
    lid = json.dumps(login_id)
    pwd = json.dumps(password)
    return f"""
(function () {{
    var LOGIN_ID = {lid};
    var PASSWORD = {pwd};
    function pickUser() {{
        return document.querySelector(
            '#username, input[name="username"], input[name="login"], input#username, input[type="text"][autocomplete="username"]'
        );
    }}
    function pickPass() {{
        return document.querySelector('#password, input[name="password"], input[type="password"]');
    }}
    var userEl = pickUser();
    var passEl = pickPass();
    if (userEl) {{
        userEl.focus();
        userEl.value = LOGIN_ID;
        userEl.dispatchEvent(new Event('input', {{ bubbles: true }}));
        userEl.dispatchEvent(new Event('change', {{ bubbles: true }}));
    }}
    if (passEl) {{
        passEl.value = PASSWORD;
        passEl.dispatchEvent(new Event('input', {{ bubbles: true }}));
        passEl.dispatchEvent(new Event('change', {{ bubbles: true }}));
    }}
    var HID = 'vt-taqeem-primary-cred-panel';
    var old = document.getElementById(HID);
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = HID;
    panel.setAttribute('dir', 'rtl');
    panel.style.cssText = [
        'position:fixed','top:0','left:0','right:0','z-index:2147483647',
        'font-family:system-ui,Segoe UI,Tahoma,sans-serif','font-size:13px',
        'background:#0d3d2e','color:#e8fef5','padding:10px 14px','text-align:center',
        'box-shadow:0 2px 8px rgba(0,0,0,0.35)','line-height:1.55'
    ].join(';');
    var title = document.createElement('strong');
    title.textContent = 'تسجيل دخول تقييم (المتصفح الرئيسي)';
    var titleWrap = document.createElement('div');
    titleWrap.appendChild(title);
    var line = document.createElement('div');
    line.style.marginTop = '6px';
    line.textContent = 'الهوية / الإقامة / البريد: ' + LOGIN_ID + ' — كلمة المرور: ' + (PASSWORD ? '••••••••' : '');
    var hint = document.createElement('div');
    hint.style.marginTop = '6px';
    hint.style.fontSize = '12px';
    hint.style.opacity = '0.92';
    hint.textContent =
        'تم تعبئة الحقول تلقائياً؛ أكمل أي خطوة يدوية إن لزم (مثل التحقق بخطوتين). الجلسة تُحفظ في هذا المتصفح بعد الدخول.';
    panel.appendChild(titleWrap);
    panel.appendChild(line);
    panel.appendChild(hint);
    if (document.body) document.body.appendChild(panel);
    return true;
}})();
"""


async def apply_taqeem_primary_login_assist(page: Any) -> None:
    if page is None:
        return
    if not TAQEEM_PRIMARY_AUTOFILL:
        return
    if not TAQEEM_PRIMARY_LOGIN_ID or not TAQEEM_PRIMARY_PASSWORD:
        return
    try:
        href = await page.evaluate("window.location.href || ''")
    except Exception:
        return
    href = (href or "").strip()
    if not should_offer_taqeem_login_assist(href):
        return
    js = primary_login_assist_js(TAQEEM_PRIMARY_LOGIN_ID, TAQEEM_PRIMARY_PASSWORD)
    try:
        await page.evaluate(js)
    except Exception:
        pass


async def ensure_taqeem_primary_login_assist(
    page: Any, attempts: int = 5, gap: float = 0.7
) -> None:
    """Retry a few times so fields exist after SSO redirects finish loading."""
    for _ in range(max(1, attempts)):
        await apply_taqeem_primary_login_assist(page)
        await asyncio.sleep(gap)

    # Final short delay in case the login DOM mounts late
    await asyncio.sleep(0.35)
    await apply_taqeem_primary_login_assist(page)
