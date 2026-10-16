import { useEffect, useState, type JSX } from "react";

/**
 * A button for something that cannot be undone: the first click arms it ("Confirm …?"),
 * a second click within 4 seconds does it. Avoids browser dialogs.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, title }: { label: string; confirmLabel: string; onConfirm: () => void; title?: string }): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <button
      className={armed ? "danger armed" : "danger"}
      title={title}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
