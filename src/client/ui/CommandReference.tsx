import type { JSX } from "react";
import { COMMANDS, COMMAND_CATEGORIES, CONSTANTS, NAMESPACES, OBJECT_ATTRIBUTES } from "../../script/commands.ts";
import { useGame } from "./context.ts";

const EXAMPLES: { title: string; code: string }[] = [
  {
    title: "Gather the nearest resource of a kind",
    code: `while alive:
    if inventory.is_full():
        deposit()
    else:
        node = find_nearest("stone")
        if node is None:
            explore()
        else:
            harvest(node)`,
  },
  {
    title: "Reusable function with a fallback",
    code: `def gather(kind):
    node = find_nearest(kind)
    if node is None:
        return False
    harvest(node)
    return True

while alive:
    if not gather("gold"):
        gather("tree")
    deposit()`,
  },
  {
    title: "Search ruins for knowledge",
    code: `while alive:
    ruin = find_nearest("ruin")
    if ruin is None:
        explore()
    else:
        found = investigate(ruin)
        print("found", found)
        explore()`,
  },
  {
    title: "Recover from failed actions",
    code: `def on_action_failed(action, reason):
    print(action, "failed:", reason)

while alive:
    try:
        harvest(find_nearest("tree"))
    except GameError as e:
        print("skipping:", e)
        wait(2)
    deposit()`,
  },
  {
    title: "Help build, otherwise wait",
    code: `while alive:
    site = find_nearest("construction")
    if site is not None:
        build(site)
    else:
        wait(5)`,
  },
];

/** First variant of a signature as code to insert, e.g. "follow(target, seconds=30)" -> "follow(target)". */
function callTemplate(signature: string): string {
  const first = signature.split(" / ")[0] ?? signature;
  return first.replace(/,\s*[A-Za-z_]+=[^,)]*/g, "").replace(/\[[^\]]*\]/g, "");
}

export function CommandReference({ onInsert }: { onInsert: (code: string) => void }): JSX.Element {
  const { state } = useGame();
  const unlocks = new Set(state.player?.unlocks ?? []);
  const cats = COMMAND_CATEGORIES;
  return (
    <div className="reference">
      <p className="small muted">
        Code Farmer scripts use a restricted Python-style language: variables, if/elif/else, while, for, def/return, and/or/not, lists, dicts,
        try/except GameError, + - * / // %, and the <code>on_action_failed(action, reason)</code> event handler. Actions pause the program until the
        unit finishes them. Commands marked 🔒 must be discovered first. See docs/SCRIPTING.md for the full grammar.
      </p>
      {cats.map((cat) => (
        <div key={cat}>
          <h4>{cat}</h4>
          <dl>
            {COMMANDS.filter((c) => c.category === cat).map((c) => (
              <div key={c.name} className={c.requires && !unlocks.has(c.requires) ? "locked" : ""}>
                <dt>
                  <code>{c.signature}</code>
                  {c.requires && !unlocks.has(c.requires) && <span title={c.lockedHint}> 🔒</span>}
                  <button className="small link" title="Insert at the cursor" onClick={() => onInsert(callTemplate(c.signature))}>insert</button>
                </dt>
                <dd>
                  {c.description} <span className="muted">→ {c.returns}</span>
                  {c.requires && !unlocks.has(c.requires) && <div className="muted small">Locked: {c.lockedHint}</div>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <h4>Namespaces</h4>
      <dl>
        {Object.values(NAMESPACES).flat().map((m) => (
          <div key={m.signature}>
            <dt><code>{m.signature}</code></dt>
            <dd>{m.description}</dd>
          </div>
        ))}
        {Object.entries(CONSTANTS).map(([k, v]) => (
          <div key={k}>
            <dt><code>{k}</code></dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h4>Object attributes</h4>
      <dl>
        {Object.entries(OBJECT_ATTRIBUTES).map(([k, v]) => (
          <div key={k}>
            <dt><code>obj.{k}</code></dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h4>Examples</h4>
      {EXAMPLES.map((e) => (
        <div key={e.title} className="example">
          <div className="example-head">
            <span>{e.title}</span>
            <button className="small" onClick={() => onInsert(e.code)} title="Insert at the cursor">Insert</button>
          </div>
          <pre>{e.code}</pre>
        </div>
      ))}
    </div>
  );
}
