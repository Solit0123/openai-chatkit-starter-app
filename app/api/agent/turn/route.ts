import { NextResponse } from "next/server";
import { tool, Agent, RunContext, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { z } from "zod";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";

/* ──────────────────────────────────────────────────────────────────────────
   Tools (single-file, typed like function-calling expects)
   ────────────────────────────────────────────────────────────────────────── */

const Iso = z.string(); // keep simple; enforce ISO/PT via prompts
const Attendee = z.object({ name: z.string().min(1), email: z.string().email() });

const getCalendarAvailability = tool({
  name: "getCalendarAvailability",
  description:
    "Retrieve Google Calendar availability for specified PT windows; if none provided, suggest next open windows.",
  parameters: z.object({
    times: z.array(z.object({ start: Iso, end: Iso })).default([]),
    minimum_duration_minutes: z.number().int().min(15).max(180),
  }),
  async execute(input) {
    // TODO: call your freebusy logic (Google Calendar or your service)
    // Return any shape you like; the agent will read it in text.
    return { suggested_windows: [] };
  },
});

const cancelGoogleMeetingAppointment = tool({
  name: "cancelGoogleMeetingAppointment",
  description:
    "Cancel a Google meeting appointment after explicit confirmation. Time must be PT (ISO 8601).",
  parameters: z.object({
    user_name: z.string().min(1),
    email: z.string().email(),
    meeting_time: Iso,
  }),
  async execute(input) {
    // TODO: locate and cancel event in your calendar
    return { cancelled: true, meeting_time: input.meeting_time };
  },
});

const scheduleGoogleMeetAppointment = tool({
  name: "scheduleGoogleMeetAppointment",
  description:
    "Schedule a 60-minute Google Meet at the confirmed PT start time.",
  parameters: z.object({
    start_time: Iso,
    attendees: z.array(Attendee).min(1),
    title: z.string().min(3).max(120),
    description: z.string().max(2000).default(""),
  }),
  async execute(input) {
    // TODO: create event + Meet link
    return { event_id: "evt_tmp", start_time: input.start_time, meet_url: "https://meet.example" };
  },
});

const updateGoogleEvent = tool({
  name: "updateGoogleEvent",
  description: "Move an existing event and notify attendees.",
  parameters: z.object({
    event_id: z.string(),
    new_start_time: Iso,
    new_end_time: Iso,
    notify_attendees: z.boolean().default(true),
  }),
  async execute(input) {
    // TODO: move event
    return { moved: true, event_id: input.event_id, new_start_time: input.new_start_time };
  },
});

/* ──────────────────────────────────────────────────────────────────────────
   Shared OpenAI client (for guardrails)
   ────────────────────────────────────────────────────────────────────────── */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const context = { guardrailLlm: client };

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

function guardrailsHasTripwire(results: any) {
  return (results ?? []).some((r: any) => r?.tripwireTriggered === true);
}

/* ──────────────────────────────────────────────────────────────────────────
   Agents (same flow as builder)
   ────────────────────────────────────────────────────────────────────────── */

const ClassificationAgentSchema = z.object({
  classification: z.enum(["appointment_related", "get_information", "else"]),
});

const WhenParserSchema = z.object({
  understood: z.boolean(),
  start: z.string().default(""),
  end: z.string().default(""),
  date_only: z.string().default(""),
  notes: z.string().default(""),
});

const classificationAgent = new Agent({
  name: "Classification agent",
  instructions: `Classify the user's message into exactly one of:
- "appointment_related" (booking, rescheduling, canceling, confirming)
- "get_information" (pricing/services/availability questions)
- "else" (spam/solicitation/off-topic)
Return only the label.`,
  model: "gpt-4.1-mini",
  outputType: ClassificationAgentSchema,
  modelSettings: { temperature: 0, topP: 1, maxTokens: 2048, store: true },
});

const clientInformationAgent = new Agent({
  name: "Client Information agent",
  instructions: `Answer factual questions about {business name} and {my services}. Be concise and friendly.
If you don't have the info, say: "I couldn’t find information about that, I’m sorry. Try asking a different question."`,
  model: "gpt-4.1-mini",
  modelSettings: { temperature: 0.4, topP: 1, maxTokens: 2048, store: true },
});

interface AppointmentAgentContext {
  workflowInputAsText: string;
  inputOutputParsedUnderstood: string;
  inputOutputParsedStart: string;
  inputOutputParsedEnd: string;
  inputOutputParsedDateOnly: string;
  inputOutputParsedNotes: string;
}

const appointmentAgentInstructions = (
  runContext: RunContext<AppointmentAgentContext>,
) => {
  const {
    workflowInputAsText,
    inputOutputParsedUnderstood,
    inputOutputParsedStart,
    inputOutputParsedEnd,
    inputOutputParsedDateOnly,
    inputOutputParsedNotes,
  } = runContext.context;

  return `You are the Appointment Agent for {business name}. Coordinate appointment requests (schedule, reschedule, cancel, availability) safely and professionally.

## Inputs (read carefully)
- Original user message:
${workflowInputAsText}
- Parsed date/time (PT):
understood=${inputOutputParsedUnderstood}
start=${inputOutputParsedStart}
end=${inputOutputParsedEnd}
date_only=${inputOutputParsedDateOnly}
notes=${inputOutputParsedNotes}

## Intents (classify first, return exactly one label)
- "schedule_app" | "cancel_app" | "availability_app" | "reschedule_app"

## Timezone Canon
- All dates/times are PT. If ambiguous, say: "Just to confirm, that's PT (Pacific Time)."

## Tooling Policy (never call a tool before confirmation)
- Availability → getCalendarAvailability(times[], minimum_duration_minutes)
- Schedule new → scheduleGoogleMeetAppointment(start_time, attendees[], title, description)
- Cancel → cancelGoogleMeetingAppointment(user_name, email, meeting_time)
- Reschedule → updateGoogleEvent(event_id, new_start_time, new_end_time, notify_attendees=true)
- Do NOT cancel+create to reschedule.

## Behavioral Rules by Intent
- "availability_app": check preferred time first; else propose next PT windows. Confirm PT.
- "schedule_app": propose a specific PT time → WAIT for explicit "Yes" → THEN scheduleGoogleMeetAppointment.
- "cancel_app": confirm PT event → ask "Are you sure?" → on "Yes" cancel.
- "reschedule_app": identify current event → gather new PT time → check availability → WAIT for "Yes" → updateGoogleEvent.

## Date & Time Interpretation
- Understand: "on the 28th", "this Saturday", "tomorrow 10:30", "Fri 10–12", "next Tuesday at 9".
- If only a date: capture date_only="YYYY-MM-DD"; prefer nearest future.
- If uncertain: understood=false and ask a clarifying question (no tools).

## Confirmation Gates (must be spoken back)
- Confirm PT if ambiguous.
- Confirm PT time before scheduling.
- Confirm exact PT event before cancel.
- Confirm new PT time before rescheduling.

## Output
- Be concise; after a successful tool call, restate the action and the final PT time.`;
};

const appointmentAgent = new Agent<AppointmentAgentContext>({
  name: "Appointment Agent",
  instructions: appointmentAgentInstructions,
  model: "gpt-5",
  tools: [
    getCalendarAvailability,
    cancelGoogleMeetingAppointment,
    scheduleGoogleMeetAppointment,
    updateGoogleEvent,
  ],
  modelSettings: {
    parallelToolCalls: false, // serialize destructive ops
    reasoning: { effort: "low", summary: "auto" },
    store: true,
  },
});

const whenParser = new Agent({
  name: "When Parser",
  instructions: `Parse the user's message into PT times. If uncertain, set understood=false and leave start/end/date_only empty strings.`,
  model: "gpt-4.1-mini",
  outputType: WhenParserSchema,
  modelSettings: { temperature: 0, store: true },
});

const smallTalkAgent = new Agent({
  name: "Agent",
  instructions:
    "Hi! I’m the assistant for {business name}. I can help you book or reschedule an appointment, check availability, or answer quick questions about our services and pricing. What would you like to do?",
  model: "gpt-5",
  modelSettings: { reasoning: { effort: "low", summary: "auto" }, store: true },
});

/* ──────────────────────────────────────────────────────────────────────────
   Single endpoint: runs the whole workflow & tools and replies { text }
   ────────────────────────────────────────────────────────────────────────── */

export async function POST(req: Request) {
  const { text } = await req.json();

  return withTrace("website-chat-turn", async () => {
    // 0) INPUT guardrail
    const inGr = await runGuardrails(text, jailbreakGuardrailConfig, context);
    if (guardrailsHasTripwire(inGr)) {
      return NextResponse.json({ text: "Sorry, I can’t help with that request." });
    }

    // 1) Build conversation items
    const conversationHistory: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text }] },
    ];

    // 2) Classify
    const runner = new Runner();
    const cls = await runner.run(classificationAgent, conversationHistory);
    if (!cls.finalOutput) return NextResponse.json({ text: "Could you rephrase that?" });

    const label = cls.finalOutput.classification;

    // 3) Route
    if (label === "appointment_related") {
      const when = await runner.run(whenParser, conversationHistory);
      if (!when.finalOutput) {
        return NextResponse.json({
          text: "Could you share a preferred date/time (PT)? I’ll check availability.",
        });
      }

      const app = await runner.run(
        appointmentAgent,
        conversationHistory,
        {
          context: {
            workflowInputAsText: text,
            inputOutputParsedUnderstood: String(when.finalOutput.understood),
            inputOutputParsedStart: when.finalOutput.start,
            inputOutputParsedEnd: when.finalOutput.end,
            inputOutputParsedDateOnly: when.finalOutput.date_only,
            inputOutputParsedNotes: when.finalOutput.notes,
          },
        }
      );

      const reply = app.finalOutput ?? "All set.";
      // 4) OUTPUT guardrail (optional)
      // Put near your other guardrail configs
const moderationOnlyGuardrailConfig = {
  guardrails: [
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

const outGr = await runGuardrails(reply, moderationOnlyGuardrailConfig, context);
if (guardrailsHasTripwire(outGr)) {
  return NextResponse.json({ text: "Sorry, I can’t share that." });
}


      return NextResponse.json({ text: reply });
    }

    if (label === "get_information") {
      const info = await runner.run(clientInformationAgent, conversationHistory);
      return NextResponse.json({ text: info.finalOutput ?? "What would you like to know?" });
    }

    // else → friendly website greeting
    const greet = await runner.run(smallTalkAgent, conversationHistory);
    return NextResponse.json({ text: greet.finalOutput ?? "Hi! How can I help?" });
  });
}
