// components/StreamChat.tsx
"use client";
import { useRef, useState } from "react";

export default function StreamChat() {
  const [history, setHistory] = useState<{ role: "user"|"assistant"; text: string }[]>([]);
  const [pending, setPending] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function send(text: string) {
    setHistory(prev => [...prev, { role: "user", text }]);
    setPending("");

    // SSE
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const url = `/api/agent/turn?stream=1&text=${encodeURIComponent(text)}`;
    const res = await fetch(url, { method: "GET", signal: ctrl.signal, headers: { Accept: "text/event-stream" } });
    if (!res.ok || !res.body) {
      setHistory(prev => [...prev, { role: "assistant", text: "Sorry, something went wrong." }]);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = "";

    // show assistant message progressively
    setHistory(prev => [...prev, { role: "assistant", text: "" }]);

    const pushDelta = (delta: string) => {
      setHistory(prev => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== "assistant") return prev;
        const updated = { ...last, text: last.text + delta };
        return [...prev.slice(0, -1), updated];
      });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });

      // parse SSE lines
      const events = acc.split("\n\n");
      acc = events.pop() || "";
      for (const e of events) {
        const line = e.split("\n").find(l => l.startsWith("data: "));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.type === "delta") pushDelta(payload.text);
        if (payload.type === "done") { /* no-op, already pushed */ }
        if (payload.type === "error") pushDelta("\n[Error: " + payload.message + "]");
      }
    }
  }

  return (
    <div className="flex flex-col gap-3 max-w-2xl mx-auto p-4 border-black">
      <div className="border rounded p-3 min-h-[300px] whitespace-pre-wrap border-black">
        {history.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-slate-800" : "text-slate-600"}>
            <strong>{m.role === "user" ? "You" : "Assistant"}: </strong>{m.text}
          </div>
        ))}
      </div>
      <form onSubmit={e => { e.preventDefault(); const f = (e.target as HTMLFormElement); const t = (f.elements.namedItem("msg") as HTMLInputElement).value.trim(); if (t) { send(t); (f.elements.namedItem("msg") as HTMLInputElement).value=""; } }}>
        <input name="msg" placeholder="Type and hit Enter…" className="w-full border border-black rounded px-3 py-2" />
      </form>
    </div>
  );
}
