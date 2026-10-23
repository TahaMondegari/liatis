"use client";

import { useEffect, useRef, useState } from "react";
import { EVENT_TYPES, type AnyEvent } from "@liara-agent/shared";
import { eventsUrl } from "./api";

export type ConnState = "connecting" | "open" | "reconnecting";

/**
 * SSE subscription with replay from the last seen sequence. EventSource
 * reconnects automatically and sends Last-Event-ID; we also keep the cursor
 * so a fresh EventSource (e.g. after a chat switch) resumes without gaps.
 */
export function useEvents(chatId: string | null, onEvent: (e: AnyEvent) => void, startAfter = 0): ConnState {
  const [state, setState] = useState<ConnState>("connecting");
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const cursor = useRef(startAfter);
  useEffect(() => {
    cursor.current = Math.max(cursor.current, startAfter);
  }, [startAfter]);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      es = new EventSource(eventsUrl(chatId, cursor.current));
      es.onopen = () => setState("open");
      es.onerror = () => {
        setState("reconnecting");
        if (es?.readyState === EventSource.CLOSED && !closed) {
          es.close();
          retry = setTimeout(open, 2000);
        }
      };
      const handler = (m: MessageEvent<string>) => {
        try {
          const ev = JSON.parse(m.data) as AnyEvent;
          if (ev.seq) {
            if (ev.seq <= cursor.current) return;
            cursor.current = ev.seq;
          }
          cb.current(ev);
        } catch {
          /* ignore malformed frame */
        }
      };
      for (const t of EVENT_TYPES) es.addEventListener(t, handler as EventListener);
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [chatId]);
  return state;
}
