import type {
  AccountDto,
  AgentDto,
  ApiError,
  ApproveJoinRequestDto,
  ChannelDto,
  ChannelSettingsDto,
  CreateAgentInput,
  CreateChannelInput,
  DmDto,
  ExecutionDto,
  JoinRequestAdminDto,
  JoinRequestDto,
  MeDto,
  MemberSummaryDto,
  MessageDto,
  MyJoinRequestDto,
  SendMessageInput,
  SubmitAccountCodeInput,
  UpdateChannelSettingsInput,
  UpdateProfileInput,
  WorkspaceContextDto,
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

const post = { method: "POST" } as const;

export const api = {
  me: () => call<MeDto>("/api/me"),
  updateProfile: (input: UpdateProfileInput) => call<MeDto>("/api/me", json("PATCH", input)),
  members: () => call<MemberSummaryDto[]>("/api/members"),
  myJoinRequest: () => call<MyJoinRequestDto>("/api/join-request"),
  requestToJoin: () => call<JoinRequestDto>("/api/join-request", post),
  joinRequests: () => call<JoinRequestAdminDto[]>("/api/join-requests"),
  approve: (id: string) => call<ApproveJoinRequestDto>(`/api/join-requests/${id}/approve`, post),
  refuse: (id: string) => call<JoinRequestAdminDto>(`/api/join-requests/${id}/refuse`, post),
  channels: () => call<ChannelDto[]>("/api/channels"),
  channel: (channelId: string) => call<ChannelDto>(`/api/channels/${channelId}`),
  createChannel: (input: CreateChannelInput) => call<ChannelDto>("/api/channels", json("POST", input)),
  joinChannel: (channelId: string) => call<ChannelDto>(`/api/channels/${channelId}/join`, json("POST")),
  addParticipant: (channelId: string, memberId: string) =>
    call<ChannelDto>(`/api/channels/${channelId}/participants`, json("POST", { memberId })),
  channelSettings: () => call<ChannelSettingsDto[]>("/api/channel-settings"),
  updateChannelSettings: (channelId: string, input: UpdateChannelSettingsInput) =>
    call<ChannelSettingsDto>(`/api/channel-settings/${channelId}`, json("PATCH", input)),
  dms: () => call<DmDto[]>("/api/dms"),
  /** Abre a DM com essas pessoas, ou devolve a que já existe com elas. */
  openDm: (memberIds: string[]) => call<DmDto>("/api/dms", json("POST", { memberIds })),
  /** Mensagens de qualquer conversa (Canal ou DM). */
  messages: (conversationId: string) => call<MessageDto[]>(`/api/conversations/${conversationId}/messages`),
  send: (conversationId: string, input: SendMessageInput) =>
    call<MessageDto>(`/api/conversations/${conversationId}/messages`, json("POST", input)),
  account: {
    get: () => call<AccountDto>("/api/account"),
    notNow: () => call<AccountDto>("/api/account/not-now", post),
    startLinking: () => call<AccountDto>("/api/account/linking", post),
    submitCode: (input: SubmitAccountCodeInput) => call<AccountDto>("/api/account/linking/code", json("POST", input)),
    confirm: () => call<AccountDto>("/api/account/linking/confirm", post),
    cancelLinking: () => call<AccountDto>("/api/account/linking", { method: "DELETE" }),
    unlink: () => call<AccountDto>("/api/account", { method: "DELETE" }),
  },
  /** O Andamento do que ainda não virou resposta numa conversa. */
  executions: (conversationId: string) => call<ExecutionDto[]>(`/api/conversations/${conversationId}/executions`),
  agents: () => call<AgentDto[]>("/api/agents"),
  createAgent: (input: CreateAgentInput) => call<AgentDto>("/api/agents", json("POST", input)),
  addAgent: (channelId: string, agentId: string) =>
    call<ChannelDto>(`/api/channels/${channelId}/agents`, json("POST", { agentId })),
  workspaceContext: () => call<WorkspaceContextDto>("/api/workspace-context"),
  setWorkspaceContext: (context: string) =>
    call<WorkspaceContextDto>("/api/workspace-context", json("PUT", { context })),
  workspaceKey: () => call<WorkspaceKeyDto>("/api/workspace-key"),
  setWorkspaceKey: (apiKey: string) => call<WorkspaceKeyDto>("/api/workspace-key", json("PUT", { apiKey })),
};
