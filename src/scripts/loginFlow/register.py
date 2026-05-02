import asyncio
import json
import os
import traceback

import aiohttp


async def register_user(user_data):
    try:
        # Allow multiple backend candidates. Prefer explicit BACKEND_URL, then localhost.
        env_url = os.getenv("BACKEND_URL")
        candidates = []
        if env_url:
            candidates.append(env_url.rstrip("/"))
        # common local dev addresses
        candidates.extend(
            [
                "http://localhost:3000",
                "http://127.0.0.1:3000",
            ]
        )

        async with aiohttp.ClientSession() as session:
            last_error = None
            for base in candidates:
                url = f"{base}/api/users/register"
                try:
                    async with session.post(
                        url, json=user_data, timeout=aiohttp.ClientTimeout(total=50)
                    ) as response:
                        # Successful creation
                        if response.status in (200, 201):
                            data = await response.json()
                            return {
                                "status": "SUCCESS",
                                "message": "User registered successfully",
                                "data": data,
                            }

                        # Known client errors
                        if response.status == 400:
                            try:
                                data = await response.json()
                                err_msg = (
                                    data.get("message")
                                    or data.get("error")
                                    or "Invalid registration data"
                                )
                            except Exception:
                                err_msg = "Invalid registration data"
                            return {"status": "ERROR", "error": err_msg}

                        if response.status == 409:
                            return {"status": "ERROR", "error": "User already exists"}

                        # If 404, try next candidate
                        if response.status == 404:
                            last_error = f"404 from {url}"
                            continue

                        # Other server errors: return the message
                        try:
                            data = await response.json()
                            msg = (
                                data.get("message")
                                or data.get("error")
                                or f"Status {response.status}"
                            )
                        except Exception:
                            msg = f"Status {response.status}"
                        return {
                            "status": "ERROR",
                            "error": f"Registration failed: {msg}",
                        }

                except asyncio.TimeoutError:
                    last_error = f"Timeout while contacting {url}"
                    continue
                except Exception as e:
                    last_error = f"Error contacting {url}: {str(e)}"
                    continue

            # If we exhausted candidates
            return {
                "status": "ERROR",
                "error": f"Registration failed; no reachable backend. Last error: {last_error}",
            }
    except asyncio.TimeoutError:
        return {"status": "ERROR", "error": "Registration request timed out"}
    except Exception as e:
        tb = traceback.format_exc()
        return {"status": "ERROR", "error": str(e), "traceback": tb}
