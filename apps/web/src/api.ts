import type {
  AccountDto,
  AgentDto,
  ApiError,
  ApproveJoinRequestDto,
  ChannelDto,
  ChannelSettingsDto,
  CreateAgentInput,
  CreateChannelInput,
  DeviceDto,
  DmDto,
  ExecutionDto,
  FollowedThreadDto,
  JoinRequestAdminDto,
  JoinRequestDto,
  MeDto,
  MemberRole,
  MemberSummaryDto,
  MessageDto,
  MyJoinRequestDto,
  OutcomeDto,
  PushKeyDto,
  PushSubscriptionInput,
  SendMessageInput,
  SetPresenceInput,
  SubmitAccountCodeInput,
  UnreadDto,
  UnreadMessagesDto,
  UpdateAgentInput,
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const post = { method: "POST" } as const;

export const api = {
  pushKey: () => call<PushKeyDto>("/api/push/key"),
  putPushSubscription: (deviceId: string, input: PushSubscriptionInput) =>
    call<void>(`/api/push/subscriptions/${deviceId}`, json("PUT", input)),
  devices: () => call<DeviceDto[]>("/api/devices"),
  removeDevice: (id: string) => call<void>(`/api/devices/${id}`, { method: "DELETE" }),
  setPresence: (input: SetPresenceInput) => call<void>("/api/presence", json("PUT", input)),
  me: () => call<MeDto>("/api/me"),
  updateProfile: (input: UpdateProfileInput) => call<MeDto>("/api/me", json("PATCH", input)),
  members: () => call<MemberSummaryDto[]>("/api/members"),
  /** Só Admin: torna Admin ou rebaixa (o último Admin não: 409 `last_admin`). */
  setMemberRole: (memberId: string, role: MemberRole) =>
    call<MemberSummaryDto>(`/api/members/${memberId}`, json("PATCH", { role })),
  /** Só Admin: remove o Membro do Workspace. */
  removeMember: (memberId: string) => call<void>(`/api/members/${memberId}`, { method: "DELETE" }),
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
  /** Abre a DM de quem chama com esse Agente, ou devolve a que já existe. */
  openAgentDm: (agentId: string) => call<DmDto>("/api/dms", json("POST", { memberIds: [], agentId })),
  /** Mensagens de qualquer conversa (Canal ou DM). */
  messages: (conversationId: string) => call<MessageDto[]>(`/api/conversations/${conversationId}/messages`),
  send: (conversationId: string, input: SendMessageInput) =>
    call<MessageDto>(`/api/conversations/${conversationId}/messages`, json("POST", input)),
  /** As Threads que quem pede segue (de todas as conversas). */
  followedThreads: () => call<FollowedThreadDto[]>("/api/threads/followed"),
  /** As não-lidas de quem pede, em todas as conversas dele. */
  unread: () => call<UnreadDto>("/api/unread"),
  /** As não-lidas numa conversa, na ordem de exibição (a primeira é onde ela abre). */
  conversationUnread: (conversationId: string) =>
    call<UnreadMessagesDto>(`/api/conversations/${conversationId}/unread`),
  /** Marca o que apareceu na tela. */
  markRead: (conversationId: string, messageIds: string[]) =>
    call<UnreadDto>(`/api/conversations/${conversationId}/reads`, json("POST", { messageIds })),
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
  /** "Tentar de novo" de uma falha (só quem escreveu a mensagem). */
  retryExecution: (conversationId: string, executionId: string) =>
    call<ExecutionDto>(`/api/conversations/${conversationId}/executions/${executionId}/retry`, post),
  /** Cancela o que a mensagem ainda tem em andamento (só quem escreveu). */
  cancelMessage: (conversationId: string, messageId: string) =>
    call<ExecutionDto[]>(`/api/conversations/${conversationId}/messages/${messageId}/cancel`, post),
  /** Os Desfechos da Articuladora numa conversa (uma DM não tem). */
  outcomes: (conversationId: string) => call<OutcomeDto[]>(`/api/conversations/${conversationId}/outcomes`),
  updateAgent: (agentId: string, input: UpdateAgentInput) =>
    call<AgentDto>(`/api/agents/${agentId}`, json("PATCH", input)),
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
