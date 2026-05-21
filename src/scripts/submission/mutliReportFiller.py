import asyncio
import json
import sys
import traceback
from datetime import datetime, timezone

from bson import ObjectId

from scripts.core.browser import spawn_new_browser
from scripts.core.company_context import (
    build_report_create_url,
    require_selected_company,
)
from scripts.core.httpClient import http_get, http_patch
from scripts.core.processControl import (
    check_and_wait,
    create_process,
    get_process_manager,
)
from scripts.core.utils import wait_for_element
from scripts.submission.validateReport import validate_for_retry

from .createMacros import run_create_assets_by_count
from .formFiller import fill_form
from .formSteps import form_steps
from .grabMacroIds import (
    get_balanced_page_distribution,
    get_macro_ids_from_page,
    update_report_pg_count,
    update_report_with_macro_ids,
)
from .macroFiller import handle_macro_edits


async def navigate_to_existing_report_assets(browser, report_id):
    asset_creation_url = f"https://qima.taqeem.gov.sa/report/asset/create/{report_id}"

    main_page = await browser.get(asset_creation_url)
    await asyncio.sleep(2)

    current_url = await main_page.evaluate("window.location.href")
    if str(report_id) not in current_url:
        return None

    return main_page


async def get_all_macro_ids_parallel(
    browser, report_id, tabs_num=3, collection_name=None
):
    try:
        if not report_id:
            print("[MACRO_ID] No report_id provided", file=sys.stderr)
            return []

        # Use provided collection_name or default
        if collection_name is None:
            collection_name = "multiapproachreports"

        base_url = f"https://qima.taqeem.gov.sa/report/{report_id}"
        main_page = browser.tabs[0]
        await main_page.get(base_url)
        await asyncio.sleep(2)

        await wait_for_element(main_page, "li", timeout=30)

        # Get total number of pages from pagination
        pagination_links = await main_page.query_selector_all("ul.pagination li a")
        page_numbers = []
        for link in pagination_links:
            text = link.text
            if text and text.strip().isdigit():
                page_numbers.append(int(text.strip()))

        total_pages = max(page_numbers) if page_numbers else 1
        print(f"[MACRO_ID] Found {total_pages} pages to scan", file=sys.stderr)
        await update_report_pg_count(report_id, total_pages)

        # Create pages for parallel processing
        pages = [main_page] + [
            await browser.get("about:blank", new_tab=True)
            for _ in range(min(tabs_num - 1, total_pages - 1))
        ]

        # Distribute pages across tabs
        page_chunks = get_balanced_page_distribution(total_pages, len(pages))
        print(
            f"[MACRO_ID] Page distribution: {[len(chunk) for chunk in page_chunks]} pages per tab",
            file=sys.stderr,
        )

        all_macro_ids_with_pages = []
        macro_ids_lock = asyncio.Lock()

        async def process_pages_chunk(page, page_numbers_chunk, tab_id):
            """Process a chunk of pages in a single tab"""
            local_macro_ids_with_pages = []
            print(
                f"[MACRO_ID-TAB-{tab_id}] Processing pages: {page_numbers_chunk}",
                file=sys.stderr,
            )

            for page_num in page_numbers_chunk:
                page_macro_ids = await get_macro_ids_from_page(
                    page, base_url, page_num, tab_id
                )
                local_macro_ids_with_pages.extend(page_macro_ids)

            async with macro_ids_lock:
                all_macro_ids_with_pages.extend(local_macro_ids_with_pages)

            print(
                f"[MACRO_ID-TAB-{tab_id}] Completed processing, found {len(local_macro_ids_with_pages)} macro IDs",
                file=sys.stderr,
            )

        # Process pages in parallel
        tasks = []
        for i, (page, chunk) in enumerate(zip(pages, page_chunks)):
            if chunk:
                tasks.append(process_pages_chunk(page, chunk, i))

        await asyncio.gather(*tasks)

        # Close extra tabs
        for p in pages[1:]:
            await p.close()

        print(
            f"[MACRO_ID] ID collection complete. Found {len(all_macro_ids_with_pages)} macro IDs",
            file=sys.stderr,
        )

        if all_macro_ids_with_pages:
            # Use provided collection_name or try to detect it
            if collection_name is None:
                collection_name = "multiapproachreports"  # Default fallback

            success = await update_report_with_macro_ids(
                report_id, all_macro_ids_with_pages
            )
            if success:
                print(
                    f"[MACRO_ID] Successfully updated report in MongoDB",
                    file=sys.stderr,
                )
            else:
                print(f"[MACRO_ID] Failed to update report in MongoDB", file=sys.stderr)

        return {"status": "SUCCESS", "macro_ids_with_pages": all_macro_ids_with_pages}

    except Exception as e:
        print(
            f"[MACRO_ID] Error in get_all_macro_ids_parallel: {str(e)}", file=sys.stderr
        )
        import traceback

        traceback.print_exc()
        return []


