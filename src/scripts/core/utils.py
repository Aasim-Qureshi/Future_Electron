import time, asyncio

async def wait_for_element(page, selector, timeout=30, check_interval=1):
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            element = await page.query_selector(selector)
            if element:
                return element
        except Exception:
            pass
        await asyncio.sleep(check_interval)
    return None

async def wait_for_table_rows(page, timeout=100):
    """Wait for table to have valid data rows"""
    start_time = asyncio.get_event_loop().time()
    
    while (asyncio.get_event_loop().time() - start_time) < timeout:
        try:
            # Method 1: Check if we can directly find valid macro cells
            macro_cells = await page.query_selector_all("#m-table tbody tr td:nth-child(1) a")
            
            for cell in macro_cells:
                cell_text = cell.text
                if cell_text and cell_text.strip().isdigit():
                    return True  # Found at least one valid macro ID
                    
            # Method 2: If no valid cells found, wait and retry
            await asyncio.sleep(0.5)
            
        except Exception as e:
            # If anything fails, just wait and retry
            await asyncio.sleep(0.5)
            continue
    
    return False