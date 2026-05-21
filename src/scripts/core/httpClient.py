import asyncio
import os
from typing import Any, Dict, Optional

import httpx

# ==============================
# Configuration
# ==============================

_backend_url = (os.getenv("BACKEND_API_URL") or "").strip()
if not _backend_url:
    base = (os.getenv("BACKEND_URL") or "http://localhost:3001").rstrip("/")
    _backend_url = f"{base}/api"

BASE_API_URL = _backend_url

# ==============================
# Errors
# ==============================


class HTTPError(Exception):
    """Base HTTP error"""


class HTTPRequestFailed(HTTPError):
    def __init__(self, status_code: int, message: str, response: Any = None):
        self.status_code = status_code
        self.message = message
        self.response = response
        super().__init__(f"HTTP {status_code}: {message}")


# ==============================
# HTTP Client
# ==============================


class HttpClient:
    def __init__(
        self,
        base_url: str = BASE_API_URL,
        default_headers: Optional[Dict[str, str]] = None,
        timeout: float = 15.0,
        retries: int = 10,
    ):
        self.base_url = base_url.rstrip("/")  # normalize
        self.default_headers = default_headers or {}
        self.timeout = timeout
        self.retries = retries

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Generic async HTTP request
        """
        final_headers = {**self.default_headers, **(headers or {})}

        # Ensure relative paths work correctly
        url = url.lstrip("/")
        request_url = f"{self.base_url}/{url}"

        attempt = 0
        last_exc = None

        while attempt <= self.retries:
            try:
                async with httpx.AsyncClient(timeout=timeout or self.timeout) as client:
                    response = await client.request(
                        method=method.upper(),
                        url=request_url,
                        params=params,
                        json=json,
                        data=data,
                        headers=final_headers,
                    )

                if response.status_code >= 400:
                    raise HTTPRequestFailed(
                        status_code=response.status_code,
                        message=response.text,
                        response=response,
                    )

                try:
                    return response.json()
                except ValueError:
                    return {"raw": response.text}

            except (httpx.RequestError, HTTPRequestFailed) as exc:
                last_exc = exc
                attempt += 1
                if attempt > self.retries:
                    raise

                await asyncio.sleep(0.5 * attempt)

        raise last_exc  # defensive


# ==============================
# Shared client + helpers
# ==============================

_shared_client = HttpClient()


async def http_get(path: str, **kwargs) -> Dict[str, Any]:
    return await _shared_client.request("GET", path, **kwargs)


async def http_post(path: str, **kwargs) -> Dict[str, Any]:
    return await _shared_client.request("POST", path, **kwargs)


async def http_put(path: str, **kwargs) -> Dict[str, Any]:
    return await _shared_client.request("PUT", path, **kwargs)


async def http_patch(path: str, **kwargs) -> Dict[str, Any]:
    return await _shared_client.request("PATCH", path, **kwargs)


async def http_delete(path: str, **kwargs) -> Dict[str, Any]:
    return await _shared_client.request("DELETE", path, **kwargs)


# Add these functions to your HttpClient or create a new module


async def find_report_and_collection(report_id):
    """Replaces direct MongoDB find with API call"""
    try:
        if report_id is None:
            return None, None, None

            # Normalize to int if possible, otherwise keep as string

        normalized_id = str(report_id).strip()

        if not normalized_id:
            return None, None, None

        # Use the API endpoint instead of direct MongoDB
        response = await http_get(f"/new-scripts/report-id/{normalized_id}")

        if response.get("success"):
            return response.get("data"), response.get("collection"), None

        return None, None, None
    except Exception as e:
        print(f"[API ERROR] find_report_and_collection: {e}")
        return None, None, None


async def find_report_by_id(record_id):
    """Find report by MongoDB _id using API"""
    try:
        response = await http_get(f"/new-scripts/id/{record_id}")

        if response.get("success"):
            return response.get("data"), response.get("collection"), None

        return None, None, None
    except Exception as e:
        print(f"[API ERROR] find_report_by_id: {e}")
        return None, None, None


async def update_macro_submit_state(record_id, macro_id, submit_state):
    """Update single macro submitState using API"""
    try:
        # First find the report to get its report_id
        report_data, collection_name, _ = await find_report_by_id(record_id)
        if not report_data:
            return False

        report_id = report_data.get("report_id")

        response = await http_patch(
            f"/new-scripts/{report_id}/macro/{macro_id}/submit-state",
            json={"submitState": submit_state},
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_macro_submit_state: {e}")
        return False


async def update_multiple_macros(report_id, macro_updates):
    """Update multiple macros at once using API"""
    try:
        report_id = str(report_id).strip()
        response = await http_patch(
            f"/new-scripts/{report_id}/update-multiple-macros",
            json={"macro_updates": macro_updates},
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_multiple_macros: {e}")
        return False


async def update_assets_by_index(record_id, updates):
    """Update assets by their array index using API

    Args:
        record_id: The MongoDB _id of the report
        updates: Dict mapping index to update data, e.g. {0: {"submitState": 1}, 5: {"submitState": 0}}
                 OR list of {index, submitState} objects
    """
    try:
        # Convert dict format to array format if needed
        if isinstance(updates, dict):
            updates_array = [
                {"index": int(idx), "submitState": data["submitState"]}
                for idx, data in updates.items()
            ]
        else:
            updates_array = updates

        response = await http_patch(
            f"/new-scripts/{record_id}/update-assets-by-index",
            json={"updates": updates_array},
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_assets_by_index: {e}")
        return False


async def update_report_status_by_id(record_id, report_status):
    """Update report status using record_id"""
    try:
        response = await http_patch(
            f"/new-scripts/id/{record_id}/status", json={"report_status": report_status}
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_report_status_by_id: {e}")
        return False


async def update_report_status_by_report_id(report_id, report_status):
    """Update report status using report_id"""
    try:
        response = await http_patch(
            f"/new-scripts/{report_id}/status", json={"report_status": report_status}
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_report_status_by_report_id: {e}")
        return False


async def update_elrajhi_status(record_id, report_status, submit_state):
    """Update Elrajhi report status"""
    try:
        response = await http_patch(
            f"/new-scripts/update-elrajhi-status/{record_id}",
            json={"report_status": report_status, "submit_state": submit_state},
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_elrajhi_status: {e}")
        return False


async def set_flow_times(record_id, start_time=True, end_time=False):
    """Set flow start or end time"""
    try:
        if start_time:
            response = await http_patch(
                f"/new-scripts/set-start-time-with-id/{record_id}"
            )
        elif end_time:
            response = await http_patch(
                f"/new-scripts/set-end-time-with-id/{record_id}"
            )
        else:
            return False

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] set_flow_times: {e}")
        return False


async def update_report_timestamp(record_id, timestamp_type):
    """Update various timestamps on a report"""
    try:
        valid_types = [
            "editStartTime",
            "editEndTime",
            "retryEditStartTime",
            "retryEditEndTime",
            "flowStartTime",
            "flowEndTime",
            "startSubmitTime",
            "endSubmitTime",
        ]

        if timestamp_type not in valid_types:
            print(f"[ERROR] Invalid timestamp type: {timestamp_type}")
            return False

        response = await http_patch(
            f"/new-scripts/update-report-timestamp/{record_id}",
            json={"type": timestamp_type},
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_report_timestamp: {e}")
        return False


async def get_reports_bulk_by_id(record_ids):
    """Get multiple reports by their _id"""
    try:
        response = await http_post("/new-scripts/bulk", json={"record_ids": record_ids})

        if response.get("success"):
            return response.get("reports", [])

        return []
    except Exception as e:
        print(f"[API ERROR] get_reports_bulk_by_id: {e}")
        return []


async def get_reports_bulk_by_report_id(report_ids):
    """Get multiple reports by report_id"""
    try:
        response = await http_post(
            "/new-scripts/bulk/report_id", json={"report_ids": report_ids}
        )

        if response.get("success"):
            return response.get("reports", [])

        return []
    except Exception as e:
        print(f"[API ERROR] get_reports_bulk_by_report_id: {e}")
        return []


async def update_report_pg_count(report_id, pg_count):
    """Update report pg_count field"""
    try:
        response = await http_patch(
            f"/new-scripts/{report_id}/pg-count", json={"pg_count": int(pg_count)}
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_report_pg_count: {e}")
        return False


async def update_report_with_macro_ids(report_id, macro_ids_with_pages):
    """Update report with macro IDs and page numbers"""
    try:
        response = await http_patch(
            f"/new-scripts/{report_id}/update-macros",
            json={"macro_ids_with_pages": macro_ids_with_pages},
        )

        return response.get("success", False)
    except Exception as e:
        print(f"[API ERROR] update_report_with_macro_ids: {e}")
        return False


async def update_report_check_status(
    report_id,
    user_id=None,
    company_office_id=None,
    total_assets=None,
    remaining_assets=None,
    delete_type=None,
    deleted=False,
):
    """
    Update report deletion/check status via API
    Args:
        report_id: Report ID
        user_id: User ID (optional)
        company_office_id: Company office ID (optional)
        total_assets: Total number of assets
        remaining_assets: Remaining number of assets
        delete_type: Type of deletion (e.g., 'report', 'assets', 'check')
        deleted: Whether deletion is complete
    """
    try:
        updates = {}
        if total_assets is not None:
            updates["total_assets"] = total_assets
        if remaining_assets is not None:
            updates["remaining_assets"] = remaining_assets
        if delete_type is not None:
            updates["delete_type"] = delete_type
        if deleted is not None:
            updates["deleted"] = deleted

        # â FIX: Only update if we have actual updates to send
        if not updates:
            return True  # Nothing to update, consider it success

        payload = {
            "report_id": str(report_id),
            "updates": updates,
        }

        if user_id:
            payload["user_id"] = str(user_id)
        if company_office_id:
            payload["company_office_id"] = str(company_office_id)

        # â Add timeout and better error handling
        try:
            response = await asyncio.wait_for(
                http_patch("/new-scripts/update-check-status", json=payload),
                timeout=5.0,  # 5 second timeout
            )
            success = response.get("success", False)
            if not success:
                print(
                    f"[API] update_report_check_status returned success=False for {report_id}",
                    "WARN",
                )
            return success
        except asyncio.TimeoutError:
            print(f"[API] update_report_check_status timeout for {report_id}", "WARN")
            return False  # Don't crash, just log and continue

    except Exception as e:
        print(f"[API ERROR] update_report_check_status: {e}", "WARN")
        return False  # Don't crash the deletion process


async def recompute_report_status(report_id):
    """Recompute and update report status based on asset submitState values"""
    try:
        response = await http_patch(f"/new-scripts/{report_id}/recompute-status")

        if response.get("success"):
            return response.get("report_status")

        return None
    except Exception as e:
        print(f"[API ERROR] recompute_report_status: {e}")
        return None