async def find_record_in_collections(id, collection_names):
    """Try to find a record in multiple collections, return (record, collection) or (None, None)"""
    record_data = await http_get(f"new-scripts/id/{id}")
    print("record_data", record_data)
    record = record_data.get("data")
    if record:
        return record, record_data.get("collection") or "multiapproachreports"
    return None, None


def normalize_process_id(value):
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def ensure_submission_process(process_id, tabs_num=3):
    normalized_id = normalize_process_id(process_id)
    if not normalized_id:
        return None

    process_manager = get_process_manager()
    state = process_manager.get_process(normalized_id)
    if state is None:
        state = create_process(
            process_id=normalized_id,
            process_type="submit-report-quickly",
            total=100,
            report_id=normalized_id,
            tabs_num=tabs_num,
        )
    elif not state.total:
        state.total = 100
    return state


def sync_process_percentage(process_id, percentage):
    normalized_id = normalize_process_id(process_id)
    if not normalized_id:
        return

    process_manager = get_process_manager()
    state = process_manager.get_process(normalized_id)
    if not state:
        return

    clamped_percentage = max(0.0, min(100.0, float(percentage or 0)))
    state.total = 100
    state.completed = int(round(clamped_percentage))
    state.updated_at = datetime.utcnow()


def get_process_percentage(process_id, fallback=0):
    normalized_id = normalize_process_id(process_id)
    if not normalized_id:
        return fallback

    process_manager = get_process_manager()
    state = process_manager.get_process(normalized_id)
    if not state:
        return fallback

    return state.get_percentage()


async def check_submission_control(process_id, message, step=None):
    normalized_id = normalize_process_id(process_id)
    if not normalized_id:
        return None

    action = await check_and_wait(normalized_id)
    if action != "stop":
        return None

    result = {
        "status": "STOPPED",
        "message": message,
    }
    if step:
        result["step"] = step
    return result


