import { useState, type JSX } from "react";
import { highlightLine } from "./highlight.tsx";
import { useGame } from "./context.ts";

/**
 * "View behaviour" button: asks the server for a species' wild program. The server only
 * answers for species this player has observed (inspection tier 2).
 */
export function SpeciesBehaviour({ type }: { type: string }): JSX.Element {
  const { actions } = useGame();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = async (): Promise<void> => {
    if (code !== null) {
      setCode(null);
      return;
    }
    const r = await actions.inspectSpecies(type);
    if (r.t === "species") {
      setCode(r.behaviour);
      setError("");
    } else if (r.t === "error") setError(r.message);
  };
  return (
    <div className="species">
      <button className="small" onClick={() => void load()}>
        {code === null ? "View behaviour code" : "Hide behaviour code"}
      </button>
      {error && <p className="error small">{error}</p>}
      {code !== null && <pre className="code-view">{code.split("\n").map((l, i) => highlightLine(l, i))}</pre>}
    </div>
  );
}
