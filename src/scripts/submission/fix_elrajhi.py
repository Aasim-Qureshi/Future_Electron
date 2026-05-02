"""
One-off maintenance: patches ElRajhiFiller.py if legacy blocks match.
Not used by the worker at runtime — run manually only when needed:
  python fix_elrajhi.py
"""
import re
from pathlib import Path

file_path = Path(__file__).resolve().parent / "ElRajhiFiller.py"

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

pattern_1 = re.compile(
    r'( +)if finalization_result\.get\(\"status\"\) == \"SUCCESS\":\s+(finalized_reports \+= 1)\s+else:\s+(finalization_failed \+= 1)'
)

replacement_1 = r"""\1if finalization_result.get("status") == "SUCCESS":
\1    \2
\1    try:
\1        await http_patch(
\1            f"/new-scripts/update-elrajhi-status/{macro_info['record_id']}",
\1            json={"submit_state": 1, "report_status": "COMPLETE"}
\1        )
\1    except Exception as e:
\1        log(f"Failed to update DB state after finalization for {macro_info['record_id']}: {e}", "WARN")
\1else:
\1    \3"""

content = pattern_1.sub(replacement_1, content)

pattern_2 = re.compile(
    r'( +)if fin\[\"status\"\] == \"SUCCESS\":\s+(finalized_reports \+= 1)\s+else:\s+(finalization_failed \+= 1)'
)

replacement_2 = r"""\1if fin["status"] == "SUCCESS":
\1    \2
\1    try:
\1        await http_patch(
\1            f"/new-scripts/update-elrajhi-status/{m['record_id']}",
\1            json={"submit_state": 1, "report_status": "COMPLETE"}
\1        )
\1    except Exception as e:
\1        log(f"Failed to update DB state after finalization for {m['record_id']}: {e}", "WARN")
\1else:
\1    \3"""

content = pattern_2.sub(replacement_2, content)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)
print("File updated successfully.")
