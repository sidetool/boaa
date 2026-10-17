import json
import os
import urllib.request
from metadata_runner import read_token

request = urllib.request.Request(
    f"http://127.0.0.1:{os.environ.get('BOAA_RUNTIME_PORT', '8792')}/healthz",
    headers={"Authorization": f"Bearer {read_token()}"})
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=3) as response:
    manifest = json.load(response)
if manifest.get("schemaVersion") != 1 or manifest.get("protocolVersion") != 1 or manifest.get("status") != "ready":
    raise SystemExit(1)
