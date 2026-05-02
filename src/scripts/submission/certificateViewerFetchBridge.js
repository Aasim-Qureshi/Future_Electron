/**
 * Reference implementation mirrored in Python (registrationCertificateDownloader._page_eval_fetch_url_once).
 * Chromium + nodriver: evaluate() with awaitPromise often returns RemoteObject unless the result is a JSON string.
 * Always return JSON.stringify({ ... }) and parse in Python with json.loads.
 */
async function vtRegistrationFetchAsJsonString(url, headers) {
  try {
    const r = await fetch(url, { credentials: "include", headers: headers || {} });
    const status = r.status || 0;
    const ct = r.headers.get("content-type") || "";
    const disp = r.headers.get("content-disposition") || "";
    const ab = await r.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let binary = "";
    const cs = 0x8000;
    for (let i = 0; i < bytes.length; i += cs) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + cs));
    }
    return JSON.stringify({
      ok: Boolean(status && status < 400 && binary.length > 0),
      status,
      base64: btoa(binary),
      contentType: ct,
      disposition: disp,
      error: "",
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      status: 0,
      base64: "",
      contentType: "",
      disposition: "",
      error: String(e || "fetch_failed"),
    });
  }
}