def emit_progress_update(
    record_id, percentage, message, status="processing", created_report_id=None
):
    """Emit progress update to stdout for frontend to receive"""
    sync_process_percentage(record_id, percentage)

    progress_data = {
        "type": "progress",
        "processId": str(record_id),
        "reportId": str(record_id),
        "percentage": percentage,
        "message": message,
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if created_report_id:
        progress_data["createdReportId"] = str(created_report_id)
    print(json.dumps(progress_data), flush=True)


async def create_report_for_record(
    browser, record, tabs_num=3, collection=None, process_id=None
):
    try:
        if not record or "_id" not in record:
            return {"status": "FAILED", "error": "Invalid record object (missing _id)"}

        record_id = str(record["_id"])
        control_process_id = normalize_process_id(process_id)
        if control_process_id:
            ensure_submission_process(control_process_id, tabs_num=tabs_num)

        asset_count = len(record.get("asset_data", []))
        form_id = None

        # Calculate progress increments
        # 10% for report creation, 5% for asset creation, 85% for asset filling
        REPORT_CREATE_PERCENT = 10
        ASSET_CREATE_PERCENT = 5
        ASSET_FILL_BASE = 85
        asset_fill_increment = ASSET_FILL_BASE / asset_count if asset_count > 0 else 0

        # Determine which collection this record belongs to if not provided
        if collection is None:
            collection_names = [
                "multiapproachreports",
                "submitreportsquicklies",
                "submitreportsquickly",
            ]
            _, collection = await find_record_in_collections(
                record["_id"], collection_names
            )

        try:
            require_selected_company()
            create_url = build_report_create_url()
        except Exception as ctx_err:
            return {"status": "FAILED", "error": str(ctx_err)}

        # Mark start time
        await http_patch(
            f"new-scripts/update-report-timestamp/{record['_id']}",
            json={"type": "startSubmitTime"},
        )

        emit_progress_update(
            record_id, 0, "Starting report submission...", "processing"
        )

        stop_result = await check_submission_control(
            control_process_id,
            "Report submission stopped by user before filling the form.",
            step="start",
        )
        if stop_result:
            emit_progress_update(
                record_id,
                get_process_percentage(control_process_id, 0),
                stop_result["message"],
                "stopped",
            )
            await http_patch(
                f"new-scripts/update-report-timestamp/{record['_id']}",
                json={"type": "endSubmitTime"},
            )
            return stop_result

        results = []
        record["number_of_macros"] = str(asset_count)

        # Normalize valuers to shape expected by fill_valuers (valuerName/percentage)
        valuers = []
        for v in record.get("valuers", []):
            name = v.get("valuer_name") or v.get("valuerName")
            pct = v.get("contribution_percentage") or v.get("percentage")
            if name:
                valuers.append({"valuerName": name, "percentage": pct or 0})
        record["valuers"] = valuers

        emit_progress_update(
            record_id,
            1,
            "Opening Taqeem report creation page...",
            "processing",
        )

        # Open the initial create-report page. If Taqeem does not respond, fail
        # the command instead of leaving the renderer stuck in a loading state.
        try:
            main_page = await asyncio.wait_for(browser.get(create_url), timeout=90)
        except asyncio.TimeoutError:
            await http_patch(
                f"new-scripts/update-report-timestamp/{record['_id']}",
                json={"type": "endSubmitTime"},
            )
            return {
                "status": "FAILED",
                "error": "Timed out opening Taqeem report creation page.",
            }
        await asyncio.sleep(1)

        # Track if assets were created in step 2
        assets_created_in_step2 = False

        for step_num, step_config in enumerate(form_steps, 1):
            is_last = step_num == len(form_steps)

            stop_result = await check_submission_control(
                control_process_id,
                f"Report submission stopped by user before step {step_num}.",
                step=f"step_{step_num}",
            )
            if stop_result:
                emit_progress_update(
                    record_id,
                    get_process_percentage(control_process_id, 0),
                    stop_result["message"],
                    "stopped",
                )
                await http_patch(
                    f"new-scripts/update-report-timestamp/{record['_id']}",
                    json={"type": "endSubmitTime"},
                )
                return stop_result

            results.append(
                {
                    "status": "STEP_STARTED",
                    "step": step_num,
                    "recordId": str(record["_id"]),
                }
            )

            if step_num == 2 and len(record.get("asset_data", [])) > 10:
                # Create assets with progress tracking
                result = await run_create_assets_by_count(
                    browser,
                    len(record.get("asset_data")),
                    tabs_num=tabs_num,
                    batch_size=10,
                )
                # Mark that assets were created
                if not isinstance(result, dict) or result.get("status") != "FAILED":
                    assets_created_in_step2 = True
            else:
                result = await fill_form(
                    main_page,
                    record,
                    step_config["field_map"],
                    step_config["field_types"],
                    is_last,
                    is_valuers=step_config.get("is_valuers_step", False)
                    and bool(record.get("valuers")),
                )

            if isinstance(result, dict) and result.get("status") == "FAILED":
                results.append(
                    {
                        "status": "FAILED",
                        "step": step_num,
                        "recordId": str(record["_id"]),
                        "error": result.get("error"),
                    }
                )

                # Mark end time even on failure
                await http_patch(
                    f"new-scripts/update-report-timestamp/{record['_id']}",
                    json={"type": "endSubmitTime"},
                )
                return {"status": "FAILED", "results": results}

            if is_last:
                main_url = await main_page.evaluate("window.location.href")
                form_id = main_url.split("/")[-1]
                if not form_id:
                    results.append(
                        {
                            "status": "FAILED",
                            "step": "report_id",
                            "recordId": str(record["_id"]),
                            "error": "Could not determine report_id",
                        }
                    )

                    await http_patch(
                        f"new-scripts/update-report-timestamp/{record['_id']}",
                        json={"type": "endSubmitTime"},
                    )
                    emit_progress_update(
                        record_id, 0, "Failed to create report", "error"
                    )
                    return {"status": "FAILED", "results": results}

                # Save report_id on document - Update instantly
                await http_patch(
                    f"new-scripts/{record['_id']}/set-report-id",
                    json={"report_id": form_id},
                )

                record["report_id"] = form_id

                # Calculate progress: 10% for report creation, +5% if assets already created = 15%
                if assets_created_in_step2:
                    # Assets were created in step 2, so we're at 15% total
                    current_progress = REPORT_CREATE_PERCENT + ASSET_CREATE_PERCENT
                    emit_progress_update(
                        record_id,
                        current_progress,
                        f"Report created: {form_id}",
                        "processing",
                        created_report_id=form_id,
                    )
                else:
                    # Assets will be created via fill_form, so we're at 10%
                    emit_progress_update(
                        record_id,
                        REPORT_CREATE_PERCENT,
                        f"Report created: {form_id}",
                        "processing",
                        created_report_id=form_id,
                    )

                # Determine collection name for macro ID update

                coll_name = "multiapproachreports"

                # Get macro IDs - Keep progress at 15% (or 10% if assets not created yet)
                # Preserve current progress percentage and message
                current_progress_before_macro_ids = (
                    REPORT_CREATE_PERCENT + ASSET_CREATE_PERCENT
                    if assets_created_in_step2
                    else REPORT_CREATE_PERCENT
                )
                current_message_before_macro_ids = f"Report created: {form_id}"

                # Emit progress to maintain 15% (or 10%) while getting macro IDs
                emit_progress_update(
                    record_id,
                    current_progress_before_macro_ids,
                    current_message_before_macro_ids,
                    "processing",
                )

                stop_result = await check_submission_control(
                    control_process_id,
                    "Report submission stopped by user before grabbing macro IDs.",
                    step="macro_ids",
                )
                if stop_result:
                    emit_progress_update(
                        record_id,
                        current_progress_before_macro_ids,
                        stop_result["message"],
                        "stopped",
                        created_report_id=form_id,
                    )
                    await http_patch(
                        f"new-scripts/update-report-timestamp/{record['_id']}",
                        json={"type": "endSubmitTime"},
                    )
                    return stop_result

                macro_ids_result = await get_all_macro_ids_parallel(
                    browser, form_id, tabs_num=tabs_num, collection_name=coll_name
                )
                if (
                    isinstance(macro_ids_result, dict)
                    and macro_ids_result.get("status") == "FAILED"
                ):
                    results.append(
                        {
                            "status": "FAILED",
                            "step": "macro_ids",
                            "recordId": str(record["_id"]),
                            "error": macro_ids_result.get("error"),
                        }
                    )

                    await http_patch(
                        f"new-scripts/update-report-timestamp/{record['_id']}",
                        json={"type": "endSubmitTime"},
                    )
                    return {"status": "FAILED", "results": results}

                # Reload record from database to get updated macro IDs
                # Save the original record ID before reloading
                original_record_id = record.get("_id") if record else None
                record_data = await http_get(f"new-scripts/report-id/{form_id}")
                record = record_data.get("data")
                if not record:
                    results.append(
                        {
                            "status": "FAILED",
                            "step": "macro_ids",
                            "recordId": str(original_record_id)
                            if original_record_id
                            else form_id,
                            "error": "Could not reload record after macro ID update",
                        }
                    )
                    # Try to update using form_id if we have it
                    await http_patch(
                        f"new-scripts/update-report-timestamp/{original_record_id}",
                        json={"type": "endSubmitTime"},
                    )
                    return {"status": "FAILED", "results": results}

                # After getting macro IDs, maintain 15% (or 10%) progress with report created message
                # This ensures progress doesn't reset when navigating to report page
                emit_progress_update(
                    record_id,
                    current_progress_before_macro_ids,
                    current_message_before_macro_ids,
                    "processing",
                )

                stop_result = await check_submission_control(
                    control_process_id,
                    "Report submission stopped by user before filling assets.",
                    step="macro_edit",
                )
                if stop_result:
                    emit_progress_update(
                        record_id,
                        current_progress_before_macro_ids,
                        stop_result["message"],
                        "stopped",
                        created_report_id=form_id,
                    )
                    await http_patch(
                        f"new-scripts/update-report-timestamp/{record['_id']}",
                        json={"type": "endSubmitTime"},
                    )
                    return stop_result

                # Handle macro edits with progress tracking
                # Calculate base progress (report + assets = 15% if assets created, otherwise 10%)
                base_progress = (
                    REPORT_CREATE_PERCENT + ASSET_CREATE_PERCENT
                    if assets_created_in_step2
                    else REPORT_CREATE_PERCENT
                )

                # Custom progress callback that maps macro filling (0-100%) to 15-100% range
                def progress_callback(completed, total):
                    if total == 0:
                        return
                    # Map completed/total (0-1) to 15-100% range
                    fill_progress = base_progress + (
                        ASSET_FILL_BASE * completed / total
                    )
                    emit_progress_update(
                        record_id,
                        fill_progress,
                        f"Filling assets: {completed}/{total}",
                        "processing",
                    )

                macro_result = await handle_macro_edits(
                    browser,
                    record,
                    tabs_num=tabs_num,
                    record_id=record_id,
                    progress_callback=progress_callback,
                    initialize_process=not bool(control_process_id),
                    clear_process_on_exit=not bool(control_process_id),
                    emit_internal_progress=not bool(control_process_id),
                )
                if (
                    isinstance(macro_result, dict)
                    and macro_result.get("status") == "FAILED"
                ):
                    results.append(
                        {
                            "status": "FAILED",
                            "step": "macro_edit",
                            "recordId": str(record["_id"]),
                            "error": macro_result.get("error"),
                        }
                    )

                    await http_patch(
                        f"new-scripts/update-report-timestamp/{record['_id']}",
                        json={"type": "endSubmitTime"},
                    )
                    return {"status": "FAILED", "results": results}

                if (
                    isinstance(macro_result, dict)
                    and macro_result.get("status") == "STOPPED"
                ):
                    await http_patch(
                        f"new-scripts/update-report-timestamp/{record['_id']}",
                        json={"type": "endSubmitTime"},
                    )
                    emit_progress_update(
                        record_id,
                        max(
                            current_progress_before_macro_ids,
                            base_progress,
                        ),
                        macro_result.get(
                            "message", "Report submission stopped by user."
                        ),
                        "stopped",
                        created_report_id=form_id,
                    )
                    return {
                        "status": "STOPPED",
                        "message": macro_result.get(
                            "message", "Report submission stopped by user."
                        ),
                        "reportId": form_id,
                        "results": results,
                    }

                results.append(
                    {
                        "status": "MACRO_EDIT_SUCCESS",
                        "message": "All macros filled",
                        "recordId": str(record["_id"]),
                    }
                )

        # Mark successful end time
        await http_patch(
            f"new-scripts/update-report-timestamp/{record['_id']}",
            json={"type": "endSubmitTime"},
        )

        emit_progress_update(
            record_id,
            100,
            "Report completed successfully",
            "completed",
            created_report_id=form_id,
        )

        return {"status": "SUCCESS", "reportId": form_id, "results": results}

    except Exception as e:
        tb = traceback.format_exc()
        # Mark end time even on unexpected exception
        # Determine collection for error handling if not already set
        if record and "_id" in record:
            if collection is None:
                collection_names = [
                    "multiapproachreports",
                    "submitreportsquicklies",
                    "submitreportsquickly",
                ]
                _, collection = await find_record_in_collections(
                    record["_id"], collection_names
                )

        return {"status": "FAILED", "error": str(e), "traceback": tb}


async def create_new_report(browser, record_id, tabs_num=3):
    try:
        # Convert record_id to string if needed
        record_id_str = str(record_id).strip()
        ensure_submission_process(record_id_str, tabs_num=tabs_num)
        emit_progress_update(
            record_id_str,
            0,
            "Preparing report submission session...",
            "starting",
        )

        stop_result = await check_submission_control(
            record_id_str,
            "Report submission stopped by user before initialization.",
            step="initialize",
        )
        if stop_result:
            emit_progress_update(
                record_id_str,
                get_process_percentage(record_id_str, 0),
                stop_result["message"],
                "stopped",
            )
            return stop_result

        if not ObjectId.is_valid(record_id_str):
            return {
                "status": "FAILED",
                "error": f"Invalid record_id format: {record_id_str}",
            }

        record_id_obj = ObjectId(record_id_str)

        # Try to find record in all possible collections
        # Order: multiapproachreports, submitreportsquicklies (plural - Mongoose default), submitreportsquickly (singular)
        collection_names = [
            "multiapproachreports",
            "submitreportsquicklies",  # Mongoose pluralizes: SubmitReportsQuickly -> submitreportsquicklies
            "submitreportsquickly",  # Fallback in case custom collection name is used
        ]

        record, collection = await find_record_in_collections(
            record_id_obj, collection_names
        )

        return await create_report_for_record(
            browser,
            record,
            tabs_num=tabs_num,
            collection=collection,
            process_id=record_id_str,
        )

    except Exception as e:
        return {
            "status": "FAILED",
            "error": f"Error finding record: {str(e)}",
            "traceback": traceback.format_exc(),
        }


async def retry_create_new_report(browser, record_id, tabs_num=3):
    """Retry creating a report by only processing assets with submitState == 0"""
    try:
        # Convert record_id to string if needed
        record_id_str = str(record_id).strip()

        if not ObjectId.is_valid(record_id_str):
            return {
                "status": "FAILED",
                "error": f"Invalid record_id format: {record_id_str}",
            }

        record_id_obj = ObjectId(record_id_str)

        # Try to find record in all possible collections
        collection_names = [
            "multawdawdiapproacfesfeshrepfesfesorts",
            "sufesfesfbmitreportsquicawdwaies",
            "duawdawdfpfesicatereposefesfesrts",
            "suawdebmitrepasdaortssefsefquickly",
        ]

        record, collection = await find_record_in_collections(
            record_id_obj, collection_names
        )

        if not record:
            return {
                "status": "FAILED",
                "error": f"Record not found with id: {record_id_str}",
            }

        # Check if report_id exists (report must have been created already)
        report_id = record.get("report_id")

        if not report_id:
            return {
                "status": "FAILED",
                "error": "No report_id found. Use create_new_report instead of retry.",
            }

        asset_data = record.get("asset_data", [])
        if not asset_data:
            return {"status": "SUCCESS", "message": "No assets found"}

        # Filter retryable assets (submitState == 0)
        validation_result = await validate_for_retry(browser, report_id, asset_data)

        if validation_result["status"] == "RE-GRABBED":
            record, collection = await find_record_in_collections(
                record_id_obj, collection_names
            )
            asset_data = record.get("asset_data", [])

        elif validation_result["status"] == "FAILED":
            return {"status": "FAILED", "message": "Validation failed"}

        retry_assets = [
            asset for asset in asset_data if asset.get("submitState", 0) == 0
        ]

        if not retry_assets:
            return {
                "status": "SUCCESS",
                "message": "No retryable assets found (all macros already submitted)",
            }

        # Verify IDs
        missing_ids = [i for i, asset in enumerate(retry_assets) if not asset.get("id")]
        if missing_ids:
            return {
                "status": "FAILED",
                "error": f"Retry assets missing macro IDs at indices: {missing_ids}",
            }

        # Update retry start time
        await http_patch(
            f"new-scripts/update-report-timestamp/{record_id_str}",
            json={"type": "retryEditStartTime"},
        )

        emit_progress_update(
            record_id_str,
            0,
            f"Starting retry for {len(retry_assets)} macros...",
            "processing",
        )

        # Create a shallow copy of record with filtered assets
        retry_record = {**record, "asset_data": retry_assets}

        # Calculate base progress (report already created = 15%)
        base_progress = 15
        asset_fill_base = 85
        total_assets = len(retry_assets)

        # Custom progress callback for retry
        def progress_callback(completed, total):
            if total == 0:
                return
            fill_progress = base_progress + (asset_fill_base * completed / total)
            emit_progress_update(
                record_id_str,
                fill_progress,
                f"Retrying assets: {completed}/{total}",
                "processing",
            )

        # Process retry assets using handle_macro_edits
        result = await handle_macro_edits(
            browser,
            retry_record,
            tabs_num=tabs_num,
            record_id=record_id_str,
            progress_callback=progress_callback,
        )

        # Update retry end time
        await http_patch(
            f"new-scripts/update-report-timestamp/{record_id_str}",
            json={"type": "retryEditEndTime"},
        )

        # Emit completion message
        if result.get("status") == "SUCCESS":
            emit_progress_update(
                record_id_str,
                100,
                f"Retry completed: {result.get('completed', 0)}/{total_assets} macros filled",
                "completed",
            )
        else:
            emit_progress_update(
                record_id_str,
                0,
                f"Retry failed: {result.get('error', 'Unknown error')}",
                "error",
            )

        return result

    except Exception as e:
        # Clear process state on error
        from scripts.core.processControl import clear_process

        clear_process(record_id_str)

        return {
            "status": "FAILED",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }


async def create_reports_by_batch(browser, batch_id, tabs_num=3):
    new_browser = None
    try:
        if not batch_id:
            return {"status": "FAILED", "error": "Missing batch_id"}

        record_data = await http_get(f"/new-scripts/batch/{batch_id}")
        records = record_data.get("reports", [])

        if not records:
            return {
                "status": "FAILED",
                "error": f"No records found for batch_id: {batch_id}",
            }

        total_records = len(records)
        batch_results = {
            "batch_id": batch_id,
            "totalRecords": total_records,
            "successCount": 0,
            "failureCount": 0,
            "records": [],
        }
        created_report_ids = []

        # Emit initial progress
        emit_batch_progress(
            batch_id,
            0,
            total_records,
            0,
            f"Starting batch with {total_records} reports...",
            "processing",
        )

        new_browser = await spawn_new_browser(browser)

        for index, record in enumerate(records):
            record_id_str = str(record["_id"])
            try:
                # Emit progress for current report
                emit_batch_progress(
                    batch_id,
                    index,
                    total_records,
                    (index / total_records) * 100,
                    f"Processing report {index + 1}/{total_records}: {record_id_str[:8]}...",
                    "processing",
                    current_record_id=record_id_str,
                )

                result = await create_report_for_record(
                    browser=new_browser, record=record, tabs_num=tabs_num
                )

                if result.get("status") == "SUCCESS":
                    batch_results["successCount"] += 1
                    report_id = result.get("reportId") or result.get("report_id")
                    if report_id:
                        created_report_ids.append(str(report_id))
                    emit_batch_progress(
                        batch_id,
                        index + 1,
                        total_records,
                        ((index + 1) / total_records) * 100,
                        f"Completed {index + 1}/{total_records} reports",
                        "processing",
                        current_record_id=record_id_str,
                    )
                else:
                    batch_results["failureCount"] += 1

                record_entry = {"recordId": record_id_str, "result": result}
                batch_results["records"].append(record_entry)

            except Exception as record_err:
                batch_results["failureCount"] += 1
                batch_results["records"].append(
                    {
                        "recordId": record_id_str,
                        "status": "FAILED",
                        "error": str(record_err),
                        "traceback": traceback.format_exc(),
                    }
                )

        batch_results["reportIds"] = list(dict.fromkeys(created_report_ids))
        batch_results["status"] = (
            "SUCCESS" if batch_results["failureCount"] == 0 else "PARTIAL_SUCCESS"
        )

        # Emit completion
        emit_batch_progress(
            batch_id,
            total_records,
            total_records,
            100,
            f"Batch complete: {batch_results['successCount']} succeeded, {batch_results['failureCount']} failed",
            "completed" if batch_results["failureCount"] == 0 else "partial",
        )

        return batch_results

    except Exception as e:
        emit_batch_progress(batch_id, 0, 0, 0, f"Batch failed: {str(e)}", "error")
        return {
            "status": "FAILED",
            "batch_id": batch_id,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }

    finally:
        if new_browser:
            new_browser.stop()


def emit_batch_progress(
    batch_id,
    current,
    total,
    percentage,
    message,
    status="processing",
    current_record_id=None,
):
    """Emit batch progress update to stdout for frontend to receive"""
    progress_data = {
        "type": "progress",  # Changed from "batch-progress" to "progress"
        "processId": str(batch_id),
        "batchId": str(batch_id),
        "reportId": str(batch_id),  # Add reportId for compatibility
        "current": current,
        "total": total,
        "percentage": percentage,
        "message": message,
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "processType": "batch_creation",  # Add processType to distinguish
    }
    if current_record_id:
        progress_data["currentRecordId"] = str(current_record_id)
    print(json.dumps(progress_data), flush=True)
