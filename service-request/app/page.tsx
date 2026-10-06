"use client";

import { useCallback, useEffect, useState } from "react";

// The browser receives only these public fields; full metadata stays server-side.
type Receiver = { id: string; assetNumber: string };

type GpsPing = {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: string;
};

export default function Home() {
  const [receiver, setReceiver] = useState<Receiver | null>(null);
  const [lookupError, setLookupError] = useState("");
  const asset = receiver?.assetNumber ?? "";
  const [requesterName, setRequesterName] = useState("");
  const [requesterPhone, setRequesterPhone] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [rigFrac, setRigFrac] = useState("");
  const [lease, setLease] = useState("");
  const [gps, setGps] = useState<GpsPing | null>(null);
  const [locationState, setLocationState] = useState<
    "idle" | "requesting" | "ready" | "error"
  >("idle");
  const [message, setMessage] = useState(
    "Allow GPS access to create this service request.",
  );
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Historical labels can supply only an asset number. Ignore their private
  // snapshots and erase those parameters from this browser history entry before
  // lookup. The server re-resolves the stable ID again when the form is submitted.
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    const key = params.has("id") ? "id" : "a";
    const value = params.get(key) ?? "";
    const query = new URLSearchParams({ [key]: value });
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    fetch(`/api/asset?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Receiver lookup unavailable.");
        if (!controller.signal.aborted) {
          setReceiver({ id: result.id, assetNumber: result.assetNumber });
          window.history.replaceState(null, "", `${window.location.pathname}?${new URLSearchParams({ id: result.id })}`);
        }
      }).catch((error) => {
        if (!controller.signal.aborted) setLookupError(error instanceof Error ? error.message : "Receiver lookup unavailable.");
      });
    return () => controller.abort();
  }, []);

  // A fresh high-accuracy browser reading requires HTTPS/localhost and permission;
  // availability and accuracy are device dependent, not server verified.
  const requestLocation = useCallback(() => {
    setFormError("");
    if (!navigator.geolocation) {
      setGps(null);
      setLocationState("error");
      setMessage("GPS location is not available on this device. Contact TanMar for help.");
      return;
    }

    setLocationState("requesting");
    setMessage("Approve the location prompt on your device.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const ping = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          capturedAt: new Date().toISOString(),
        };
        setGps(ping);
        setLocationState("ready");
        setMessage(
          `${ping.latitude.toFixed(6)}, ${ping.longitude.toFixed(6)} · accuracy ${Math.round(ping.accuracy)} m`,
        );
      },
      () => {
        setGps(null);
        setLocationState("error");
        setMessage(
          "GPS could not be captured. Allow location access and retry, or contact TanMar for help.",
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }, []);

  // Client checks help form completion but can be bypassed with a direct POST.
  // The API independently validates claims and rejects private snapshot fields.
  async function submitRequest() {
    const trimmedError = errorCode.trim();
    const trimmedOperator = operatorName.trim();
    const trimmedRigFrac = rigFrac.trim();
    const trimmedLease = lease.trim();
    const trimmedRequester = requesterName.trim();
    const trimmedPhone = requesterPhone.trim();
    if (!receiver) {
      setFormError("Scan a receiver label with an asset number.");
      return;
    }
    if (!trimmedRequester || !trimmedPhone) {
      setFormError("Enter your name and callback phone number.");
      return;
    }
    if (!trimmedOperator || !trimmedRigFrac || !trimmedLease) {
      setFormError("Enter the Operator Name, Rig/Frac, and Lease.");
      return;
    }
    if (!trimmedError) {
      setFormError("Enter the on-screen error code.");
      return;
    }
    if (!gps) {
      setFormError(
        "Location required. Share your GPS location before submitting the request.",
      );
      requestLocation();
      return;
    }

    setFormError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetId: receiver.id,
          requesterName: trimmedRequester,
          requesterPhone: trimmedPhone,
          operatorName: trimmedOperator,
          rigFrac: trimmedRigFrac,
          lease: trimmedLease,
          errorCode: trimmedError,
          latitude: gps.latitude,
          longitude: gps.longitude,
          gpsAccuracy: gps.accuracy,
          gpsCapturedAt: gps.capturedAt,
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Request was not saved.");
      setSubmitted(true);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Unable to submit the service request.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = Boolean(
    gps &&
      asset &&
      requesterName.trim() &&
      requesterPhone.trim() &&
      operatorName.trim() &&
      rigFrac.trim() &&
      lease.trim() &&
      errorCode.trim(),
  );

  return (
    <main className="request-shell">
      <section className="request-card">
        <div className="company-logo-wrap">
          <img
            className="company-logo"
            src="/tanmar-companies-logo.png"
            alt="TanMar Companies"
          />
        </div>
        <header className="brand-header">
          <img
            className="emblem"
            src="/tanmar-emblem-tight.png"
            alt="TanMar emblem"
          />
          <div>
            <p>TanMar Receiver Control</p>
            <h1>Reactivate or Refresh</h1>
          </div>
        </header>

        <section className="receiver-summary">
          <span>Asset Number</span>
          <strong>{asset || "—"}</strong>
          <p role="status">{lookupError || (receiver ? "Receiver verified." : "Checking receiver label…")}</p>
        </section>

        <section className="worksite-fields" aria-label="Requester information">
          <label htmlFor="requesterName">
            <span>Requester Name <b>*</b></span>
            <input id="requesterName" type="text" autoComplete="name" maxLength={120} required
              placeholder="Enter your name" value={requesterName}
              onChange={(event) => { setRequesterName(event.target.value); setFormError(""); }} />
          </label>
          <label htmlFor="requesterPhone">
            <span>Callback Phone Number <b>*</b></span>
            <input id="requesterPhone" type="tel" autoComplete="tel" maxLength={40} required
              placeholder="Enter your phone number" value={requesterPhone}
              onChange={(event) => { setRequesterPhone(event.target.value); setFormError(""); }} />
          </label>
        </section>

        <section className="worksite-fields" aria-label="Work site information">
          <label htmlFor="operatorName">
            <span>
              Operator Name <b>*</b>
            </span>
            <input
              id="operatorName"
              type="text"
              autoComplete="organization"
              maxLength={120}
              required
              placeholder="Enter operator name"
              value={operatorName}
              onChange={(event) => {
                setOperatorName(event.target.value);
                setFormError("");
              }}
            />
          </label>
          <div className="worksite-row">
            <label htmlFor="rigFrac">
              <span>
                Rig/Frac <b>*</b>
              </span>
              <input
                id="rigFrac"
                type="text"
                autoComplete="off"
                maxLength={120}
                required
                placeholder="Enter rig or frac"
                value={rigFrac}
                onChange={(event) => {
                  setRigFrac(event.target.value);
                  setFormError("");
                }}
              />
            </label>
            <label htmlFor="lease">
              <span>
                Lease <b>*</b>
              </span>
              <input
                id="lease"
                type="text"
                autoComplete="off"
                maxLength={120}
                required
                placeholder="Enter lease"
                value={lease}
                onChange={(event) => {
                  setLease(event.target.value);
                  setFormError("");
                }}
              />
            </label>
          </div>
        </section>

        <label className="error-field" htmlFor="errorCode">
          <span>
            On-screen error code <b>*</b>
          </span>
          <input
            id="errorCode"
            type="text"
            inputMode="text"
            autoComplete="off"
            maxLength={80}
            required
            placeholder="Enter the code shown on the TV"
            value={errorCode}
            onChange={(event) => {
              setErrorCode(event.target.value);
              setFormError("");
            }}
          />
        </label>

        <section
          className={`location-panel ${locationState}`}
          aria-live="polite"
        >
          <div className="location-icon">⌖</div>
          <div>
            <strong>
              {locationState === "ready"
                ? "GPS location captured"
                : locationState === "requesting"
                  ? "Requesting location…"
                  : "Location required"}
            </strong>
            <p>{message}</p>
          </div>
        </section>

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <div className="actions">
          <button
            className="secondary"
            type="button"
            onClick={requestLocation}
            disabled={locationState === "requesting"}
          >
            {gps ? "Refresh GPS Location" : "Share GPS Location"}
          </button>
          <button
            className="primary"
            type="button"
            onClick={submitRequest}
            disabled={!canSubmit || submitting || submitted}
          >
            {submitted
                ? "Request Submitted"
              : submitting
                ? "Submitting…"
                : "Submit Service Request"}
          </button>
        </div>

        <p className="privacy-note" role="status">
          {submitted
            ? "Request saved for TanMar staff review. This confirmation does not mean service is complete."
            : "Your contact, work site, and GPS information will be shared with TanMar staff to handle this request."}
        </p>
        <footer className="service-footer">
          <img src="/tanmar-emblem-tight.png" alt="" />
          <span>TanMar Receiver Control · DirecTV Asset Management</span>
        </footer>
      </section>
    </main>
  );
}
