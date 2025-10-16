// src/calendar.ts
import { getCalendarClient } from "./google";

export async function getEvent(eventId: string, uid: string) {
  const cal = await getCalendarClient(uid);
  const res = await cal.events.get({ calendarId: "primary", eventId });
  return res.data;
}



export async function freeBusy(params: { uid: string; timeMinISO: string; timeMaxISO: string; timeZone: string }) {
  const cal = await getCalendarClient(params.uid);
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: params.timeMinISO,
      timeMax: params.timeMaxISO,
      timeZone: params.timeZone,
      items: [{ id: "primary" }]
    }
  });
  return res.data;
}

export async function createMeetEvent(params: {
  uid: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  attendees: string[];
}) {
  const cal = await getCalendarClient(params.uid);
  const res = await cal.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary: params.summary,
      description: params.description || "",
      start: { dateTime: params.startISO, timeZone: params.timeZone },
      end:   { dateTime: params.endISO,   timeZone: params.timeZone },
      attendees: params.attendees.map(email => ({ email })),
      conferenceData: { createRequest: { requestId: crypto.randomUUID() } }
    }
  });
  return res.data;
}

export async function updateMeetEvent(params: {
  uid: string;
  eventId: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  attendees: string[];
}) {
  const cal = await getCalendarClient(params.uid);
  const res = await cal.events.patch({
    calendarId: "primary",
    eventId: params.eventId,
    sendUpdates: "all",
    conferenceDataVersion: 1,
    requestBody: {
      summary: params.summary,
      description: params.description || "",
      start: { dateTime: params.startISO, timeZone: params.timeZone },
      end: { dateTime: params.endISO, timeZone: params.timeZone },
      attendees: params.attendees.map(email => ({ email })),
    },
  });
  return res.data;
}

export async function cancelEvent(params: { uid: string; eventId: string; reason?: string }) {
  const cal = await getCalendarClient(params.uid);
  await cal.events.patch({
    calendarId: "primary",
    eventId: params.eventId,
    sendUpdates: "all",
    requestBody: {
      status: "cancelled",
      ...(params.reason ? { description: params.reason } : {}),
    },
  });
  return { cancelled: true };
}