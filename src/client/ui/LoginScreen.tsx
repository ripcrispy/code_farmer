import { useState, type FormEvent, type JSX } from "react";
import { RACES } from "../../shared/defs/races.ts";
import { describeEffect } from "../../shared/defs/effects.ts";

export interface SavedLogin {
  name: string;
  token: string;
}

export function LoginScreen(props: {
  serverUrl: string;
  saved: SavedLogin | null;
  error: string;
  busy: boolean;
  onLogin: (opts: { serverUrl: string; name: string; race: string; token?: string }) => void;
  onForget: () => void;
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(props.serverUrl);
  const [name, setName] = useState("");
  const [race, setRace] = useState("human");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    props.onLogin({ serverUrl, name: name.trim(), race });
  };
  const raceInfo = RACES.find((r) => r.id === race);
  return (
    <div className="login">
      <div className="login-card">
        <h1>Code Farmer</h1>
        <p className="muted">Program your units. Grow your civilisation.</p>
        <label>
          Server
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} spellCheck={false} />
        </label>
        {props.saved && (
          <div className="saved">
            <button className="primary wide" disabled={props.busy} onClick={() => props.onLogin({ serverUrl, name: props.saved!.name, race, token: props.saved!.token })}>
              Continue as {props.saved.name}
            </button>
            <button className="link" onClick={props.onForget}>Forget this login on this browser</button>
          </div>
        )}
        <form onSubmit={submit}>
          <h3>{props.saved ? "Or create a new player" : "Create a player"}</h3>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="3-20 letters or digits" autoFocus={!props.saved} />
          </label>
          <label>
            Race
            <select value={race} onChange={(e) => setRace(e.target.value)}>
              {RACES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} — {r.theme}
                </option>
              ))}
            </select>
          </label>
          {raceInfo && (
            <div className="small muted">
              <p>{raceInfo.description}</p>
              <ul className="passives">
                {raceInfo.passives.map((e, i) => (
                  <li key={i}>{describeEffect(e)}</li>
                ))}
                {raceInfo.plannedPassives.map((t) => (
                  <li key={t}><em>Planned, not yet implemented: {t}</em></li>
                ))}
              </ul>
            </div>
          )}
          <button className="primary wide" type="submit" disabled={props.busy || name.trim().length < 3}>
            Found settlement
          </button>
        </form>
        {props.error && <div className="blocked" role="alert">{props.error}</div>}
        <p className="small muted">
          To play two players on one computer, open a second window with <code>?profile=2</code> in the URL (or a private window).
        </p>
      </div>
    </div>
  );
}
