"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { firebaseAuthClient, firebaseFirestoreClient } from "@/app/lib/firebase-client";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: number;
};

export default function Home() {
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [connections, setConnections] = useState<{
    gmail?: { connected: boolean; scopes: string[]; historyId: string | null };
    calendar?: { connected: boolean; scopes: string[] };
  } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [knowledge, setKnowledge] = useState<{
    vectorStoreId: string;
    files: Array<{ id: string; filename: string; status: string; bytes: number; last_processed_at?: string | null }>;
    updatedAt: string;
  } | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeText, setKnowledgeText] = useState("");
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [knowledgeUploading, setKnowledgeUploading] = useState(false);
  const [agentSettingsLoading, setAgentSettingsLoading] = useState(false);
  const [agentSettingsSaving, setAgentSettingsSaving] = useState(false);
  const [agentSettingsError, setAgentSettingsError] = useState<string | null>(null);
  const [schedulingPrompt, setSchedulingPrompt] = useState("");
  const [informationPrompt, setInformationPrompt] = useState("");
  const [classificationPrompt, setClassificationPrompt] = useState("");

  const requireAuthToken = useCallback(async () => {
    const current = firebaseAuthClient.currentUser;
    if (!current) {
      throw new Error("Please sign in first.");
    }
    return current.getIdToken();
  }, []);

  const fetchWithAuth = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const token = await requireAuthToken();
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const isFormData = init?.body instanceof FormData;
      if (!isFormData) {
        headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
      }
      return fetch(input, { ...init, headers });
    },
    [requireAuthToken]
  );

  const refreshConnections = useCallback(async () => {
    if (!firebaseAuthClient.currentUser) return;
    try {
      setStatusLoading(true);
      setStatusError(null);
      const res = await fetchWithAuth("/api/connections/status");
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      setConnections(data);
    } catch (err: any) {
      console.error(err);
      setStatusError(err?.message ?? "Failed to load connection status");
    } finally {
      setStatusLoading(false);
    }
  }, [fetchWithAuth]);

  const persistMessages = useCallback(async (msgs: ChatMessage[]) => {
    const current = firebaseAuthClient.currentUser;
    if (!current) return;
    const ref = doc(firebaseFirestoreClient, "chatSessions", current.uid);
    await setDoc(ref, { messages: msgs, updatedAt: Date.now() }, { merge: true });
  }, []);

  const loadChat = useCallback(async () => {
    const current = firebaseAuthClient.currentUser;
    if (!current) return;
    try {
      const ref = doc(firebaseFirestoreClient, "chatSessions", current.uid);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() as { messages?: ChatMessage[] };
        if (Array.isArray(data.messages)) {
          setMessages(data.messages);
        } else {
          setMessages([]);
        }
      } else {
        setMessages([]);
      }
    } catch (err) {
      console.error("load_chat_failed", err);
      setMessages([]);
    }
  }, []);

  const refreshKnowledge = useCallback(async (opts: { refresh?: boolean } = {}) => {
    if (!firebaseAuthClient.currentUser) return;
    try {
      setKnowledgeLoading(true);
      setKnowledgeError(null);
      const url = opts.refresh ? "/api/knowledge/status?refresh=true" : "/api/knowledge/status";
      const res = await fetchWithAuth(url);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      setKnowledge(data);
    } catch (err: any) {
      console.error(err);
      setKnowledgeError(err?.message ?? "Failed to load knowledge");
    } finally {
      setKnowledgeLoading(false);
    }
  }, [fetchWithAuth]);

  const refreshAgentSettings = useCallback(async () => {
    if (!firebaseAuthClient.currentUser) return;
    try {
      setAgentSettingsLoading(true);
      setAgentSettingsError(null);
      const res = await fetchWithAuth("/api/agent/settings");
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      setSchedulingPrompt(data?.schedulingPrompt ?? "");
      setInformationPrompt(data?.informationPrompt ?? "");
      setClassificationPrompt(data?.classificationPrompt ?? "");
    } catch (err: any) {
      console.error("agent_settings_load_failed", err);
      setAgentSettingsError(err?.message ?? "Failed to load agent instructions");
    } finally {
      setAgentSettingsLoading(false);
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    const unsub = onAuthStateChanged(firebaseAuthClient, async current => {
      setUser(current);
      if (current) {
        await Promise.all([
          refreshConnections(),
          refreshKnowledge(),
          refreshAgentSettings(),
          loadChat(),
        ]);
      } else {
        setConnections(null);
        setKnowledge(null);
        setMessages([]);
        setSchedulingPrompt("");
        setInformationPrompt("");
        setClassificationPrompt("");
        setAgentSettingsError(null);
        setAgentSettingsLoading(false);
        setAgentSettingsSaving(false);
      }
    });
    return () => unsub();
  }, [loadChat, refreshConnections, refreshKnowledge, refreshAgentSettings]);

  async function callthis() {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    const current = firebaseAuthClient.currentUser;
    if (!current) {
      alert("Please sign in first.");
      return;
    }

    const userMessage: ChatMessage = {
      role: "user",
      text: trimmed,
      createdAt: Date.now(),
    };

    const historyWithUser = [...messages, userMessage];
    setMessages(historyWithUser);
    await persistMessages(historyWithUser);
    setMessage("");

    try {
      setLoading(true);
      const res = await fetchWithAuth("/api/agent", {
        method: "POST",
        body: JSON.stringify({ text: trimmed, history: historyWithUser }),
      });

      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const assistantText =
        typeof data === "string" ? data : JSON.stringify(data, null, 2);

      const assistantMessage: ChatMessage = {
        role: "assistant",
        text: assistantText,
        createdAt: Date.now(),
      };
      const updatedHistory = [...historyWithUser, assistantMessage];
      setMessages(updatedHistory);
      await persistMessages(updatedHistory);

      setResponse(assistantText);
    } catch (err: any) {
      console.error(err);
      setResponse(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const handleSignIn = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope("https://www.googleapis.com/auth/calendar");
      provider.addScope("https://www.googleapis.com/auth/gmail.readonly");
      provider.addScope("https://www.googleapis.com/auth/gmail.send");
      await signInWithPopup(firebaseAuthClient, provider);
    } catch (err) {
      console.error("sign-in failed", err);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(firebaseAuthClient);
      setResponse(null);
      setMessages([]);
    } catch (err) {
      console.error("sign-out failed", err);
    }
  };

  const connectProvider = async (provider: "gmail" | "calendar") => {
    try {
      const res = await fetchWithAuth(`/api/google/oauth/url?provider=${provider}`);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No URL returned from OAuth endpoint.");
      }
    } catch (err) {
      console.error(`connect ${provider} failed`, err);
      alert(`Failed to start ${provider} OAuth flow. Check console for details.`);
    }
  };

  const startGmailWatch = async () => {
    try {
      const res = await fetchWithAuth("/api/connections/start-watch", { method: "POST" });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      alert(`Watch started. History ID: ${data.historyId ?? "n/a"}`);
      await refreshConnections();
      await refreshKnowledge({ refresh: true });
    } catch (err) {
      console.error("start-watch failed", err);
      alert("Failed to start Gmail watch. Check console for details.");
    }
  };

  const handleKnowledgeUpload = async () => {
    try {
      if (!knowledgeText.trim() && !knowledgeFile) {
        alert("Add knowledge text or choose a file first.");
        return;
      }
      setKnowledgeUploading(true);
      const form = new FormData();
      if (knowledgeText.trim()) {
        form.append("text", knowledgeText.trim());
      }
      if (knowledgeFile) {
        form.append("file", knowledgeFile);
      }
      const res = await fetchWithAuth("/api/knowledge/upload", {
        method: "POST",
        body: form,
        headers: undefined,
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      setKnowledgeText("");
      setKnowledgeFile(null);
      await refreshKnowledge({ refresh: true });
      alert("Knowledge uploaded and indexed.");
    } catch (err: any) {
      console.error("knowledge upload failed", err);
      alert(err?.message ?? "Failed to upload knowledge.");
    } finally {
      setKnowledgeUploading(false);
    }
  };

  const handleSaveAgentSettings = async () => {
    try {
      if (!firebaseAuthClient.currentUser) {
        alert("Please sign in first.");
        return;
      }
      setAgentSettingsSaving(true);
      setAgentSettingsError(null);
      const res = await fetchWithAuth("/api/agent/settings", {
        method: "POST",
        body: JSON.stringify({
          schedulingPrompt,
          informationPrompt,
          classificationPrompt,
        }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      setSchedulingPrompt(data?.schedulingPrompt ?? "");
      setInformationPrompt(data?.informationPrompt ?? "");
      setClassificationPrompt(data?.classificationPrompt ?? "");
      alert("Agent instructions updated.");
    } catch (err: any) {
      console.error("agent_settings_save_failed", err);
      setAgentSettingsError(err?.message ?? "Failed to save agent instructions");
    } finally {
      setAgentSettingsSaving(false);
    }
  };

  return (
    <div className="font-sans flex flex-col items-center justify-center min-h-screen p-8 gap-4">
      <div className="flex flex-col items-center gap-3">
        {user ? (
          <>
            <span className="text-sm text-gray-600">Signed in as {user.email}</span>
            <button
              onClick={handleSignOut}
              className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-300 transition-all"
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            onClick={handleSignIn}
            className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-all"
          >
            Sign in with Google
          </button>
        )}
      </div>

      {user && (
        <div className="w-full max-w-xl border border-gray-200 rounded-xl p-4 flex flex-col gap-2 bg-white text-black">
          <h2 className="text-lg font-semibold">Google Connections</h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => connectProvider("gmail")}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-all"
            >
              Connect Gmail
            </button>
            <button
              onClick={() => connectProvider("calendar")}
              className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-all"
            >
              Connect Calendar
            </button>
            <button
              onClick={refreshConnections}
              disabled={statusLoading}
              className="bg-gray-100 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-200 transition-all disabled:opacity-60"
            >
              {statusLoading ? "Checking..." : "Check connectivity"}
            </button>
            <button
              onClick={startGmailWatch}
              className="bg-orange-500 text-white px-4 py-2 rounded-lg hover:bg-orange-600 transition-all"
            >
              Start Gmail Webhook Watch
            </button>
          </div>
          {statusError && (
            <p className="text-sm text-red-600">Status error: {statusError}</p>
          )}
          {connections && (
            <pre className="bg-gray-100 text-gray-800 rounded-lg p-3 text-xs whitespace-pre-wrap">
{JSON.stringify(connections, null, 2)}
            </pre>
          )}
        </div>
      )}

      {user && (
        <div className="w-full max-w-xl border border-gray-200 rounded-xl p-4 flex flex-col gap-3 bg-white text-black">
          <h2 className="text-lg font-semibold">Agent Instructions</h2>
          <p className="text-sm text-gray-600">
            Customize how the assistant responds. Leave blank to use the default behavior.
          </p>
          <label className="text-sm font-medium text-gray-800" htmlFor="classification-instructions">
            Classification agent instructions
          </label>
          <textarea
            id="classification-instructions"
            className="bg-white text-black w-full border border-gray-200 rounded-lg p-2 h-24"
            placeholder='Describe when the system should answer as "appointment_related", "get_information", or "else"...'
            value={classificationPrompt}
            onChange={e => setClassificationPrompt(e.target.value)}
            disabled={agentSettingsLoading || agentSettingsSaving}
          />
          <label className="text-sm font-medium text-gray-800" htmlFor="scheduling-instructions">
            Scheduling agent instructions
          </label>
          <textarea
            id="scheduling-instructions"
            className="bg-white text-black w-full border border-gray-200 rounded-lg p-2 h-28"
            placeholder="Add tone, escalation rules, or scheduling preferences..."
            value={schedulingPrompt}
            onChange={e => setSchedulingPrompt(e.target.value)}
            disabled={agentSettingsLoading || agentSettingsSaving}
          />
          <label className="text-sm font-medium text-gray-800" htmlFor="information-instructions">
            Information agent instructions
          </label>
          <textarea
            id="information-instructions"
            className="bg-white text-black w-full border border-gray-200 rounded-lg p-2 h-28"
            placeholder="Add product details, brand voice, or escalation guidance..."
            value={informationPrompt}
            onChange={e => setInformationPrompt(e.target.value)}
            disabled={agentSettingsLoading || agentSettingsSaving}
          />
          {agentSettingsError && (
            <p className="text-sm text-red-600">Agent instructions error: {agentSettingsError}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleSaveAgentSettings}
              disabled={agentSettingsSaving}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-all disabled:opacity-60"
            >
              {agentSettingsSaving ? "Saving..." : "Save instructions"}
            </button>
            <button
              onClick={refreshAgentSettings}
              disabled={agentSettingsLoading}
              className="bg-gray-100 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-200 transition-all disabled:opacity-60"
            >
              {agentSettingsLoading ? "Refreshing..." : "Reload saved"}
            </button>
          </div>
        </div>
      )}

      {user && (
        <div className="w-full max-w-xl border border-gray-200 rounded-xl p-4 flex flex-col gap-3 bg-white text-black">
          <h2 className="text-lg font-semibold">Chat History</h2>
          {messages.length === 0 ? (
            <p className="text-sm text-gray-600">Start the conversation below to see it here.</p>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 w-full overflow-y-auto">
              {messages.map((msg, idx) => (
                <div
                  key={`${msg.role}-${msg.createdAt}-${idx}`}
                  className={`border border-gray-200 rounded-lg p-3 text-sm whitespace-pre-wrap ${
                    msg.role === "assistant" ? "bg-blue-50 text-blue-900" : "bg-gray-50 text-gray-900"
                  }`}
                >
                  <div className="font-semibold mb-1">
                    {msg.role === "assistant" ? "Agent" : "You"}
                  </div>
                  <div>{msg.text}</div>
                  <div className="text-xs text-gray-500 mt-2">
                    {new Date(msg.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {user && (
        <div className="w-full max-w-xl border border-gray-200 rounded-xl p-4 flex flex-col gap-3 bg-white text-black">
          <h2 className="text-lg font-semibold">Knowledge Base</h2>
          <p className="text-sm text-gray-600">
            Add PDFs or plain text so the agent can answer with your business-specific details.
          </p>
          <textarea
            className="bg-white text-black w-full border border-gray-200 rounded-lg p-2 h-32"
            placeholder="Paste FAQs, policies, or other reference text..."
            value={knowledgeText}
            onChange={e => setKnowledgeText(e.target.value)}
          />
          <input
            type="file"
            accept=".pdf,.txt,.md"
            onChange={e => setKnowledgeFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={handleKnowledgeUpload}
              disabled={knowledgeUploading}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-all disabled:opacity-60"
            >
              {knowledgeUploading ? "Uploading..." : "Upload knowledge"}
            </button>
            <button
              onClick={() => refreshKnowledge({ refresh: true })}
              disabled={knowledgeLoading}
              className="bg-gray-100 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-200 transition-all disabled:opacity-60"
            >
              {knowledgeLoading ? "Refreshing..." : "Refresh status"}
            </button>
          </div>
          {knowledgeError && (
            <p className="text-sm text-red-600">Knowledge error: {knowledgeError}</p>
          )}
          {knowledge && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-gray-500">
                Vector store: {knowledge.vectorStoreId} (updated {new Date(knowledge.updatedAt).toLocaleString()})
              </p>
              {knowledge.files.length === 0 ? (
                <p className="text-sm text-gray-600">No knowledge uploaded yet.</p>
              ) : (
                <ul className="text-sm text-gray-800 border border-gray-200 rounded-lg divide-y divide-gray-200">
                  {knowledge.files.map(file => (
                    <li key={file.id} className="p-2 flex flex-col gap-1">
                      <span className="font-medium">{file.filename}</span>
                      <span className="text-xs text-gray-500">
                        {Math.round(file.bytes / 1024)} KB · {file.status}
                        {file.last_processed_at ? ` · processed ${new Date(file.last_processed_at).toLocaleString()}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <textarea
        className="bg-white text-black w-full max-w-xl h-32 border border-gray-200 rounded-lg p-2"
        onChange={e => setMessage(e.target.value)}
        value={message}
        placeholder="Ask the agent..."
      />
      <button
        onClick={callthis}
        disabled={loading}
        className="bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700 transition-all disabled:opacity-60"
      >
        {loading ? "Thinking..." : "Ask AI"}
      </button>

      {response && (
        <div className="bg-gray-100 text-gray-800 p-4 rounded-lg mt-4 max-w-lg text-sm whitespace-pre-wrap">
          {response}
        </div>
      )}
    </div>
  );
}