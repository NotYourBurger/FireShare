"use client";

import { useState } from "react";

type State = { step: "idle" } | { step: "confirm"; error?: string } | { step: "deleting" };

/** "Delete now", which asks for confirmation before stopping the share link. */
export function DeleteShare({ token }: { token: string }) {
  const [state, setState] = useState<State>({ step: "idle" });

  async function remove() {
    setState({ step: "deleting" });
    try {
      const res = await fetch(`/api/manage/${token}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      // The page re-renders from the server as deleted.
      location.reload();
    } catch (err) {
      setState({ step: "confirm", error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (state.step === "idle") {
    return (
      <div className="actions">
        <button className="danger" onClick={() => setState({ step: "confirm" })}>
          Delete now
        </button>
      </div>
    );
  }
  return (
    <div className="confirm" role="alertdialog" aria-labelledby="delete-question">
      <p>
        <strong id="delete-question">Delete this share?</strong>
      </p>
      <p className="muted">
        The share link stops working right away for everyone, including downloads in progress. This can&apos;t be
        undone.
      </p>
      {state.step === "confirm" && state.error && <p className="error">Couldn&apos;t delete: {state.error}</p>}
      <div className="actions">
        <button className="danger" disabled={state.step === "deleting"} onClick={remove}>
          {state.step === "deleting" ? "Deleting…" : "Delete share"}
        </button>
        <button className="secondary" disabled={state.step === "deleting"} onClick={() => setState({ step: "idle" })}>
          Cancel
        </button>
      </div>
    </div>
  );
}
