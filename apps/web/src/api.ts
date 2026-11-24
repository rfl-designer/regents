import type {
  AgentDto,
  ApiError,
  ChannelDto,
  ChannelSettingsDto,
  CreateAgentInput,
  CreateChannelInput,
  ExecutionDto,
  MeDto,
  MemberSummaryDto,
  MessageDto,
  SendMessageInput,
  UpdateChannelSettingsInput,
  WorkspaceKeyDto,
} from "@shearim/contracts";

/** Falha de uma chamada à API, já com o que a tela precisa para explicar. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

/** O servidor não respondeu (Tailscale desligado, servidor fora do ar). */
export class Offline extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new Offline();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiFailure(res.status, body);
  }
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => call<MeDto>("/api/me"),
  members: () => call<MemberSummaryDto[]>("/api/members"),
  channels: () => call<ChannelDto[]>("/api/channels"),
  channel: (channelId: string) => call<ChannelDto>(`/api/channels/${channelId}`),
  createChannel: (input: CreateChannelInput) => call<ChannelDto>("/api/channels", json("POST", input)),
  joinChannel: (channelId: string) => call<ChannelDto>(`/api/channels/${channelId}/join`, json("POST")),
  addParticipant: (channelId: string, memberId: string) =>
    call<ChannelDto>(`/api/channels/${channelId}/participants`, json("POST", { memberId })),
  channelSettings: () => call<ChannelSettingsDto[]>("/api/channel-settings"),
  updateChannelSettings: (channelId: string, input: UpdateChannelSettingsInput) =>
    call<ChannelSettingsDto>(`/api/channel-settings/${channelId}`, json("PATCH", input)),
  messages: (channelId: string) => call<MessageDto[]>(`/api/channels/${channelId}/messages`),
  send: (channelId: string, input: SendMessageInput) =>
    call<MessageDto>(`/api/channels/${channelId}/messages`, json("POST", input)),
  executions: (channelId: string) => call<ExecutionDto[]>(`/api/channels/${channelId}/executions`),
  agents: () => call<AgentDto[]>("/api/agents"),
  createAgent: (input: CreateAgentInput) => call<AgentDto>("/api/agents", json("POST", input)),
  addAgent: (channelId: string, agentId: string) =>
    call<ChannelDto>(`/api/channels/${channelId}/agents`, json("POST", { agentId })),
  workspaceKey: () => call<WorkspaceKeyDto>("/api/workspace-key"),
  setWorkspaceKey: (apiKey: string) => call<WorkspaceKeyDto>("/api/workspace-key", json("PUT", { apiKey })),
};
