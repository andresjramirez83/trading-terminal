import { useEffect, useState, type CSSProperties } from "react";
import { beginAISession, endAISession, getAISession, setTemporaryLocalAIToken, clearTemporaryLocalAIToken, hasTemporaryLocalAIToken } from "../services/aiAnalysis";

const field: CSSProperties = { width: "100%", boxSizing: "border-box", padding: "8px", background: "#0b1220", color: "#f1f5f9", border: "1px solid #475569", borderRadius: 7 };
const button: CSSProperties = { padding: "8px 10px", color: "white", cursor: "pointer", background: "#1d4ed8", border: "1px solid #2563eb", borderRadius: 7 };

export default function AIAuthPanel({ onSignedIn }: { onSignedIn?: () => void }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const loopback = typeof window !== "undefined" && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);

  useEffect(() => {
    let mounted = true;
    getAISession().then((session) => {
      if (mounted) setAuthenticated(session.authenticated || hasTemporaryLocalAIToken());
    }).catch((e) => { if (mounted) setError(e instanceof Error ? e.message : "Session check failed"); })
      .finally(() => { if (mounted) setChecking(false); });
    return () => { mounted = false; };
  }, []);

  async function signIn() {
    setBusy(true); setError("");
    try {
      if (secure) await beginAISession(token);
      else if (loopback) setTemporaryLocalAIToken(token);
      else throw new Error("HTTPS is required for AI sign-in.");
      setToken("");
      setAuthenticated(true);
      onSignedIn?.();
    } catch (e) { setError(e instanceof Error ? e.message : "AI sign-in failed"); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError("");
    try { if (secure) await endAISession(); else clearTemporaryLocalAIToken(); setAuthenticated(false); setToken(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign out failed"); }
    finally { setBusy(false); }
  }

  return <section style={{ border: "1px solid #334155", padding: 9, borderRadius: 8, fontSize: 11, display: "grid", gap: 6 }}>
    <strong>AI access · {checking ? "Checking…" : authenticated ? secure ? "Signed in for 30 days" : "Temporary tunnel access" : secure ? "Sign in once" : "Access setup"}</strong>
    {authenticated ? <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ color: "#86efac" }}>{secure ? "Protected browser session active" : "SSH tunnel session (memory only)"}</span>
      <button type="button" onClick={() => void signOut()} disabled={busy} style={{ ...button, background: "#334155" }}>Sign out</button>
    </div> : !secure && !loopback ? <div style={{ color: "#fcd34d" }}>This site uses public HTTP. Do not enter your access token here. Enable HTTPS to use secure, remembered AI sign-in.</div> : <>
      {!secure && <div style={{ color: "#fcd34d" }}>Temporary SSH-tunnel mode: enter the access token only when this localhost address is being forwarded through your SSH tunnel. It is kept in memory only, not remembered after reload. Enable HTTPS for 30-day remembered sign-in.</div>}
      <label htmlFor="tt-ai-access-token">AI analysis access token (not your OpenAI API key)</label>
      <input id="tt-ai-access-token" type="password" autoComplete="off" style={field} value={token} onChange={(e) => setToken(e.target.value)} />
      <button type="button" style={button} disabled={!token.trim() || busy || checking} onClick={() => void signIn()}>{busy ? "Signing in…" : secure ? "Sign in & remember this browser" : "Use token in this tab"}</button>
      <small style={{ color: "#94a3b8" }}>{secure ? "The token is submitted once over HTTPS; a Secure HttpOnly cookie keeps you signed in for 30 days." : "Temporary access through your localhost SSH tunnel only."} Nothing is stored in localStorage or the frontend bundle.</small>
    </>}
    {error && <span role="alert" style={{ color: "#fca5a5" }}>{error}</span>}
  </section>;
}
