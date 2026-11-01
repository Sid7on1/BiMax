import React, { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { copyText } from '../copy.text';
import type { MobileApi, MobileResult, MobileStatus } from '../../../shared/mobile';

/** Connection controls belong to Desktop; opening Settings never enables a listener. */
export function MobileSettings({
  api = typeof window === 'undefined' ? undefined : window.bimax.mobile,
}: {
  api?: MobileApi;
}): React.ReactElement {
  const [status, setStatus] = useState<MobileStatus>();
  const [address, setAddress] = useState('');
  const [advert, setAdvert] = useState<string | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const owner = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const generation = ++owner.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!api) return;
      try {
        const next = await api.status();
        if (owner.current !== generation) return;
        if (!next) throw new Error('Phone settings are unavailable. Restart the current Bimax build.');
        setStatus(next);
        setAddress((current) =>
          next.enabled
            ? (next.address ?? '')
            : next.addresses.some((item) => item.address === current)
              ? current
              : (next.addresses[0]?.address ?? ''),
        );
        const data = next.enabled && !next.paired && !next.halted ? await api.advertisement() : null;
        if (owner.current === generation) setAdvert(data);
      } catch (reason) {
        if (owner.current === generation)
          setError(reason instanceof Error ? reason.message : 'Could not read phone settings.');
      }
    };
    refresh.current = read;
    const poll = async () => {
      await read();
      if (owner.current === generation) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      owner.current++;
      clearTimeout(timer);
    };
  }, [api]);
  const qr = useMemo(() => {
    if (!advert) return null;
    try {
      const image = qrcode(0, 'M');
      image.addData(advert);
      image.make();
      return image.createDataURL(5, 4);
    } catch {
      return null;
    }
  }, [advert]);
  const act = async (action: () => Promise<MobileResult>) => {
    const generation = owner.current;
    setPending(true);
    setError('');
    try {
      const result = await action();
      if (owner.current !== generation) return;
      if (!result?.ok) throw new Error(result?.error || 'The request did not complete.');
      await refresh.current();
    } catch (reason) {
      if (owner.current === generation) setError(reason instanceof Error ? reason.message : 'The request failed.');
    } finally {
      if (owner.current === generation) setPending(false);
    }
  };
  if (!api)
    return (
      <p className="settings-note" role="status">
        Phone connection is unavailable in this build.
      </p>
    );
  const disabled = pending || status?.busy;
  return (
    <div className="mobile-settings">
      <section className="settings-note">
        <div>
          <h3>Connect your phone</h3>
          <p>
            Pair once on the same network. Your trusted phone can then read and continue chats while this Mac is awake, including from another network.
          </p>
          <p>Pairing authorizes your phone. Ordinary chats need no Mac approval. Tool decisions appear on your phone. Stop access here or from the Phone menu in the menu bar.</p>
        </div>
      </section>
      <p role="status" className="mobile-status">
        {!status
          ? 'Reading connection status…'
          : status.halted
            ? 'Remote access stopped — restart Bimax to enable it again.'
            : !status.enabled
              ? 'Phone connection is off.'
              : status.phoneConnected
                ? 'Phone connected.'
                : status.paired
                  ? 'Phone paired · waiting for it to reconnect.'
                  : status.relayStatus === 'online'
                    ? 'Ready to pair your phone.'
                    : 'Starting the phone connection…'}
      </p>
      {status?.paired && <p className="settings-note">{status.cloudReady ? 'Connect from anywhere is ready.' : status.cloudStatus==='connecting' || status.cloudStatus==='reconnecting' ? 'Connecting to the secure relay…' : 'Open Bimax on your paired phone to finish connecting from anywhere.'}</p>}
      {error || status?.error ? (
        <p role="alert" className="mobile-error">
          {error || status?.error}
        </p>
      ) : null}
      {status && !status.enabled && !status.halted ? (
        <section className="mobile-controls">
          <label htmlFor="mobile-address">Mac network address</label>
          <select
            id="mobile-address"
            value={address}
            disabled={disabled}
            onChange={(event) => setAddress(event.target.value)}
            className="settings-select"
          >
            {!status.addresses.length ? (
              <option value="">No private network available</option>
            ) : (
              status.addresses.map((item) => (
                <option key={item.address} value={item.address}>
                  {item.address} · {item.name}
                </option>
              ))
            )}
          </select>
          <p className="text-dim">
            Choose the address on the same network as your phone. Guest Wi-Fi or a VPN may block device connections.
          </p>
          <button
            className="mobile-primary pressable"
            disabled={disabled || !address}
            onClick={() => void act(() => api.enable(address))}
          >
            Enable phone connection
          </button>
        </section>
      ) : null}
      {status?.enabled || pending || status?.busy ? (
        <div className="mobile-actions">
          {status?.enabled ? (
            <button
              disabled={disabled}
              className="mobile-secondary pressable"
              onClick={() => void act(() => api.disable())}
            >
              Disable connection
            </button>
          ) : null}
          <button className="mobile-danger pressable" onClick={() => void act(() => api.stop())}>
            Stop remote access
          </button>
        </div>
      ) : null}
      {status?.enabled ? (
        <>
          {status.paired ? (
            <section className="settings-note">
              <div>
                <h3>Paired phone</h3>
                <p className="mobile-device">{status.phoneId}</p>
                <p>
                  Open Remote in the Bimax phone app to reconnect. Forgetting it stops remote work and requires a new
                  pairing.
                </p>
                <button
                  className="mobile-danger pressable"
                  disabled={disabled}
                  onClick={() => void act(() => api.revoke())}
                >
                  Forget this phone
                </button>
              </div>
            </section>
          ) : null}
          {!status.paired && advert && !status.candidate ? (
            <section className="mobile-pairing" aria-label="Pair your phone">
              <ol>
                <li>Open the Bimax phone app and choose Pair desktop.</li>
                <li>Scan this QR code. Keep this page open.</li>
                <li>Compare the verification code on both devices before confirming.</li>
              </ol>
              {qr ? (
                <img className="mobile-qr" src={qr} alt="Scan to pair with this Mac" />
              ) : (
                <p>QR generation failed. Use the manual pairing data below.</p>
              )}
              <details>
                <summary>Manual pairing data</summary>
                <p>Use Enter code manually in the phone app. Keep this data private.</p>
                <textarea readOnly aria-label="Manual pairing data" value={advert} />
                <button
                  className="mobile-secondary pressable"
                  onClick={async () => {
                    try {
                      if (!(await copyText(advert))) throw new Error('Copy refused');
                      setCopied(true);
                    } catch {
                      setError('Could not copy. Select the manual pairing data instead.');
                    }
                  }}
                >
                  {copied ? 'Copied pairing data' : 'Copy pairing data'}
                </button>
              </details>
            </section>
          ) : null}
          {!status.paired && status.candidate ? (
            <section className="mobile-verify" aria-label="Verify your phone">
              <h3>Do these codes match?</h3>
              <p>Check this code against the one shown on your phone. Confirm only if every digit matches.</p>
              <strong className="mobile-code">{status.candidate.code}</strong>
              <p className="mobile-device">Phone: {status.candidate.phoneId}</p>
              <button
                className="mobile-primary pressable"
                disabled={disabled || status.candidate.expiresAt <= Date.now()}
                onClick={() => void act(() => api.confirm(status.candidate!.code, status.candidate!.phoneId))}
              >
                Codes match — connect phone
              </button>
              <button
                className="mobile-danger pressable"
                disabled={disabled}
                onClick={() => void act(() => api.disable())}
              >
                Codes differ — cancel pairing
              </button>
            </section>
          ) : null}
        </>
      ) : null}
      <p className="mobile-help">
        Open Bimax on your paired phone to set up the secure connection from anywhere using your Bimax account.
        Keep this Mac awake and online. Tool decisions stay on your phone; Expo Go can use your device passcode.
      </p>
    </div>
  );
}
