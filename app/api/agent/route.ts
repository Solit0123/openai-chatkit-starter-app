// app/api/agent/turn/route.ts
import { NextRequest, NextResponse } from "next/server";
import { tool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { runGuardrails } from "@openai/guardrails";
import { z } from "zod";
import { OpenAI } from "openai";

/* ──────────────────────────────────────────────────────────────
   0) Optional: shared OpenAI client (for vector store / guardrails)
   ────────────────────────────────────────────────────────────── */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const guardrailsContext = { guardrailLlm: openai };
const jailbreakGuardrailConfig = {
  guardrails: [
    { name: "Jailbreak", config: { model: "gpt-5-nano", confidence_threshold: 0.7 } },
    {
      name: "Moderation",
      config: {
        categories: [
          "sexual/minors",
          "hate/threatening",
          "harassment/threatening",
          "self-harm/instructions",
          "violence/graphic",
          "illicit/violent",
        ],
      },
    },
  ],
};
const moderationOnlyGuardrailConfig = {
  guardrails: [
    {
      name: "Moderation",
      config: {
        categories: jailbreakGuardrailConfig.guardrails[1].config.categories,
      },
    },
  ],
};
const hasTripwire = (res: any) => (res ?? []).some((r: any) => r?.tripwireTriggered);

/* ──────────────────────────────────────────────────────────────
   1) Schemas for scheduling tools (replace with your imports)
   ────────────────────────────────────────────────────────────── */
// If you already have these, import them instead of stubbing.
export const AvailabilityRequestSchema = z.object({
  times: z.array(z.string().min(1)), // ISO start times; each implies a 60-min slot
});
export const BookMeetingRequestSchema = z.object({
  start_time: z.string(),
  guest_name: z.string(),
  guest_email: z.string().email(),
  client_company: z.string(),
  agenda: z.string().default(""),
});
export const RescheduleMeetingRequestSchema = z.object({
  event_id: z.string(),
  new_start_time: z.string(),
  guest_name: z.string(),
  guest_email: z.string().email(),
  client_company: z.string(),
  agenda: z.string().default(""),
});
export const CancelMeetingRequestSchema = z.object({
  event_id: z.string(),
  reason: z.string().default(""),
});

/* ──────────────────────────────────────────────────────────────
   2) Calendar helpers (replace with your real implementations)
   ────────────────────────────────────────────────────────────── */
// Replace these with your actual implementations.
async function freeBusy(opts: {
  uid: string;
  timeMinISO: string;
  timeMaxISO: string;
  timeZone: string;
}) {
  // TODO: call Google FreeBusy
  return { calendars: { primary: { busy: [] as Array<{ start: string; end: string }> } } };
}
async function createMeetEvent(opts: {
  uid: string;
  summary: string;
  description: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  attendees: string[];
}) {
  // TODO: insert event
  return { id: "evt_new", summary: opts.summary, hangoutLink: "https://meet.example", start: { dateTime: opts.startISO }, end: { dateTime: opts.endISO } };
}
async function updateMeetEvent(opts: {
  uid: string;
  eventId: string;
  summary: string;
  description: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  attendees: string[];
}) {
  // TODO: patch event
  return { id: opts.eventId, summary: opts.summary, hangoutLink: "https://meet.example", start: { dateTime: opts.startISO }, end: { dateTime: opts.endISO } };
}
async function cancelEvent(opts: { uid: string; eventId: string; reason?: string }) {
  // TODO: delete event or set status=cancelled
  return true;
}

/* ──────────────────────────────────────────────────────────────
   3) Your scheduling tools with function calls (per-user)
   ────────────────────────────────────────────────────────────── */
function createSchedulingTools(uid: string) {
  const getCalendarAvailability = tool({
    name: "getCalendarAvailability",
    description:
      "Check Google Calendar availability for proposed PT time windows, assuming 60-minute Google Meet appointments and returning busy periods for the primary calendar.",
    parameters: AvailabilityRequestSchema,
    execute: async (input: z.infer<typeof AvailabilityRequestSchema>) => {
      if (!Array.isArray(input.times) || input.times.length === 0) {
        throw new Error("Provide at least one candidate time in ISO 8601 format.");
      }
      const durationMinutes = 60;
      const results: any[] = [];
      for (const startInput of input.times) {
        const start = new Date(startInput);
        if (Number.isNaN(start.getTime())) {
          results.push({ slot_start: startInput, available: false, error: "invalid_datetime" });
          continue;
        }
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        try {
          const availability = await freeBusy({
            uid,
            timeMinISO: start.toISOString(),
            timeMaxISO: end.toISOString(),
            timeZone: "America/Los_Angeles",
          });
          const busy = availability?.calendars?.primary?.busy ?? [];
          results.push({
            slot_start: start.toISOString(),
            slot_end: end.toISOString(),
            available: busy.length === 0,
            busy_windows: busy,
          });
        } catch (error: any) {
          if (typeof error?.message === "string" && error.message.includes("missing_calendar_refresh_token")) {
            throw new Error("Calendar is not connected for this user.");
          }
          throw error;
        }
      }
      return { availability: results, duration_minutes: durationMinutes };
    },
  });

  const bookMeeting = tool({
    name: "bookMeeting",
    description:
      "Create a 60-minute Google Meet appointment on the user's calendar once the guest name, email, company, agenda, and confirmed PT start time are known.",
    parameters: BookMeetingRequestSchema,
    execute: async (input: z.infer<typeof BookMeetingRequestSchema>) => {
      const start = new Date(input.start_time);
      if (Number.isNaN(start.getTime())) throw new Error("Start time must be a valid ISO 8601 string.");
      const end = new Date(start.getTime() + 60 * 60_000);
      const summary = `Meeting-${input.client_company}-${input.guest_name}`;
      const event = await createMeetEvent({
        uid,
        summary,
        description: input.agenda,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        timeZone: "America/Los_Angeles",
        attendees: [input.guest_email],
      });
      return {
        event_id: event.id ?? null,
        summary: event.summary ?? summary,
        meeting_link: (event as any).hangoutLink ?? (event as any).conferenceData?.entryPoints?.[0]?.uri ?? null,
        start: (event as any).start?.dateTime ?? start.toISOString(),
        end: (event as any).end?.dateTime ?? end.toISOString(),
      };
    },
  });

  const rescheduleMeeting = tool({
    name: "rescheduleMeeting",
    description:
      "Update an existing Google Meet appointment to a new 60-minute slot once the event ID, guest information, and new PT start time are confirmed.",
    parameters: RescheduleMeetingRequestSchema,
    execute: async (input: z.infer<typeof RescheduleMeetingRequestSchema>) => {
      const start = new Date(input.new_start_time);
      if (Number.isNaN(start.getTime())) throw new Error("New start time must be a valid ISO 8601 string.");
      const end = new Date(start.getTime() + 60 * 60_000);
      const summary = `Meeting-${input.client_company}-${input.guest_name}`;
      const event = await updateMeetEvent({
        uid,
        eventId: input.event_id,
        summary,
        description: input.agenda,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        timeZone: "America/Los_Angeles",
        attendees: [input.guest_email],
      });
      return {
        event_id: (event as any).id ?? input.event_id,
        summary: (event as any).summary ?? summary,
        meeting_link: (event as any).hangoutLink ?? (event as any).conferenceData?.entryPoints?.[0]?.uri ?? null,
        start: (event as any).start?.dateTime ?? start.toISOString(),
        end: (event as any).end?.dateTime ?? end.toISOString(),
      };
    },
  });

  const cancelMeeting = tool({
    name: "cancelMeeting",
    description:
      "Cancel an existing appointment after the user confirms they want to proceed, notifying the guest via calendar updates.",
    parameters: CancelMeetingRequestSchema,
    execute: async (input: z.infer<typeof CancelMeetingRequestSchema>) => {
      await cancelEvent({ uid, eventId: input.event_id, reason: input.reason });
      return { event_id: input.event_id, cancelled: true };
    },
  });

  return { getCalendarAvailability, bookMeeting, rescheduleMeeting, cancelMeeting };
}

/* ──────────────────────────────────────────────────────────────
   4) Core agents (classifier, when-parser, info, appointment)
   ────────────────────────────────────────────────────────────── */
const ClassificationSchema = z.object({
  classification: z.enum(["appointment_related", "get_information", "else"]),
});
const WhenSchema = z.object({
  understood: z.boolean(),
  start: z.string().default(""),
  end: z.string().default(""),
  date_only: z.string().default(""),
  notes: z.string().default(""),
});

const classificationAgent = new Agent({
  name: "Classification",
  model: "gpt-4.1-mini",
  outputType: ClassificationSchema,
  modelSettings: { temperature: 0, store: true },
  instructions: 'Return exactly one label: "appointment_related" | "get_information" | "else".',
});

const whenParser = new Agent({
  name: "When Parser",
  model: "gpt-4.1-mini",
  outputType: WhenSchema,
  modelSettings: { temperature: 0, store: true },
  instructions: "Return PT ISO-8601 start/end if confident; else understood=false and empty strings.",
});

const infoAgent = new Agent({
  name: "Client Information",
  model: "gpt-4.1-mini",
  modelSettings: { temperature: 0.4, store: true },
  instructions:
    'Answer factual questions about {business name}/services. If unknown, reply: "I couldn’t find information about that, I’m sorry. Try asking a different question."',
});

// The appointment agent is created **per request** so tools carry the per-user UID
function createAppointmentAgentWithUser(uid: string) {
  const { getCalendarAvailability, bookMeeting, rescheduleMeeting, cancelMeeting } =
    createSchedulingTools(uid);

  return new Agent<{
    userText: string;
    when: z.infer<typeof WhenSchema>;
  }>({
    name: "Appointment Agent",
    model: "gpt-5",
    tools: [getCalendarAvailability, bookMeeting, rescheduleMeeting, cancelMeeting],
    modelSettings: { parallelToolCalls: false, reasoning: { effort: "low", summary: "auto" }, store: true },
    instructions: ({ context: { userText, when } }) => `
You are the Appointment Agent for {business name}. All times are PT.
Original: """${userText}"""
Parsed: understood=${when.understood} start=${when.start} end=${when.end} date_only=${when.date_only}

Behavior:
- availability_app: use getCalendarAvailability; if no times provided, propose 2–3 PT windows.
- schedule_app: propose PT time → WAIT for explicit "Yes" → call bookMeeting.
- cancel_app: confirm PT event → WAIT "Yes" → call cancelMeeting.
- reschedule_app: confirm new PT time → WAIT "Yes" → call rescheduleMeeting.
Be concise. After any tool success, restate the final PT time and (if available) the Meet link.`,
  });
}

/* ──────────────────────────────────────────────────────────────
   5) Turn execution helpers
   ────────────────────────────────────────────────────────────── */
async function runTurn(uid: string, userText: string) {
  const runner = new Runner();
  const items: AgentInputItem[] = [{ role: "user", content: [{ type: "input_text", text: userText }] }];

  // classify
  const cls = await runner.run(classificationAgent, items);
  const label = cls.finalOutput?.classification ?? "else";

  if (label === "appointment_related") {
    const when = (await runner.run(whenParser, items)).finalOutput ?? { understood: false, start: "", end: "", date_only: "", notes: "" };
    const appointmentAgent = createAppointmentAgentWithUser(uid);
    const app = await runner.run(appointmentAgent, items, { context: { userText, when } });
    return app.finalOutput ?? "All set.";
  }

  if (label === "get_information") {
    const info = await runner.run(infoAgent, items);
    const answer = info.finalOutput ?? "What would you like to know?";

    // Optional Vector Store lookup (replace with your knowledge source)
    const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID; // or fetch from your DB
    let files: Array<{ id: string; filename: string; score: number | null }> = [];
    if (vectorStoreId) {
      const vs = await openai.vectorStores.search(vectorStoreId, { query: answer, max_num_results: 50 });
      files = (vs.data ?? []).map(r => ({ id: r.file_id, filename: r.filename, score: r.score }));
    }
    // You can append file refs to the answer if you want
    return answer;
  }

  // else → friendly greeting
  return "Hi! I can help you schedule/reschedule, check availability (PT), or answer quick questions. What would you like to do?";
}

/* ──────────────────────────────────────────────────────────────
   6) Single endpoint (JSON). You can keep your SSE GET if you want.
   ────────────────────────────────────────────────────────────── */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const text = String(body?.text ?? "").trim();

  if (!text) {
    return NextResponse.json({ text: "Please send a message to begin." }, { status: 400 });
  }

  // TODO: resolve the authenticated user id for calendar access
  const uid = (body?.uid as string) || "demo-user";

  return withTrace("website-agent-turn", async () => {
    // input guardrail
    const inGr = await runGuardrails(text, jailbreakGuardrailConfig, guardrailsContext);
    if (hasTripwire(inGr)) return NextResponse.json({ text: "Sorry, I can’t help with that request." });

    const reply = await runTurn(uid, text);

    // output guardrail
    const outGr = await runGuardrails(reply, moderationOnlyGuardrailConfig, guardrailsContext);
    if (hasTripwire(outGr)) return NextResponse.json({ text: "Sorry, I can’t share that." });

    return NextResponse.json({ text: reply });
  });
}
